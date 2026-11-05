import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { db } from '../config/sqlite.js';
import { waDb, hash, parse, settings, ownedAccounts } from '../whatsapp/store.js';
import { recordEvent, setupFields } from '../whatsapp/events.js';
import { conditionDescription } from './watcher-live.service.js';
import { confirmationRequired } from './trade-approval-options.js';
import { executeApprovedTrade } from './approved-execution.service.js';
import { sendApprovalEmail } from './notification.service.js';
import { normalizeInterval } from '../../../watcher-main/src/logics/market-utils.js';
import { demoApprovalTestEnabled, setupMonitoringOnly } from './watcher-execution-mode.js';

waDb.exec(`CREATE TABLE IF NOT EXISTS jarvis_trade_approvals (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL,setup_id TEXT NOT NULL,status TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,token_cipher TEXT NOT NULL,review_nonce TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,fingerprint TEXT NOT NULL,account_fingerprint TEXT NOT NULL,
 trigger_json TEXT NOT NULL,accounts_json TEXT NOT NULL,monitor_only INTEGER NOT NULL,
 execution_id TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 decided_at INTEGER,result_json TEXT NOT NULL DEFAULT '{}',notifications_json TEXT NOT NULL DEFAULT '{}');
 CREATE UNIQUE INDEX IF NOT EXISTS jarvis_approval_pending ON jarvis_trade_approvals(user_id,setup_id) WHERE status IN ('pending','executing');
 CREATE INDEX IF NOT EXISTS jarvis_approval_owner ON jarvis_trade_approvals(user_id,created_at);`);

