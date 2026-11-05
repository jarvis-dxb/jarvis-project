import Big from 'big.js';
import { DateTime } from 'luxon';
import { waDb, ownedAccounts, parse, symbolKey, EVENT_LABELS, settings } from '../whatsapp/store.js';
import { liveSnapshot } from './watcher-live.service.js';

const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const validEvent = e => !['sample','test','report'].includes(e.source) && !['test','report'].includes(e.kind);
const orderKey = e => [e.account_id || '',symbolKey(e.data.symbol),e.data.orderId || e.data.fillId || e.id].join('|');
const add = (map,key,value) => { if(numeric(value)!==null)map[key]=new Big(map[key] || 0).plus(value).toFixed(); };
export function portfolioRange(period,at=Date.now()) {
 const day=DateTime.fromMillis(at,{zone:'Asia/Dubai'}).startOf('day');
 if(!['all','today','week','month'].includes(period))throw Error('Invalid portfolio period');
 return {start:period==='all'?0:period==='today'?day.toMillis():period==='week'?day.minus({days:6}).toMillis():day.minus({days:29}).toMillis(),end:at+1};
}

// Read-only reporting. Signals, filled entry orders and exchange positions have
// different units; a monitoring signal never becomes an executed trade here.
export function summarizePortfolio({events,live,accounts,positions={},monitor={},coverage={},at=Date.now(),start=0,end=at+1,accountId=''}) {
 const owned=new Set(accounts.map(a=>a.id));
 const selected=accounts.filter(a=>!accountId||a.id===accountId);
 const rows=events.filter(e=>validEvent(e)&&(!e.account_id||owned.has(e.account_id))&&(!accountId||e.account_id===accountId)&&e.occurred_at>=start&&e.occurred_at<end).sort((a,b)=>a.occurred_at-b.occurred_at);
 const signals=new Map(),accepted=new Set(),entries=new Set(),failures=new Set(),closed=new Map(),totals={},fees={};
 const netOrders=new Set(rows.filter(e=>e.kind==='pnl_updated'&&(e.data.pnlIncludesFees||e.data.pnlSource==='closed_net')&&numeric(e.data.pnl)!==null).map(orderKey));
 for(const e of rows) {
  const d=e.data || {},key=orderKey(e);
  if(['monitoring_match','trade_triggered'].includes(e.kind)) {
   // Monitoring emits one event per linked account, all with the same timestamp.
   // New automatic signals carry executionId; legacy rows use saved repeat state.
   const signal=[e.kind,e.setup_id || e.id,d.executionId || (e.kind==='monitoring_match'?e.occurred_at:[d.repeatProgress,Math.floor(e.occurred_at/1000)].join(':'))].join('|');
   signals.set(signal,e);
  }
  if(e.kind==='order_accepted') {
   accepted.add(key);
   if(d.status==='closed'&&numeric(d.quantity)>0)entries.add(key);
  }
  if(e.kind==='order_failed')failures.add(key);
  if(e.kind==='trade_filled'&&d.role==='entry'&&numeric(d.quantity)>0)entries.add(key);
  const fillPnl=e.kind==='trade_filled'&&d.pnlSource==='fill'&&!netOrders.has(key);
  const reportedPnl=e.kind==='pnl_updated'&&d.pnlSource!=='fill';
  if((fillPnl||reportedPnl)&&numeric(d.pnl)!==null&&d.currency) {
   const basis=d.pnlIncludesFees?'net':'gross';
   add(totals,d.currency+'|'+basis,reportedPnl?(d.deltaPnl ?? d.pnl):d.pnl);
   if(reportedPnl||Number(d.pnl)!==0||['tp','sl'].includes(d.role)) {
   const closeKey=key+'|'+d.currency,previous=closed.get(closeKey),reported=d.pnlIncludesFees||d.pnlSource==='closed_net';
    if(reported)closed.set(closeKey,{...e,pnl:String(d.pnl),basis,currency:d.currency,reported:true});
    else if(!previous?.reported)closed.set(closeKey,{...e,pnl:new Big(previous?.pnl || 0).plus(d.pnl).toFixed(),basis,currency:d.currency,reported:false});
   }
  }
  if(e.kind==='trade_filled'&&d.feeCurrency)add(fees,d.feeCurrency,d.fees);
 }
 const accountState=selected.map(a=>{
  const snapshot=coverage[a.id],health=monitor[a.id],ready=!!(a.ping&&a.apiKey&&a.apiSecret);
  const age=at-Number(snapshot?.at || 0);
  const fresh=!!(ready&&snapshot?.complete&&snapshot.at&&age>=0&&age<120000&&!['reconnecting','paused'].includes(health?.positionsStatus));
  return {id:a.id,name:a.name,exchange:a.exchangeType,network:a.network,ready,
   status:fresh?'online':health?.positionsStatus==='paused'?'paused':snapshot?.at?'reconnecting':'unavailable',
   updatedAt:snapshot?.at || null,fresh,historyStatus:health?.historyStatus || null};
 });
 const selectedIds=new Set(selected.map(a=>a.id)),stateById=Object.fromEntries(accountState.map(a=>[a.id,a]));
 const positionRows=Object.entries(positions).filter(([,p])=>selectedIds.has(p.accountId)&&numeric(p.contracts)>0).map(([id,p])=>{
  const state=stateById[p.accountId],initialMargin=numeric(p.initialMargin),unrealizedPnl=numeric(p.unrealizedPnl);
  return {id,accountId:p.accountId,account:state?.name,exchange:state?.exchange,network:state?.network,
   symbol:p.symbol,side:p.side,quantity:numeric(p.contracts),entryPrice:numeric(p.entryPrice),markPrice:numeric(p.markPrice),
   liquidationPrice:numeric(p.liquidationPrice)>0?numeric(p.liquidationPrice):null,
   initialMargin,leverage:numeric(p.leverage),marginMode:p.marginMode || null,unrealizedPnl,
   roe:unrealizedPnl!==null&&initialMargin>0?new Big(unrealizedPnl).div(initialMargin).times(100).toNumber():null,
   status:state?.fresh?'open':'last_known',currency:'USDT',fresh:!!state?.fresh,updatedAt:p.updatedAt || state?.updatedAt};
 });
 const positionsAvailable=accountState.length>0&&accountState.every(a=>a.fresh);
 const freshPositions=positionRows.filter(p=>p.fresh),unrealizedKnown=freshPositions.every(p=>p.unrealizedPnl!==null);
 const outcomes=[...closed.values()],wins=outcomes.filter(e=>Number(e.pnl)>0).length,losses=outcomes.filter(e=>Number(e.pnl)<0).length;
 const setups=live.setups.filter(s=>!accountId||s.accounts?.includes(accountId)).map(s=>{
  const active=!s.isCompleted&&!s.watcherPaused;
  const watching=active&&live.online&&!!live.heartbeat&&at-live.heartbeat<20000&&!!s.sample&&at-s.sample.observedAt<30000;
  const setupSignals=[...signals.values()].filter(e=>e.setup_id===s.id);
  return {id:s.id,name:s.setupName,symbol:s.triggerSymbol,rule:s.condition.rule,status:s.isCompleted?'completed':s.watcherPaused?'paused':watching?'watching':live.status==='paused'?'watcher paused':'waiting for data',triggers:setupSignals.length,lastTrigger:s.lastTrigger,executed:s.triggeredCounter || 0,repeat:s.repeatCounter || 1};
 });
 const totalPnl=Object.entries(totals).map(([key,amount])=>{const [currency,basis]=key.split('|');return {currency,basis,amount};});
 return {
  at,mode:live.monitorOnly?'monitoring':'trading',watcher:{status:live.status,online:live.online,heartbeat:live.heartbeat},
  counts:{triggers:signals.size,monitoringTriggers:[...signals.values()].filter(e=>e.kind==='monitoring_match').length,tradingTriggers:[...signals.values()].filter(e=>e.kind==='trade_triggered').length,opened:entries.size,accepted:accepted.size,failed:failures.size,profitable:wins,losing:losses,breakeven:outcomes.length-wins-losses,closedOrders:outcomes.length,closedPositions:rows.filter(e=>e.kind==='trade_closed').length,running:positionsAvailable?freshPositions.length:null,watching:setups.filter(s=>s.status==='watching').length,activeSetups:setups.filter(s=>!['paused','completed'].includes(s.status)).length,pausedSetups:setups.filter(s=>s.status==='paused').length,completedSetups:setups.filter(s=>s.status==='completed').length},
  positionsAvailable,accounts:accountState,positions:positionRows,setups,
  realized:totalPnl,fees:Object.entries(fees).map(([currency,amount])=>({currency,amount})),unrealized:positionsAvailable&&unrealizedKnown?freshPositions.reduce((sum,p)=>sum.plus(p.unrealizedPnl),new Big(0)).toFixed():null,
  outcomes:outcomes.sort((a,b)=>b.occurred_at-a.occurred_at).slice(0,50).map(e=>({id:e.id,at:e.occurred_at,account:e.data.account || stateById[e.account_id]?.name,symbol:e.data.symbol,side:e.data.side,orderId:e.data.orderId,pnl:e.pnl,currency:e.currency,basis:e.basis})),
  approvals:live.approvals || [],
  recent:[...rows].reverse().slice(0,50).map(e=>({id:e.id,kind:e.kind,label:EVENT_LABELS[e.kind],at:e.occurred_at,setupId:e.setup_id,setupName:e.data.setupName,account:e.data.account || stateById[e.account_id]?.name,symbol:e.data.symbol || e.data.triggerSymbol,orderId:e.data.orderId,summary:e.kind==='monitoring_match'?'Condition matched · No order placed':e.kind==='approval_requested'?'Awaiting trade confirmation':e.data.summary || ''})),
 };
}

