import Big from 'big.js';
import { EVENT_LABELS, settings, waDb, parse, now, json } from './store.js';
import { DateTime } from 'luxon';
export const FIELDS=['title','setupName','account','network','symbol','side','margin','leverage','price','quantity','takeProfit','stopLoss','pnl','orderId','repeatProgress','time','summary','error','status','source','fees','condition','currentValue','triggerSymbol','timeframe'];
export function fields(event,zone) {
 const d=event.data || {};
 return {title:EVENT_LABELS[event.kind] || event.kind,setupName:d.setupName || 'Exchange trade',account:d.account || d.accountId || '—',network:d.network || '—',symbol:d.symbol || '—',side:String(d.side || '—').toUpperCase(),margin:d.margin === undefined ? '—' : '$'+d.margin,leverage:d.leverage ? d.leverage+'x' : '—',price:d.price || '—',quantity:d.quantity || '—',takeProfit:d.takeProfit || '—',stopLoss:d.stopLoss || '—',pnl:d.pnlSummary || (d.pnl === null || d.pnl === undefined ? 'Pending / unavailable' : String(d.pnl)+' '+(d.currency || 'USDT')),orderId:d.orderId || '—',repeatProgress:d.repeatProgress || '—',time:DateTime.fromMillis(event.occurred_at || now(),{zone}).toFormat('dd LLL yyyy HH:mm:ss ZZZZ'),summary:d.summary || '',error:d.error || '',status:d.status || event.kind,source:event.source || 'app',fees:d.fees ?? '—',condition:d.condition || '—',currentValue:typeof d.currentValue==='number'?d.currentValue.toLocaleString('en-US',{maximumFractionDigits:4}):d.currentValue ?? '—',triggerSymbol:d.triggerSymbol || '—',timeframe:d.timeframe || '—'};
}
export function renderTemplate(template,event,zone) {
 const values=fields(event,zone);
 return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g,(_,key)=>String(values[key] ?? '')).replace(/\n{3,}/g,'\n\n').trim();
}
export const sampleEvent = kind => {
 const exit=['pnl_updated','take_profit_hit','stop_loss_hit','trade_closed'].includes(kind),loss=kind==='stop_loss_hit';
 return {kind,source:'sample',occurred_at:now(),data:{setupName:'BTC Price Movement - SAMPLE',account:'Sample Binance Account',network:'testnet',symbol:'BTCUSDT',side:'long',margin:'100',leverage:'10',price:exit?(loss?'49750':'50500'):'50000',entryPrice:'50000',exitPrice:exit?(loss?'49750':'50500'):undefined,quantity:'0.020',takeProfit:'50500 price',stopLoss:'49750 price',pnl:exit?(loss?'-5':'10'):null,totalFees:exit?'1':undefined,feesComplete:exit,positionClosed:exit,role:exit?(loss?'sl':'tp'):'entry',status:'closed',currency:'USDT',orderId:'SAMPLE-ORDER-01',repeatProgress:'1/4',triggerSymbol:'BTCUSDT',timeframe:'1m',condition:'Price moves above the saved reference',currentValue:50000,summary:'SAMPLE DATA - no trade executed by this preview'}};
};
export function snapshotReport(userId,start,end,accountIds=[]) {
 const rows=waDb.prepare('SELECT kind,account_id,data_json FROM jarvis_trade_events WHERE user_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at').all(userId,start,end).filter(r=>!accountIds.length || accountIds.includes(r.account_id));
 let gross=new Big(0), fees=new Big(0), known=0;
 const breakdown={}, feeCurrencies={};
 for (const row of rows) {
  const d=parse(row.data_json);
  if ((row.kind==='trade_filled' && d.pnlSource==='fill') || (row.kind==='pnl_updated' && d.pnlSource!=='fill')) {
   if(d.pnl !== undefined && d.pnl !== null && d.currency) { const amount=d.deltaPnl ?? d.pnl;if(d.currency==='USDT' && !d.pnlIncludesFees)gross=gross.plus(amount);const key=(d.account || row.account_id)+' · '+d.currency+(d.pnlIncludesFees?' (net, exchange reported)':' (gross)');breakdown[key]=new Big(breakdown[key] || 0).plus(amount).toFixed();known++; }
  }
  if(row.kind==='trade_filled' && d.fees !== undefined && d.feeCurrency){feeCurrencies[d.feeCurrency]=new Big(feeCurrencies[d.feeCurrency] || 0).plus(d.fees).toFixed();fees=d.feeCurrency==='USDT'?fees.plus(d.fees):fees;}
 }
 const positions=Object.entries(parse(waDb.prepare("SELECT data_json FROM jarvis_wa_runtime WHERE key=?").get('positions:'+userId)?.data_json || '{}')).filter(([key])=>!accountIds.length || accountIds.some(id=>key.startsWith(id+':'))).filter(([,p])=>Number(p.contracts)>0);
 return {fills:rows.filter(r=>r.kind==='trade_filled').length,accepted:rows.filter(r=>r.kind==='order_accepted').length,failed:rows.filter(r=>r.kind==='order_failed').length,closed:rows.filter(r=>r.kind==='trade_closed').length,open:positions.length,known,gross:gross.toFixed(4),fees:fees.toFixed(4),breakdown,feeCurrencies,trackedSince:settings(userId).trackingSince || null};
}
export function reportEvent(userId,start,end,accountIds=[]) {
 const s=settings(userId), stats=snapshotReport(userId,start,end,accountIds);
 const format=t=>DateTime.fromMillis(t,{zone:s.timezone}).toFormat('dd LLL HH:mm');
 return {kind:'report',source:'report',occurred_at:now(),data:{reportStart:start,reportEnd:end,setupName:'Trading summary',account:accountIds.length ? 'Selected accounts' : 'All selected accounts',summary:`Period: ${format(start)} – ${format(end)}\nOrders accepted: ${stats.accepted}\nConfirmed fills: ${stats.fills}\nPositions closed: ${stats.closed}\nOpen positions tracked: ${stats.open}\nFailures: ${stats.failed}\nConfirmed realized PnL by account:\n${Object.entries(stats.breakdown).map(([key,value])=>key+': '+value).join('\n') || 'Pending / unavailable'}\nObserved trade fees:\n${Object.entries(stats.feeCurrencies).map(([currency,value])=>value+' '+currency).join('\n') || 'No confirmed fees yet'}\nBinance PnL is gross; Bybit closed PnL is exchange-reported net. Funding fees excluded.\nCoverage starts when tracking is enabled.`,pnl:null,pnlSummary:stats.known?'See account breakdown in summary':'Pending / unavailable'}};
}