const fields=['userId','setupName','logicType','triggerSymbol','timeframe','indicators','usdChange','direction','watchPrice','resetReferenceOnTrigger','candleRange','candleColor','accounts','tradingSymbol','side','margin','leverage','TP','SL','TP_mode','SL_mode','repeatCounter','triggeredCounter','isCompleted','watcherPaused','countdown','executionMode','approvalChannels','approvalExpiryMinutes','approvalMaxPriceDeviationPct'];
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,stable(value[k])])):value;
export const approvalFingerprint=setup=>hash(JSON.stringify(stable(Object.fromEntries(fields.map(k=>[k,setup[k]])))));
const accountFingerprint=accounts=>hash(JSON.stringify(stable(accounts.map(a=>({id:a.id,userId:a.userId,name:a.name,exchangeType:a.exchangeType,network:a.network,accountType:a.accountType,key:hash(a.apiKey || ''),secret:hash(a.apiSecret || '')})).sort((a,b)=>a.id.localeCompare(b.id)))));
const cipherKey=createHash('sha256').update(env.AUTH_SECRET).digest();
function seal(token) { const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cipherKey,iv);const body=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url'); }
function unseal(value) {const bytes=Buffer.from(value,'base64url'),cipher=createDecipheriv('aes-256-gcm',cipherKey,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');}
const rawDoc=(collection,id)=>parse(waDb.prepare('SELECT data_json FROM documents WHERE collection_name=? AND document_id=?').get(collection,id)?.data_json || '{}');
function expire() { waDb.prepare("UPDATE jarvis_trade_approvals SET status='expired',decided_at=? WHERE status='pending' AND expires_at<=?").run(Date.now(),Date.now()); }
export function pendingApproval(setup) {if(!confirmationRequired(setup))return false;expire();return !!waDb.prepare("SELECT id FROM jarvis_trade_approvals WHERE user_id=? AND setup_id=? AND status IN ('pending','executing')").get(setup.userId,setup.id);}
function publicOrigin() {
    const url=new URL(process.env.PUBLIC_APP_URL || env.FRONTEND_ORIGIN || 'http://localhost:5173');
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Set PUBLIC_APP_URL to your website address');
    if(env.APP_ENV==='production'&&url.protocol!=='https:')throw Error('Public approval links require an HTTPS website address');
    return url.origin+url.pathname.replace(/\/$/,'');
}
const linkFor=row=>publicOrigin()+'/trade-approval#'+unseal(row.token_cipher);
const fetchRow=id=>waDb.prepare('SELECT * FROM jarvis_trade_approvals WHERE id=?').get(id);
function byToken(token) {
    if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    return waDb.prepare('SELECT * FROM jarvis_trade_approvals WHERE token_hash=?').get(hash(token));
}
const compactAccounts=accounts=>accounts.map(a=>({id:a.id,name:a.name || 'Exchange account',exchange:a.exchangeType,network:a.network}));
const channels=setup=>setup.approvalChannels || {whatsapp:true,email:true};
const messageFor=(row,url)=>{
 const s=parse(row.snapshot_json),trigger=parse(row.trigger_json),accounts=parse(row.accounts_json);
 const local=(trigger.testOnly||trigger.demoRetryOf)&&['localhost','127.0.0.1'].includes(new URL(url).hostname)?'LOCALHOST TEST: Open this link on the computer running Jarvis. A phone needs this same app deployed on HTTPS.\n':'';
 return `${row.monitor_only?'MONITORING TEST — No order will be placed\n':''}${local}Trade approval required\nSetup: ${s.setupName}\nCondition: ${trigger.condition}\nTrigger coin: ${s.triggerSymbol} · ${normalizeInterval(s.timeframe)}\nTrigger price: ${trigger.price}\nTrade coins: ${[].concat(s.tradingSymbol || []).join(', ')}\nSide: ${s.side}\nAccount(s): ${accounts.map(a=>a.name+' ('+a.network+')').join(', ') || 'No connected account'}\nMargin per coin/account: ${s.margin} USDT · Leverage: ${s.leverage}x\nTP: ${s.TP || 'Not set'} ${s.TP_mode || ''} · SL: ${s.SL || 'Not set'} ${s.SL_mode || ''}\nExpires: ${new Date(row.expires_at).toISOString()}\nReview and choose Yes / No: ${url}\nPrivate single-use link. Anyone with this link can decide this request. Opening it does not place an order.`;
};
async function dispatchApproval(row) {
 const setup=parse(row.snapshot_json),url=linkFor(row),text=messageFor(row,url),delivery={};
 if(channels(setup).whatsapp) {
  const s=settings(row.user_id);
  const event=recordEvent(row.user_id,'approval:'+row.id,'approval_requested',{
   ...setupFields(setup),approvalId:row.id,approvalUrl:url,approvalAccountIds:setup.accounts || [],
   symbol:[].concat(setup.tradingSymbol || []).join(', '),summary:text,monitorOnly:!!row.monitor_only,
  },{skipDelivery:!s.enabled,source:parse(row.trigger_json).testOnly||parse(row.trigger_json).demoRetryOf?'test':'app'});
  const count=event?waDb.prepare('SELECT count(*) AS n FROM jarvis_wa_deliveries WHERE event_id=?').get(event.id).n:0;
  delivery.whatsapp=count?{status:'queued',recipients:count}:{status:'not_configured',reason:'Enable WhatsApp alerts and approval-request notifications; add an enabled recipient for this setup.'};
 }
 if(channels(setup).email) {
  delivery.email={status:'sending'};
  waDb.prepare('UPDATE jarvis_trade_approvals SET notifications_json=? WHERE id=?').run(JSON.stringify(delivery),row.id);
  try {delivery.email=await sendApprovalEmail({userId:row.user_id,subject:'[Jarvis] Approve trade: '+setup.setupName,text});}
  catch {delivery.email={status:'failed',reason:'Email could not be sent. Check your SMTP configuration.'};}
 }
 waDb.prepare('UPDATE jarvis_trade_approvals SET notifications_json=? WHERE id=?').run(JSON.stringify(delivery),row.id);
}

export async function createTradeApproval(setup,datasource,{monitorOnly=false,executionId=randomUUID(),testOnly=false,demoRetryOf=null}={}) {
 if(testOnly&&!monitorOnly)throw Error('Approval delivery tests require monitoring-only mode');
 if(!confirmationRequired(setup)||pendingApproval(setup))return null;
 const currentDoc=await db.collection('setups').doc(setup.id).get();
 if(!currentDoc.exists)return null;
 const current={id:setup.id,...currentDoc.data()},control=rawDoc('watcherControls',setup.userId);
 const accounts=(await ownedAccounts(setup.userId)).filter(a=>(current.accounts || []).includes(a.id));
 if(current.executionMode==='monitoring'||current.isCompleted||current.watcherPaused||control.paused||setupMonitoringOnly(current,control,accounts)!==!!monitorOnly)return null;
 let retrySource;
 if(demoRetryOf) {
  retrySource=fetchRow(demoRetryOf);
  const previous=retrySource?parse(retrySource.snapshot_json):{},trigger=retrySource?parse(retrySource.trigger_json):{};
  const same=['userId','logicType','triggerSymbol','timeframe','usdChange','direction','side','margin','leverage','TP','SL','TP_mode','SL_mode','accounts'].every(key=>JSON.stringify(previous[key])===JSON.stringify(current[key]));
  const originalSignal=retrySource&&waDb.prepare("SELECT id FROM jarvis_trade_events WHERE setup_id=? AND kind='trade_triggered' AND json_extract(data_json,'$.executionId')=?").get(setup.id,retrySource.execution_id);
  const sample=rawDoc('watcherSamples',setup.id);
  if(monitorOnly||testOnly||!demoApprovalTestEnabled(current,control,accounts)||!retrySource||retrySource.user_id!==setup.userId||retrySource.setup_id!==setup.id||retrySource.status!=='executed'
    ||parse(retrySource.result_json).protectionComplete!==false||trigger.testOnly||trigger.demoRetryOf||!originalSignal||!same
    ||![].concat(current.tradingSymbol || []).every(symbol=>[].concat(previous.tradingSymbol || []).includes(symbol))
    ||Date.now()-sample.marketAt>30000||datasource.eventTime!==sample.marketAt||Number(datasource.data.at(-1).close)!==sample.price) {
   throw Error('Demo retries require a scoped Testnet test, an earlier real signal with failed protection, and a fresh current quote');
  }
 }
 const expected={...setup,...(!testOnly&&!demoRetryOf&&setup.logicType==='price_movement'&&setup.resetReferenceOnTrigger===true?{watchPrice:Number(datasource.data.at(-1).close)}:{})};
 if(approvalFingerprint(current)!==approvalFingerprint(expected))return null;
 if(accounts.length!==(current.accounts || []).length)return null;
 publicOrigin();
 const at=Date.now(),token=randomBytes(32).toString('base64url'),id=randomUUID();
 const row={id,user_id:setup.userId,setup_id:setup.id,status:'pending',token_hash:hash(token),token_cipher:seal(token),review_nonce:randomBytes(24).toString('base64url'),snapshot_json:JSON.stringify(current),fingerprint:approvalFingerprint(current),account_fingerprint:accountFingerprint(accounts),trigger_json:JSON.stringify({at,marketAt:datasource.eventTime,price:Number(datasource.data.at(-1).close),testOnly,...(demoRetryOf?{demoRetryOf,originalSignal:parse(retrySource.trigger_json)}:{}),condition:demoRetryOf?'DEMO RETRY of an earlier real signal — no new strategy signal claimed. Original condition: '+parse(retrySource.trigger_json).condition:(testOnly?'APPROVAL DELIVERY TEST — no strategy signal claimed. Saved rule: ':'')+conditionDescription(setup).rule}),accounts_json:JSON.stringify(compactAccounts(accounts)),monitor_only:monitorOnly?1:0,execution_id:executionId,created_at:at,expires_at:at+Number(current.approvalExpiryMinutes || 5)*60000};
 try {waDb.prepare('INSERT INTO jarvis_trade_approvals(id,user_id,setup_id,status,token_hash,token_cipher,review_nonce,snapshot_json,fingerprint,account_fingerprint,trigger_json,accounts_json,monitor_only,execution_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row));}
 catch(error) {if(pendingApproval(setup))return null;throw error;}
 void dispatchApproval(row).catch(()=>waDb.prepare('UPDATE jarvis_trade_approvals SET notifications_json=? WHERE id=?').run(JSON.stringify({error:'Approval notifications could not be prepared. Review this request in Watcher.'}),id));
 return {id,url:linkFor(row)};
}

function context(row) {
 const setup={id:row.setup_id,...rawDoc('setups',row.setup_id)},control=rawDoc('watcherControls',row.user_id),owner=rawDoc('users',row.user_id);
 const accounts=(setup.accounts || []).map(id=>({id,...rawDoc('userAccounts',id)}));
 const valid=setup.userId===row.user_id&&['user','admin'].includes(owner.role)&&!owner.disabled&&!setup.isCompleted&&!setup.watcherPaused&&!control.paused&&setupMonitoringOnly(setup,control,accounts)===!!row.monitor_only&&approvalFingerprint(setup)===row.fingerprint&&accountFingerprint(accounts)===row.account_fingerprint;
 const sample=rawDoc('watcherSamples',row.setup_id),at=Date.now(),engine=rawDoc('watcher','status');
 const heartbeat=typeof engine.timestamp==='number'?engine.timestamp:Date.parse(engine.timestamp || '');
 const fresh=engine.online===true&&at-heartbeat<20000&&heartbeat<=at+5000&&Number.isFinite(sample.price)&&sample.price>0&&sample.marketAt&&at-sample.marketAt<30000&&sample.marketAt<=at+5000&&at-sample.observedAt<30000;
 const trigger=parse(row.trigger_json),deviation=fresh?Math.abs(sample.price-trigger.price)/trigger.price*100:null;
 const tolerance=Number(setup.approvalMaxPriceDeviationPct || 1);
 const connected=accounts.length>0&&accounts.every(a=>a.userId===row.user_id&&a.ping&&a.apiKey&&a.apiSecret);
 const reason=!valid?'The setup, account, or watcher mode changed. This request is no longer valid.':!fresh?'Waiting for a fresh market price.':deviation>tolerance?'Market price moved beyond the saved approval tolerance.':!row.monitor_only&&!connected?'Connect and verify every selected exchange account.':'';
 return {setup,valid,sample,fresh,deviation,tolerance,reason,canApprove:valid&&fresh&&deviation<=tolerance&&(!!row.monitor_only||connected)};
}
function refreshRow(row) {
 expire();row=fetchRow(row.id);
 if(row.status==='pending'&&!context(row).valid) {
  waDb.prepare("UPDATE jarvis_trade_approvals SET status='cancelled',decided_at=?,result_json=? WHERE id=? AND status='pending'").run(Date.now(),JSON.stringify({message:'Setup, account or watcher mode changed.'}),row.id);
  row=fetchRow(row.id);
 }
 return row;
}
function dto(row,{owner=false}={}) {
 const s=parse(row.snapshot_json),c=context(row);
 let url;
 if(owner&&row.status==='pending')try{url=linkFor(row);}catch{/* Configuration/key rotation must not break the watcher view. */}
 return {id:row.id,setupId:row.setup_id,setupName:s.setupName,status:row.status,monitorOnly:!!row.monitor_only,createdAt:row.created_at,expiresAt:row.expires_at,decidedAt:row.decided_at,trigger:parse(row.trigger_json),accounts:parse(row.accounts_json),trade:{symbols:[].concat(s.tradingSymbol || []),side:s.side,margin:s.margin,leverage:s.leverage,TP:s.TP,SL:s.SL,TP_mode:s.TP_mode,SL_mode:s.SL_mode,timeframe:s.timeframe,triggerSymbol:s.triggerSymbol},latestPrice:c.fresh?c.sample.price:null,priceDeviationPct:c.deviation,maxPriceDeviationPct:c.tolerance,canApprove:row.status==='pending'&&c.canApprove,reason:row.status==='pending'?c.reason:'',reviewNonce:row.status==='pending'?row.review_nonce:undefined,result:parse(row.result_json),notifications:parse(row.notifications_json),...(url?{url}:{})};
}
export function reviewTradeApproval(token) {const row=byToken(token);return row?dto(refreshRow(row)):null;}
export function listTradeApprovals(userId) {
 expire();return waDb.prepare('SELECT * FROM jarvis_trade_approvals WHERE user_id=? ORDER BY created_at DESC LIMIT 40').all(userId).map(row=>dto(refreshRow(row),{owner:true}));
}
export async function decideTradeApproval(token,decision,reviewNonce) {
 const found=byToken(token);if(!found)return null;
 let row=refreshRow(found);
 if(!['yes','no'].includes(decision))throw Error('Choose Yes or No');
 if(row.status!=='pending')return dto(row);
 if(typeof reviewNonce!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(reviewNonce)||!timingSafeEqual(Buffer.from(reviewNonce),Buffer.from(row.review_nonce)))throw Error('Open the review page before deciding');
 let approvedSetup;
 waDb.exec('BEGIN IMMEDIATE');
 try {
  row=fetchRow(row.id);
  if(row.status==='pending'&&row.expires_at>Date.now()) {
   const c=context(row);
   if(decision==='yes'&&!c.canApprove)throw Error(c.reason);
   const status=decision==='no'?'rejected':row.monitor_only?'monitoring_confirmed':'executing';
   const changed=waDb.prepare("UPDATE jarvis_trade_approvals SET status=?,decided_at=? WHERE id=? AND status='pending' AND expires_at>?").run(status,Date.now(),row.id,Date.now());
   if(changed.changes&&decision==='yes'&&!row.monitor_only) {
    approvedSetup=c.setup;
    const control=rawDoc('watcherControls',row.user_id);
    const accounts=(c.setup.accounts || []).map(id=>({id,...rawDoc('userAccounts',id)}));
    if(demoApprovalTestEnabled(c.setup,control,accounts)) {
     // Consume the demo permission in the same transaction as the Yes decision.
     waDb.prepare("UPDATE documents SET data_json=json_set(data_json,'$.demoApprovalTest.usedApprovalId',?),updated_at=? WHERE collection_name='watcherControls' AND document_id=?").run(row.id,new Date().toISOString(),row.user_id);
    }
   }
  }
  waDb.exec('COMMIT');
 } catch(error){waDb.exec('ROLLBACK');throw error;}
 if(approvedSetup) {
  let outcome;
  try {
   const result=await executeApprovedTrade(approvedSetup,row.id,row.execution_id);
   const exitsFailed=result.ok&&Array.isArray(result.body?.data)&&result.body.data.some(r=>r.success&&r.protectionComplete===false);
   const blocked=result.status===409;
   outcome={status:blocked?'blocked':result.ok?'executed':'failed',message:blocked||result.status===503?result.body?.message || 'Entry state could not be verified; no orders were placed.':exitsFailed?'Entry orders were placed, but TP/SL protection is incomplete. Check Portfolio and your exchange before another order.':result.ok?'Order request accepted. Portfolio shows fills and TP/SL results.':'Order could not be confirmed. Check Portfolio and your exchange before trying another order.'};
   outcome.protectionComplete=result.ok?!exitsFailed:undefined;
  }
  catch {outcome={status:'failed',message:'Execution outcome could not be confirmed. Check Portfolio and your exchange.'};}
  waDb.prepare("UPDATE jarvis_trade_approvals SET status=?,result_json=? WHERE id=? AND status='executing'").run(outcome.status,JSON.stringify({message:outcome.message,protectionComplete:outcome.protectionComplete}),row.id);
  const scope=rawDoc('watcherControls',row.user_id).demoApprovalTest;
  if(scope?.usedApprovalId===row.id) {
   try {
    let restored=false;
    const original=scope.restoreTradingSymbols,current=rawDoc('setups',row.setup_id),snapshot=parse(row.snapshot_json);
    if(Array.isArray(original)&&original.length&&original.every(value=>typeof value==='string')
      &&current.userId===row.user_id&&JSON.stringify(current.tradingSymbol)===JSON.stringify(snapshot.tradingSymbol)) {
     await db.collection('setups').doc(row.setup_id).update({tradingSymbol:original});
     restored=true;
    }
    await db.collection('watcherControls').doc(row.user_id).update({demoApprovalTest:null});
    if(restored)waDb.prepare('UPDATE jarvis_trade_approvals SET result_json=? WHERE id=?').run(JSON.stringify({message:outcome.message+' Original coin list restored.',protectionComplete:outcome.protectionComplete,restoredTradingSymbols:true}),row.id);
   } catch {
    waDb.prepare('UPDATE jarvis_trade_approvals SET result_json=? WHERE id=?').run(JSON.stringify({message:outcome.message+' Review the temporary Demo test settings; automatic restoration could not be confirmed.'}),row.id);
   }
  }
 }
 return dto(refreshRow(fetchRow(row.id)));
}
