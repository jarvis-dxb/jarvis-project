import Big from 'big.js';
import { DateTime } from 'luxon';
import { symbolKey } from '../whatsapp/store.js';

const numeric=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const add=(a,b)=>new Big(a || 0).plus(b || 0).toFixed();
const key=e=>[e.account_id,symbolKey(e.data.symbol),e.data.orderId || e.id].join('|');
const day=at=>DateTime.fromMillis(at,{zone:'Asia/Dubai'}).toISODate();
const feesAdd=(fees,currency,amount)=>{let row=fees.find(r=>r.currency===currency);if(!row){row={currency,amount:'0'};fees.push(row);}row.amount=add(row.amount,amount);};
const result=currency=>({currency,grossPnl:'0',netPnl:null,entryFees:[],exitFees:[],totalFees:[],closedQuantity:'0',entryOrderIds:[],status:'pending',reason:'Waiting for complete entry and exit fee records.'});
function finish(r) {
 r.totalFees=[];for(const f of [...r.entryFees,...r.exitFees])feesAdd(r.totalFees,f.currency,f.amount);
 const sameCurrency=r.totalFees.every(f=>f.currency===r.currency);
 if(!sameCurrency){r.complete=false;r.reason='Fees use another currency; a verified conversion is unavailable.';}
 r.status=r.complete?'confirmed':'pending';
 r.netPnl=r.complete?new Big(r.grossPnl).minus(r.totalFees.reduce((sum,f)=>sum.plus(f.amount),new Big(0))).toFixed():null;
 if(r.complete)r.reason='Entry and exit commissions verified from exchange fills.';
 delete r.complete;
 return r;
}

