import Big from 'big.js';
import {waDb,parse,symbolKey} from './store.js';

const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const sum=values=>values.reduce((total,value)=>total.plus(value),new Big(0));
const same=(a,b)=>symbolKey(a)===symbolKey(b);
const tolerance=v=>Math.max(0.000001,Math.abs(Number(v))*0.000001);
function previousFlat(event) {
 return waDb.prepare("SELECT id,data_json,occurred_at FROM jarvis_trade_events WHERE user_id=? AND account_id=? AND kind='trade_closed' AND occurred_at<? ORDER BY occurred_at DESC")
  .all(event.user_id,event.account_id,event.occurred_at).find(row=>same(parse(row.data_json).symbol,event.data.symbol))?.occurred_at || 0;
}

// A position poll proves flatness, not its exit price or realized PnL. Only
// exchange fills from this position cycle may supply the notification result.
export function resolveTradeResult(event) {
 const d=event.data || {};
 if(event.source!=='exchange'||!['trade_closed','take_profit_hit','stop_loss_hit','pnl_updated'].includes(event.kind)||d.pnlIncludesFees)return {event,ready:true};
 if(!event.account_id||!d.symbol)return {event,ready:true};
 const end=event.occurred_at,start=previousFlat(event);
 const rows=waDb.prepare("SELECT id,data_json,occurred_at FROM jarvis_trade_events WHERE user_id=? AND account_id=? AND kind='trade_filled' AND source='exchange' AND occurred_at>? AND occurred_at<=? ORDER BY occurred_at,rowid")
  .all(event.user_id,event.account_id,start,end).map(r=>({...r,data:parse(r.data_json)})).filter(r=>same(r.data.symbol,d.symbol));
 const unique=new Map();for(const r of rows)unique.set([r.data.orderId,r.data.fillId || r.id].join(':'),r);
 let fills=[...unique.values()],side=String(d.side || '').toLowerCase();
 // Old unreferenced fill events used BUY/SELL; infer position direction from
// their closing transaction, never from a historical order reference.
 if(!['long','short'].includes(side)) {
  const last=fills.findLast(r=>String(r.data.orderId)===String(d.orderId));
  const transaction=last?.data.fillSide || last?.data.side;
  if(transaction==='buy')side='short';else if(transaction==='sell')side='long';
 }
 const pending=reason=>({event:{...event,data:{...d,resultPendingReason:reason}},ready:false,reason});
 if(!['long','short'].includes(side))return pending('Waiting for the exchange position direction.');
 fills=fills.filter(r=>!r.data.positionSide||r.data.positionSide==='BOTH'||r.data.positionSide===side.toUpperCase());
 const transaction=r=>r.data.fillSide || (r.data.side==='long'?(['tp','sl','exit'].includes(r.data.role)?'sell':'buy'):r.data.side==='short'?(['tp','sl','exit'].includes(r.data.role)?'buy':'sell'):r.data.side);
 const entrySide=side==='long'?'buy':'sell',entries=fills.filter(r=>transaction(r)===entrySide),exits=fills.filter(r=>transaction(r)!==entrySide&&['buy','sell'].includes(transaction(r)));
 if(!entries.length||!exits.length||[...entries,...exits].some(r=>number(r.data.quantity)===null||Number(r.data.quantity)<=0||number(r.data.price)===null))return pending('Waiting for complete exchange entry and exit fills.');
 const entryQty=sum(entries.map(r=>r.data.quantity)),exitQty=sum(exits.map(r=>r.data.quantity));
 if(exitQty.gt(entryQty)||event.kind==='trade_closed'&&entryQty.minus(exitQty).abs().gt('0.000000001'))return pending('Waiting for all fills of this closed position.');
 const entryPrice=sum(entries.map(r=>new Big(r.data.price).times(r.data.quantity))).div(entryQty),exitPrice=sum(exits.map(r=>new Big(r.data.price).times(r.data.quantity))).div(exitQty);
 const grossKnown=exits.every(r=>number(r.data.pnl)!==null&&!r.data.pnlIncludesFees&&r.data.currency==='USDT');
 if(!grossKnown)return pending('Waiting for exchange-confirmed realized PnL.');
 const gross=sum(exits.map(r=>r.data.pnl)),entryOrders=[...new Set(entries.map(r=>String(r.data.orderId)))];
 const singleEntry=entryOrders.length===1&&entries.every(r=>r.occurred_at<=exits[0].occurred_at);
 const reconciled=singleEntry&&exits.every(r=>new Big(r.data.price).minus(entryPrice).times(r.data.quantity).times(side==='long'?1:-1).minus(r.data.pnl).abs().lte(tolerance(r.data.pnl)));
 if(!reconciled)return pending('Shared, hedged or incomplete entry history; the matching entry cannot be verified.');
 const feesKnown=[...entries,...exits].every(r=>number(r.data.fees)!==null&&r.data.feeCurrency==='USDT');
 const entryFees=feesKnown?sum(entries.map(r=>r.data.fees)).times(exitQty).div(entryQty):null,exitFees=feesKnown?sum(exits.map(r=>r.data.fees)):null,totalFees=feesKnown?entryFees.plus(exitFees):null;
 const entry=entries[0].data,accountMetadata={accountId:d.accountId,account:d.account,network:d.network,exchange:d.exchange};
 // Fill metadata owns the setup. A manually opened position must never inherit
 // the oldest same-symbol setup from the order-reference table.
 const data={...entry,...accountMetadata,symbol:d.symbol,side,orderId:exits.at(-1).data.orderId,entryOrderId:entryOrders[0],exitOrderIds:[...new Set(exits.map(r=>String(r.data.orderId)))],quantity:exitQty.toFixed(),entryPrice:entryPrice.toFixed(),exitPrice:exitPrice.toFixed(),price:exitPrice.toFixed(),pnl:gross.toFixed(),grossPnl:gross.toFixed(),currency:'USDT',entryFees:entryFees?.toFixed(),exitFees:exitFees?.toFixed(),totalFees:totalFees?.toFixed(),feesComplete:feesKnown,feeCurrency:'USDT',netPnl:totalFees?gross.minus(totalFees).toFixed():null,positionClosed:event.kind==='trade_closed',remainingQuantity:entryQty.minus(exitQty).toNumber(),appOrder:!!entry.appOrder,setupId:entry.setupId || null,setupName:entry.setupName || 'Exchange trade',summary:feesKnown?'Realized PnL and entry/exit commissions verified from exchange fills. Funding excluded.':'Realized PnL confirmed; waiting for complete same-currency trading commissions.',resultPendingReason:feesKnown?'':'Waiting for complete entry and exit commissions.'};
 if(feesKnown)data.pnlSummary=`Net ${data.netPnl} USDT · Gross ${data.grossPnl} USDT · Trading fees ${data.totalFees} USDT`;
 return {event:{...event,setup_id:data.setupId,data},ready:feesKnown,reason:data.resultPendingReason};
}

export function positionEntryReference(userId,accountId,symbol,old,at) {
 const event={user_id:userId,account_id:accountId,occurred_at:at,data:{symbol}},start=previousFlat(event);
 const candidates=waDb.prepare("SELECT data_json FROM jarvis_trade_events WHERE user_id=? AND account_id=? AND kind='order_accepted' AND occurred_at>? AND occurred_at<=? ORDER BY occurred_at DESC")
  .all(userId,accountId,start,at).map(r=>parse(r.data_json)).filter(r=>same(r.symbol,symbol)&&r.side===old.side&&number(r.price)!==null&&number(old.entryPrice)!==null&&Math.abs(Number(r.price)-Number(old.entryPrice))<=Math.max(0.000001,Number(old.entryPrice)*0.000001));
 return candidates.length===1?candidates[0]:null;
}