export async function portfolioSnapshot(userId,{period='all',accountId=''}={}) {
 const at=Date.now(),range=portfolioRange(period,at),[live,accounts]=await Promise.all([liveSnapshot(userId),ownedAccounts(userId)]);
 if(accountId&&!accounts.some(a=>a.id===accountId))throw Error('Account not found');
 const events=waDb.prepare('SELECT id,kind,account_id,setup_id,source,data_json,occurred_at FROM jarvis_trade_events WHERE user_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at,rowid').all(userId,range.start,range.end).map(e=>({...e,data:parse(e.data_json)}));
 const positionRow=waDb.prepare('SELECT data_json,updated_at FROM jarvis_wa_runtime WHERE key=?').get('positions:'+userId);
 const monitor=parse(waDb.prepare('SELECT data_json FROM jarvis_wa_runtime WHERE key=?').get('monitor:'+userId)?.data_json || '{}');
 const coverage=Object.fromEntries(accounts.map(a=>[a.id,parse(waDb.prepare('SELECT data_json FROM jarvis_wa_runtime WHERE key=?').get('position-snapshot:'+a.id)?.data_json || '{}')]));
 const first=waDb.prepare("SELECT MIN(occurred_at) AS at FROM jarvis_trade_events WHERE user_id=? AND source NOT IN ('sample','test','report') AND kind NOT IN ('test','report')").get(userId)?.at || null;
 return {...summarizePortfolio({events,live,accounts,positions:parse(positionRow?.data_json || '{}'),monitor,coverage,at,...range,accountId}),accountOptions:accounts.map(a=>({id:a.id,name:a.name,network:a.network})),period,accountId,range,trackedSince:settings(userId).trackingSince || first,firstEventAt:first};
}
