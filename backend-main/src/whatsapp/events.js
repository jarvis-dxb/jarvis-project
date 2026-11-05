import { waDb, settings, recipients, id, hash, json, now, EVENT_LABELS, DEFAULTS, ownedAccounts, safeError, symbolKey, saveRuntime } from './store.js';
import { renderTemplate, reportEvent } from './templates.js';
import { receiptData } from './receipt.js';
import { resolveTradeResult } from './trade-result.js';
export function notificationContent(event,s,format,previous={}) {
 const resolved=resolveTradeResult(event),enriched=resolved.event;
 const template=previous.templateSource ?? s.templates[event.kind]?.[format],zone=previous.timezone || s.timezone;
 const rendered=event.kind==='approval_requested'?event.data.summary:renderTemplate(template || '{{title}}\n{{summary}}',enriched,zone);
 const receipt=receiptData(enriched,zone);
 if(event.kind==='report'||template && template!==DEFAULTS.templates[event.kind]?.[format])receipt.extraText=rendered;
 if(receipt.note&&receipt.extraText.includes(receipt.note))receipt.note='';
 return {...resolved,content:{text:(event.kind==='monitoring_match'?'MONITORING ONLY — No order placed\n':'')+rendered,design:previous.design || s.designs[format],eventKind:event.kind,sample:event.source==='sample',receipt,templateSource:template,timezone:zone}};
}
export function selected(s,event) {
 if(event.kind==='approval_requested' && s.accountIds.length && !s.accountIds.some(id=>event.data.approvalAccountIds?.includes(id))) return false;
 if(s.scope==='app' && event.source==='exchange' && !event.data?.appOrder) return false;
 if(s.accountIds.length && event.account_id && !s.accountIds.includes(event.account_id)) return false;
 if(s.setupIds.length && event.kind!=='watcher_status' && !s.setupIds.includes(event.setup_id)) return false;
 return true;
}
export function queueEvent(event,s,onlyRecipients=null,formatOverride=null) {
 const list=recipients(event.user_id).filter(r=>r.enabled && (!onlyRecipients || onlyRecipients.includes(r.id)));
 for(const r of list) {
  if(event.kind==='approval_requested' && r.accountIds.length && !r.accountIds.some(id=>event.data.approvalAccountIds?.includes(id))) continue;
  if(r.accountIds.length && event.account_id && !r.accountIds.includes(event.account_id)) continue;
  let recipientEvent=event;
  if(event.kind==='report' && r.accountIds.length) {
   const routing=s.accountIds.length?r.accountIds.filter(account=>s.accountIds.includes(account)):r.accountIds;
   if(!routing.length)continue;
   recipientEvent={...event,...reportEvent(event.user_id,event.data.reportStart,event.data.reportEnd,routing)};
  }
  const format=event.kind==='approval_requested'?'text':formatOverride || s.alertFormat;
  const {content:body}=notificationContent(recipientEvent,s,format);
  waDb.prepare('INSERT OR IGNORE INTO jarvis_wa_deliveries(id,user_id,event_id,recipient_id,format,content_json,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id(),event.user_id,event.id,r.id,format,json(body),now(),now(),now());
 }
}
export function recordEvent(userId,key,kind,data={},options={}) {
 if(!userId || !EVENT_LABELS[kind]) return null;
 const event={id:id(),user_id:userId,event_key:hash(userId+':'+key),kind,account_id:data.accountId || null,setup_id:data.setupId || null,source:options.source || 'app',data,occurred_at:options.at || now()};
 const s=settings(userId);
 waDb.exec('BEGIN IMMEDIATE');
 try {
  const result=waDb.prepare('INSERT OR IGNORE INTO jarvis_trade_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.id,userId,event.event_key,kind,event.account_id,event.setup_id,event.source,json(data),event.occurred_at,now());
  if(options.runtimeState)saveRuntime(options.runtimeState.key,options.runtimeState.value);
  if(!result.changes) {waDb.exec('COMMIT');return null;}
  if(!options.skipDelivery && s.enabled && s.events[kind] && selected(s,event)) queueEvent(event,s);
  waDb.exec('COMMIT');
  return event;
 } catch(error) {waDb.exec('ROLLBACK');throw error;}
}
const target=(value,mode)=>value ? value+' '+(mode==='pnl'?'USD PnL':mode==='%'?'%':'price') : 'Not set';
export function setupFields(setup,account) {
 return {setupId:setup.id || '',setupName:setup.setupName || 'Trading setup',accountId:account?.id,account:account?.name,exchange:account?.exchangeType,network:account?.network,margin:setup.margin,leverage:setup.leverage,side:setup.side,takeProfit:target(setup.TP,setup.TP_mode),stopLoss:target(setup.SL,setup.SL_mode),repeatProgress:(setup.triggeredCounter || 0)+'/'+(setup.repeatCounter || 1)};
}
export async function captureAppEvent({userId,type,setup={},results=[],executionId,skipDelivery=false}) {
 if(!userId) return;
 const accounts=await ownedAccounts(userId);
 const key=executionId || (setup.id+':'+(setup.triggeredCounter || 0));
 if(type==='trade_activated' || type==='trade_triggered') {
  for(const account of accounts.filter(a=>(setup.accounts || []).includes(a.id))) recordEvent(userId,type+':'+key+':'+account.id,type,{...setupFields(setup,account),executionId:key,symbol:Array.isArray(setup.tradingSymbol)?setup.tradingSymbol.join(', '):setup.tradingSymbol || setup.triggerSymbol},{skipDelivery});
  return;
 }
 for(const [index,result] of results.entries()) {
  const account=accounts.find(a=>a.id===result.account);
  if(!account) continue;
  const data={...setupFields(setup,account),symbol:result.symbol,side:result.side || setup.side,appOrder:true,orderId:String(result.order?.id || result.order?.orderId || ''),price:result.order?.average || result.order?.price || undefined,quantity:result.order?.filled || result.order?.amount || undefined,status:result.order?.status,error:result.success ? undefined : safeError(result.error)};
  const orderKey=data.orderId || key+':'+index;
  recordEvent(userId,'execution:'+account.id+':'+symbolKey(data.symbol)+':'+orderKey,result.success ? 'order_accepted':'order_failed',data);
  if(result.success && data.orderId) waDb.prepare('INSERT OR IGNORE INTO jarvis_trade_order_refs VALUES(?,?,?,?,?,?)').run(account.id,data.orderId,symbolKey(data.symbol),userId,'entry',json(data));
  for(const [role,order,error] of [['tp',result.tpOrder,result.tpError],['sl',result.slOrder,result.slError]]) {
   const exitId=String(order?.id || order?.orderId || '');
   if(exitId) {
    waDb.prepare('INSERT OR IGNORE INTO jarvis_trade_order_refs VALUES(?,?,?,?,?,?)').run(account.id,exitId,symbolKey(data.symbol),userId,role,json(data));
    recordEvent(userId,role+':set:'+account.id+':'+symbolKey(data.symbol)+':'+exitId,role==='tp'?'take_profit_set':'stop_loss_set',{...data,orderId:exitId});
   } else if(error) recordEvent(userId,role+':failed:'+key+':'+account.id+':'+index,'exit_rule_failed',{...data,error:role.toUpperCase()+': '+safeError(error)});
  }
 }
}
export const findOrder = (accountId,orderId,symbol) => {
 const r=waDb.prepare('SELECT role,data_json FROM jarvis_trade_order_refs WHERE account_id=? AND order_id=? AND symbol=?').get(accountId,String(orderId),symbolKey(symbol));
 return r ? {role:r.role,...JSON.parse(r.data_json)} : null;
};