// Attribute entry fees only to an unambiguous, recorded single-entry position.
// A partial close gets the corresponding quantity share of the entry commission.
// No guessed FIFO ownership for merged or hedged positions; those stay pending.
export function calendarTradeFees(rows) {
 const knownEntries=new Map(),pools=new Map(),seen=new Set(),closes=new Map(),byEntry=new Map();
 const entryFillIds=new Set();
 for(const e of rows)if((e.kind==='order_accepted'&&e.data.status==='closed'||e.kind==='trade_filled'&&e.data.role==='entry')&&numeric(e.data.quantity)>0){
  const orderKey=key(e),prior=knownEntries.get(orderKey);
  if(e.kind==='order_accepted'){knownEntries.set(orderKey,e);continue;}
  const identity=orderKey+'|'+(e.data.fillId ?? e.id);if(entryFillIds.has(identity))continue;entryFillIds.add(identity);
  if(prior?.kind==='order_accepted')continue;
  knownEntries.set(orderKey,{...e,data:{...e.data,quantity:add(prior?.data.quantity,e.data.quantity)}});
 }
 for(const e of rows) {
  const d=e.data,poolKey=e.account_id+'|'+symbolKey(d.symbol);
  if(e.kind==='trade_closed'&&d.remainingQuantity===0){pools.delete(poolKey);continue;}
  if(e.kind!=='trade_filled'||e.source!=='exchange'||numeric(d.quantity)<=0)continue;
  const orderKey=key(e),identity=d.fillId!=null?orderKey+'|'+d.fillId:e.id;
  if(seen.has(identity))continue;seen.add(identity);
  const known=knownEntries.get(orderKey),isExitRole=['tp','sl','exit'].includes(d.role);
  let side=String(d.side || known?.data.side || '').toLowerCase();
  if(side==='long')side=isExitRole?'sell':'buy';else if(side==='short')side=isExitRole?'buy':'sell';
  if(!['buy','sell'].includes(side))continue;
  let pool=pools.get(poolKey);
  const isClose=!known&&(isExitRole||numeric(d.pnl)!==null&&Number(d.pnl)!==0||pool&&side!==pool.side);
  const feeKnown=numeric(d.fees)!==null&&!!d.feeCurrency;
  if(!isClose) {
   if(pool&&pool.side!==side){pool.ambiguous=true;continue;}
   if(!pool){pool={side,quantity:'0',cost:'0',fees:[],feeKnown:true,orderKeys:new Set(),ambiguous:false};pools.set(poolKey,pool);}
   pool.quantity=add(pool.quantity,d.quantity);pool.cost=new Big(pool.cost).plus(new Big(d.price || 0).times(d.quantity)).toFixed();pool.feeKnown&&=feeKnown&&numeric(d.price)!==null;
   pool.orderKeys.add(orderKey);if(feeKnown)feesAdd(pool.fees,d.feeCurrency,d.fees);
   continue;
  }
  if(numeric(d.pnl)===null||!d.currency)continue;
  const closeKey=orderKey+'|'+d.currency+'|'+day(e.occurred_at);
  let r=closes.get(closeKey);if(!r){r={...result(d.currency),complete:true};closes.set(closeKey,r);}
  r.grossPnl=add(r.grossPnl,d.pnl);r.closedQuantity=add(r.closedQuantity,d.quantity);
  if(feeKnown)feesAdd(r.exitFees,d.feeCurrency,d.fees);
  let complete=feeKnown,reason=feeKnown?'':'Exit commission is missing.',entryKey=null,allocated=[];
  if(!isExitRole&&Number(d.pnl)===0){complete=false;reason='A zero-PnL fill without an exit reference cannot verify position closure.';}
  if(!pool||pool.side===side||new Big(pool.quantity).lt(d.quantity)) {complete=false;reason='The matching entry quantity is not fully recorded.';pools.delete(poolKey);}
  else {
   const ratio=new Big(d.quantity).div(pool.quantity),average=new Big(pool.cost).div(pool.quantity);
   allocated=pool.fees.map(f=>({currency:f.currency,amount:new Big(f.amount).times(ratio).toFixed()}));
   for(const f of allocated)feesAdd(r.entryFees,f.currency,f.amount);
   if(pool.ambiguous||pool.orderKeys.size!==1){complete=false;reason='Shared or merged position; entry-fee ownership cannot be verified.';}
   else {entryKey=[...pool.orderKeys][0];const entry=knownEntries.get(entryKey);if(entry&&!r.entryOrderIds.includes(String(entry.data.orderId)))r.entryOrderIds.push(String(entry.data.orderId));}
   if(!pool.feeKnown){complete=false;reason='Entry commission or entry price is missing.';}
   if(numeric(d.price)===null){complete=false;reason='Exit fill price is missing.';}
   else {
    const expected=new Big(d.price).minus(average).times(d.quantity).times(pool.side==='buy'?1:-1);
    const tolerance=Math.max(0.000001,Math.abs(Number(d.pnl))*0.000001);
    if(expected.minus(d.pnl).abs().gt(tolerance)){complete=false;reason='Recorded entry price does not reconcile with this exchange closing PnL.';pool.ambiguous=true;}
   }
   const remaining=new Big(pool.quantity).minus(d.quantity);
   for(const f of allocated){const fee=pool.fees.find(x=>x.currency===f.currency);fee.amount=new Big(fee.amount).minus(f.amount).toFixed();}
   pool.quantity=remaining.toFixed();pool.cost=average.times(remaining).toFixed();if(remaining.eq(0))pools.delete(poolKey);
  }
  r.complete&&=complete;if(!complete)r.reason=reason;
  if(entryKey){let er=byEntry.get(entryKey);if(!er){er={...result(d.currency),complete:true};byEntry.set(entryKey,er);}er.grossPnl=add(er.grossPnl,d.pnl);er.closedQuantity=add(er.closedQuantity,d.quantity);er.complete&&=complete;if(!complete)er.reason=reason;for(const f of allocated)feesAdd(er.entryFees,f.currency,f.amount);if(feeKnown)feesAdd(er.exitFees,d.feeCurrency,d.fees);}
 }
 for(const r of closes.values())finish(r);
 for(const [entryKey,r] of byEntry){finish(r);r.closeStatus=new Big(r.closedQuantity).gte(knownEntries.get(entryKey)?.data.quantity || 0)?'closed':'partially_closed';}
 return {closes,byEntry};
}

export function reportedNetResult(exit) {
 return {...result(exit.currency),grossPnl:null,netPnl:exit.pnl,status:'exchange_net',reason:'Exchange-reported net already includes trading fees.',closedQuantity:exit.quantity===null?null:String(exit.quantity)};
}
