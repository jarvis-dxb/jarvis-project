import { db } from '../config/sqlite.js';
import { ownedAccounts, ownedSetups, compactAccounts, connection, settings, eventRows, waDb, safeError } from '../whatsapp/store.js';
import { normalizeInterval, closedStreak, lastClosedIndex, candleTime, candleColor } from '../../../watcher-main/src/logics/market-utils.js';
import { usesClosedPriceMovement } from '../../../watcher-main/src/logics/price_movement.js';
import { demoAutoEnabled, demoConfirmationEnabled, setupMonitoringOnly } from './watcher-execution-mode.js';

const writes = new Map();
const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export const timestamp = value => typeof value === 'number' ? value : new Date(value?.toDate?.() || value || 0).getTime() || null;
export async function watcherControl(userId) { return (await db.collection('watcherControls').doc(userId).get()).data() || {}; }
export async function setWatcherPaused(userId, paused) {
 await db.collection('watcherControls').doc(userId).set({ paused, updatedAt: new Date() }, { merge:true });
}
export async function setWatcherMode(userId, monitorOnly) { await db.collection('watcherControls').doc(userId).set({monitorOnly,forceMonitoringOnly:monitorOnly,demoApprovalTest:null,demoConfirmationSetupIds:[],demoAutoSetupIds:[],updatedAt:new Date()},{merge:true}); }
export function setupAccountReady(setup,accounts) { return !!setup.accounts?.length && setup.accounts.every(id=>accounts.some(a=>a.id===id&&a.userId===setup.userId&&a.ping&&a.apiKey&&a.apiSecret)); }
export async function allowedSetups(setups) {
 const users=[...new Set(setups.map(s=>s.userId).filter(Boolean))];
 const controls=new Map(await Promise.all(users.map(async user=>[user,await watcherControl(user)])));
 return setups.filter(s=>!s.isCompleted && !s.watcherPaused && !controls.get(s.userId)?.paused &&
    !controls.get(s.userId)?.signedOut &&
    Number(s.triggeredCounter || 0) < Number(s.repeatCounter || 1));
}
export function conditionDescription(setup) {
 const type=setup.logicType?.toLowerCase(), indicators=setup.indicators || {};
 if(type==='rsi')return {label:'RSI (14)',target:number(indicators['Relative Strength Index (14)']),rule:'RSI (14) crosses '+(setup.side?.toLowerCase()==='long'?'above ':'below ')+indicators['Relative Strength Index (14)']};
 if(type==='price_movement')return {label:'Price movement (USD)',target:setup.direction?.toLowerCase()==='down'?-number(setup.usdChange):number(setup.usdChange),rule:'Price moves '+setup.usdChange+' USD '+setup.direction+(usesClosedPriceMovement(setup)?' from open to close of a closed candle':number(setup.watchPrice)!==null?' from '+setup.watchPrice:' from candle open')};
 if(type==='volume')return {label:'Volume',target:number(Object.entries(indicators).find(([key])=>key.toLowerCase().includes('volume'))?.[1]),rule:'Volume reaches '+(Object.entries(indicators).find(([key])=>key.toLowerCase().includes('volume'))?.[1] ?? 'saved target')+' on a '+(setup.direction==='down'?'bearish':'bullish')+' candle'};
 if(type==='candle_strike')return {label:'Consecutive closed candles',target:number(setup.candleRange),rule:setup.candleRange+' consecutive '+(setup.candleColor?.toLowerCase()==='green'?'bullish':'bearish')+' closed candles'};
 return {label:'Condition value',target:null,rule:'Review the saved setup condition'};
}
export function sampleValue(setup,bars,index) {
 const bar=bars[index],type=setup.logicType?.toLowerCase();if(!bar)return null;
 if(type==='rsi')return number(bar.indicators?.['Relative Strength Index (14)']);
 if(type==='volume')return number(bar.volume);
 if(type==='price_movement') {const close=number(bar.close),reference=usesClosedPriceMovement(setup) ? number(bar.open) : number(setup.watchPrice) ?? number(bar.open);if(usesClosedPriceMovement(setup)&&bar.isBarClosed!==true)return null;return close!==null&&reference!==null?close-reference:null;}
 if(type==='candle_strike') {
  return closedStreak(bars,setup.candleColor?.toLowerCase(),bars[index]?.isBarClosed===true?index:index-1);
 }
 return null;
}
export async function publishChecks(setups,datasource,matches=[]) {
 const at=Date.now(),bars=datasource.data || [];
 for(const setup of setups.filter(s=>s.triggerSymbol===datasource.symbol && normalizeInterval(s.timeframe)===normalizeInterval(datasource.interval))) {
  const matched=matches.some(s=>s.id===setup.id);
  if(!matched && at-(writes.get(setup.id)||0)<5000)continue;writes.set(setup.id,at);
  const ref=db.collection('watcherSamples').doc(setup.id),previous=(await ref.get()).data() || {};
  const points=bars.slice(-240).map((bar,i,tail)=>({time:typeof bar.time==='number'?(bar.time<1e12?bar.time*1000:bar.time):timestamp(bar.time),value:sampleValue(setup,bars,bars.length-tail.length+i)})).filter(p=>p.time&&p.value!==null);
  const combined=new Map((previous.points || []).map(p=>[p.time,p]));for(const p of points)combined.set(p.time,p);
  const last=bars.at(-1),current=sampleValue(setup,bars,usesClosedPriceMovement(setup)?lastClosedIndex(bars):bars.length-1);
  // Display-only observations from the same feed the engine evaluates. These
  // fields never change a setup, its signal state, cooldown or execution count.
  const closedIndex=lastClosedIndex(bars);
  const candles=bars.slice(-80).map((bar,i)=>({time:candleTime(bar.time),closeTime:candleTime(bar.closeTime),open:number(bar.open),high:number(bar.high),low:number(bar.low),close:number(bar.close),volume:number(bar.volume),closed:bars.length-Math.min(80,bars.length)+i<=closedIndex,color:candleColor(bar)})).filter(bar=>bar.time&&[bar.open,bar.high,bar.low,bar.close].every(v=>v!==null));
  await ref.set({userId:setup.userId,observedAt:at,current,price:number(last?.close),matched,candles,source:datasource.source || 'watcher-feed',marketAt:datasource.eventTime || null,points:[...combined.values()].sort((a,b)=>a.time-b.time).slice(-240),checks:[{at,matched,current},...(previous.checks || [])].slice(0,60)});
 }
}
export async function liveSnapshot(userId) {
 const [setups,accounts,control,statusDoc,samplesDoc]=await Promise.all([ownedSetups(userId),ownedAccounts(userId),watcherControl(userId),db.collection('watcher').doc('status').get(),db.collection('watcherSamples').where('userId','==',userId).get()]);
 const engine=statusDoc.data() || {},heartbeat=timestamp(engine.timestamp),fresh=!!engine.online && !!heartbeat && Date.now()-heartbeat<20000;
 const samples=Object.fromEntries(samplesDoc.docs.map(d=>[d.id,d.data()]));
 const status=control.paused?'paused':control.signedOut?'offline':fresh?(control.monitorOnly?'monitoring':'running'):engine.state==='starting'&&heartbeat&&Date.now()-heartbeat<120000?'starting':engine.state==='degraded'?'error':'offline';
 const fields=['setupName','triggerSymbol','timeframe','logicType','side','indicators','usdChange','watchPrice','resetReferenceOnTrigger','priceReferenceResetAt','priceReferencePrevious','direction','candleRange','candleColor','accounts','tradingSymbol','triggeredCounter','repeatCounter','isCompleted','watcherPaused','margin','leverage','TP','SL','TP_mode','SL_mode','countdown','executionMode'];
 const {listTradeApprovals}=await import('./trade-approval.service.js');
 const approvals=listTradeApprovals(userId);
 const events=eventRows(userId,0,Date.now()+1,100);
 // Read each setup's last confirmed signal independently of the activity feed's
 // 100-row limit. This does not alter trigger detection or execution state.
 const triggers=waDb.prepare("SELECT setup_id,kind,occurred_at FROM (SELECT setup_id,kind,occurred_at,ROW_NUMBER() OVER (PARTITION BY setup_id ORDER BY occurred_at DESC,rowid DESC) AS rank FROM jarvis_trade_events WHERE user_id=? AND kind IN ('trade_triggered','monitoring_match') AND setup_id IS NOT NULL) WHERE rank=1").all(userId);
 const lastTriggers=Object.fromEntries(triggers.map(t=>[t.setup_id,{at:t.occurred_at,kind:t.kind}]));
 const deliveries=waDb.prepare('SELECT d.event_id,d.format,d.status,d.error,d.updated_at,r.label FROM jarvis_wa_deliveries d LEFT JOIN jarvis_wa_recipients r ON r.id=d.recipient_id WHERE d.user_id=? ORDER BY d.updated_at DESC LIMIT 50').all(userId);
 const allMonitoringOnly=control.forceMonitoringOnly === true || (control.forceMonitoringOnly === undefined && !!control.monitorOnly && !setups.some(s=>!s.isCompleted&&!s.watcherPaused&&!setupMonitoringOnly(s,control,accounts)));
 return {allMonitoringOnly,status,online:['running','monitoring'].includes(status),monitorOnly:!!control.monitorOnly,heartbeat,feed:engine.feed || null,error:engine.error?safeError(engine.error):null,paused:!!control.paused,accounts:compactAccounts(accounts),whatsapp:{status:connection(userId).status,enabled:settings(userId).enabled},events,deliveries,approvals,setups:setups.map(s=>({id:s.id,...Object.fromEntries(fields.filter(k=>k in s).map(k=>[k,s[k]])),monitoringOnly:setupMonitoringOnly(s,control,accounts),approval:approvals.find(a=>a.setupId===s.id) || null,accountReady:setupAccountReady(s,accounts),demoConfirmationActive:demoConfirmationEnabled(s,control,accounts),demoAutoActive:demoAutoEnabled(s,control,accounts),executionBlocked:setupMonitoringOnly(s,control,accounts) || !setupAccountReady(s,accounts),condition:conditionDescription(s),sample:samples[s.id] || null,lastTrigger:lastTriggers[s.id] || null}))};
}
