import Big from 'big.js';
import { DateTime } from 'luxon';
import { waDb, ownedAccounts, parse, symbolKey } from '../whatsapp/store.js';
import { calendarTradeFees, reportedNetResult } from './calendar-trade-fees.js';

const zone='Asia/Dubai';
const number=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value):null;
const plus=(a,b)=>new Big(a || 0).plus(b || 0).toFixed();
const dayKey=at=>DateTime.fromMillis(at,{zone}).toISODate();
const orderKey=e=>[e.account_id,symbolKey(e.data.symbol),e.data.orderId || e.id].join('|');
export function calendarMonth(month) {
 if(typeof month!=='string'||!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid calendar month');
 const start=DateTime.fromISO(month+'-01',{zone});
 if(!start.isValid||start.year<2000||start.year>2100)throw Error('Invalid calendar month');
 return {month,start:start.toMillis(),end:start.plus({months:1}).toMillis(),days:start.daysInMonth};
}

// Reporting only: no exchange calls or order/strategy writes. Entries count once
// per order, while realized PnL belongs to the day of the closing fills.
export function summarizeTradeCalendar({events,accounts,month,accountId='',at=Date.now()}) {
 const range=calendarMonth(month),names=Object.fromEntries(accounts.map(a=>[a.id,a.name]));
 const rows=events.filter(e=>Object.hasOwn(names,e.account_id)&&(!accountId||e.account_id===accountId)&&e.occurred_at<=at&&!['sample','test','report'].includes(e.source)&&!['test','report'].includes(e.kind)).sort((a,b)=>a.occurred_at-b.occurred_at);
 const tradeFees=calendarTradeFees(rows);
 const entries=new Map(),exits=new Map(),feeRows=[],seenFills=new Set(),feeCoverage=new Set(),missingFees=[];
 const authoritative=new Set(rows.filter(e=>e.kind==='pnl_updated'&&e.data.pnlSource!=='fill'&&number(e.data.pnl)!==null&&e.data.currency).map(orderKey));
 const netReportedAccounts=new Set(rows.filter(e=>e.kind==='pnl_updated'&&e.data.pnlIncludesFees===true).map(e=>e.account_id));
 const view=e=>({id:orderKey(e),at:e.occurred_at,accountId:e.account_id,account:names[e.account_id],setupId:e.setup_id || null,setupName:e.data.setupName || 'Exchange trade',symbol:symbolKey(e.data.symbol),side:e.data.side || null,orderId:String(e.data.orderId || ''),network:e.data.network || accounts.find(a=>a.id===e.account_id)?.network,price:number(e.data.price),quantity:number(e.data.quantity),margin:number(e.data.margin),leverage:number(e.data.leverage)});
 for(const e of rows) {
  const d=e.data,key=orderKey(e);
  const fillIdentity=d.fillId!=null?key+'|'+d.fillId:e.id;
  if(e.kind==='trade_filled') {
   if(seenFills.has(fillIdentity))continue;
   seenFills.add(fillIdentity);
   if(number(d.fees)!==null&&d.feeCurrency){feeRows.push({at:e.occurred_at,currency:d.feeCurrency,amount:String(d.fees),accountId:e.account_id,key});feeCoverage.add(key);}
   else if(e.source==='exchange')missingFees.push({at:e.occurred_at,accountId:e.account_id,currency:d.currency || (/USDC$/.test(symbolKey(d.symbol))?'USDC':/USDT$/.test(symbolKey(d.symbol))?'USDT':'Unknown')});
  }
  if((e.kind==='trade_filled'&&d.role==='entry'&&number(d.quantity)>0)||(e.kind==='order_accepted'&&d.status==='closed'&&number(d.quantity)>0)) {
   const prior=entries.get(key),exchangeFill=e.kind==='trade_filled'&&e.source==='exchange';
   if(!prior)entries.set(key,{...view(e),exchangeFill});
   else if(exchangeFill) {
    // Exchange partial fills replace the app's full-order confirmation, then add.
    const qty=prior.exchangeFill?plus(prior.quantity,d.quantity):String(d.quantity);
    const weighted=prior.exchangeFill&&number(prior.price)!==null&&number(d.price)!==null?new Big(prior.price).times(prior.quantity).plus(new Big(d.price).times(d.quantity)).div(qty).toNumber():number(d.price);
    entries.set(key,{...prior,at:prior.exchangeFill?prior.at:e.occurred_at,quantity:Number(qty),price:weighted,exchangeFill:true});
   }
  }
  const reported=e.kind==='pnl_updated'&&d.pnlSource!=='fill';
  const filled=e.kind==='trade_filled'&&d.pnlSource==='fill'&&!authoritative.has(key);
  if((reported||filled)&&number(d.pnl)!==null&&d.currency&&(reported||Number(d.pnl)!==0||['tp','sl','exit'].includes(d.role))) {
   const basis=d.pnlIncludesFees?'net':'gross';
   const closeKey=key+'|'+d.currency+(reported?'|reported':'|'+dayKey(e.occurred_at));
   const prior=exits.get(closeKey);
   const qty=reported?number(d.quantity):Number(plus(prior?.quantity,d.quantity));
   const price=!reported&&prior&&number(prior.price)!==null&&number(d.price)!==null&&qty>0?new Big(prior.price).times(prior.quantity || 0).plus(new Big(d.price).times(d.quantity || 0)).div(qty).toNumber():number(d.price);
   exits.set(closeKey,{...view(e),id:closeKey,at:prior?.at || e.occurred_at,pnl:reported?String(d.pnl):plus(prior?.pnl,d.pnl),currency:d.currency,basis,quantity:qty,price,role:d.role || 'exit'});
  }
 }
 const days=Array.from({length:range.days},(_,i)=>({date:month+'-'+String(i+1).padStart(2,'0'),opened:0,closed:0,wins:0,losses:0,breakeven:0,totals:[],fees:[],net:[],entries:[],exits:[]}));
 const byDay=Object.fromEntries(days.map(d=>[d.date,d]));
 for(const [entryKey,entry] of entries) {const day=byDay[dayKey(entry.at)];if(day){const {exchangeFill,...safe}=entry;safe.result=netReportedAccounts.has(entry.accountId)?null:tradeFees.byEntry.get(entryKey)||null;day.entries.push(safe);day.opened++;}}
 for(const exit of exits.values()) {const day=byDay[dayKey(exit.at)];if(day){exit.result=exit.basis==='net'?reportedNetResult(exit):tradeFees.closes.get(exit.id)||null;day.exits.push(exit);day.closed++;day[Number(exit.pnl)>0?'wins':Number(exit.pnl)<0?'losses':'breakeven']++;}}
 for(const f of feeRows){const day=byDay[dayKey(f.at)];if(day){let fee=day.fees.find(p=>p.currency===f.currency);if(!fee){fee={currency:f.currency,amount:'0'};day.fees.push(fee);}fee.amount=plus(fee.amount,f.amount);}}
 const accumulate=(totals,row)=>{
  let total=totals.find(p=>p.currency===row.currency&&p.basis===row.basis);
  if(!total){total={currency:row.currency,basis:row.basis,profit:'0',loss:'0',pnl:'0'};totals.push(total);}
  if(Number(row.pnl)>0)total.profit=plus(total.profit,row.pnl);
  if(Number(row.pnl)<0)total.loss=plus(total.loss,new Big(row.pnl).abs());
  total.pnl=plus(total.pnl,row.pnl);
 };
 const summary={opened:0,closed:0,wins:0,losses:0,breakeven:0,totals:[],fees:[],net:[]};
 for(const day of days){for(const exit of day.exits){accumulate(day.totals,exit);accumulate(summary.totals,exit);}for(const k of ['opened','closed','wins','losses','breakeven'])summary[k]+=day[k];for(const fee of day.fees){let total=summary.fees.find(p=>p.currency===fee.currency);if(!total){total={currency:fee.currency,amount:'0'};summary.fees.push(total);}total.amount=plus(total.amount,fee.amount);}day.entries.sort((a,b)=>b.at-a.at);day.exits.sort((a,b)=>b.at-a.at);}
 // Daily net is a cash-flow view of recorded realized PnL minus trading fees
 // charged that day, including entry fees on positions that are still open.
 // Exchange-reported net already includes fees; never subtract them again.
 const bases=new Map();
 for(const exit of exits.values()){const set=bases.get(exit.accountId)||new Set();set.add(exit.basis);bases.set(exit.accountId,set);}
 const netMode=account=>bases.get(account)?.has('net')&&!bases.get(account)?.has('gross');
 const mixedMode=account=>bases.get(account)?.has('net')&&bases.get(account)?.has('gross');
 const netRow=(day,currency)=>{let r=day.net.find(n=>n.currency===currency);if(!r){r={currency,amount:'0',knownAmount:'0',feesDeducted:'0',pendingFees:false};day.net.push(r);}return r;};
 const updateNet=(at,currency,value,pending=false,fee='0')=>{const day=byDay[dayKey(at)];if(!day)return;const r=netRow(day,currency);r.knownAmount=plus(r.knownAmount,value);r.feesDeducted=plus(r.feesDeducted,fee);r.pendingFees ||= pending;r.amount=r.pendingFees?null:r.knownAmount;};
 for(const exit of exits.values())updateNet(exit.at,exit.currency,exit.pnl,mixedMode(exit.accountId));
 for(const fee of feeRows)if(!netMode(fee.accountId))updateNet(fee.at,fee.currency,new Big(fee.amount).neg().toFixed(),mixedMode(fee.accountId),fee.amount);
 for(const missing of missingFees)if(!netMode(missing.accountId))updateNet(missing.at,missing.currency,'0',true);
 for(const [key,entry] of entries)if(!feeCoverage.has(key)&&!netMode(entry.accountId))updateNet(entry.at,/USDC$/.test(entry.symbol)?'USDC':/USDT$/.test(entry.symbol)?'USDT':'Unknown','0',true);
 for(const day of days)for(const row of day.net){let total=summary.net.find(r=>r.currency===row.currency);if(!total){total={currency:row.currency,amount:'0',knownAmount:'0',feesDeducted:'0',pendingFees:false};summary.net.push(total);}total.knownAmount=plus(total.knownAmount,row.knownAmount);total.feesDeducted=plus(total.feesDeducted,row.feesDeducted);total.pendingFees ||= row.pendingFees;total.amount=total.pendingFees?null:total.knownAmount;}
 return {at,month,timezone:zone,accountId,summary,days,accountOptions:accounts.map(a=>({id:a.id,name:a.name,network:a.network})),firstEventAt:rows[0]?.occurred_at || null};
}

export async function tradeCalendarSnapshot(userId,{month=DateTime.now().setZone(zone).toFormat('yyyy-MM'),accountId=''}={}) {
 calendarMonth(month);
 const accounts=await ownedAccounts(userId);
 if(accountId&&!accounts.some(a=>a.id===accountId))throw Error('Account not found');
 const at=Date.now();
 // Read complete recorded history so orders spanning month boundaries and later
 // net corrections cannot be double-counted as a new entry/result.
 const events=waDb.prepare("SELECT id,kind,account_id,setup_id,source,data_json,occurred_at FROM jarvis_trade_events WHERE user_id=? AND occurred_at<=? AND kind IN ('order_accepted','trade_filled','pnl_updated','trade_closed') ORDER BY occurred_at,rowid").all(userId,at).map(e=>({...e,data:parse(e.data_json)}));
 return summarizeTradeCalendar({events,accounts,month,accountId,at});
}
