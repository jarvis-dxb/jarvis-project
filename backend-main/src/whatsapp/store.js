import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { databasePath, db } from '../config/sqlite.js';

export const waDb = new DatabaseSync(databasePath);
waDb.exec(`
 PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS jarvis_wa_settings(user_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS jarvis_wa_connections(user_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'disconnected',number TEXT,qr TEXT,error TEXT,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS jarvis_wa_groups(user_id TEXT NOT NULL,jid TEXT NOT NULL,name TEXT NOT NULL,PRIMARY KEY(user_id,jid));
 CREATE TABLE IF NOT EXISTS jarvis_wa_recipients(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,address TEXT NOT NULL,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,accounts_json TEXT NOT NULL DEFAULT '[]',archived INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,kind,address));
 CREATE TABLE IF NOT EXISTS jarvis_trade_events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,account_id TEXT,setup_id TEXT,source TEXT NOT NULL,data_json TEXT NOT NULL,occurred_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS jarvis_trade_events_user_time ON jarvis_trade_events(user_id,occurred_at);
 CREATE TABLE IF NOT EXISTS jarvis_wa_deliveries(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,event_id TEXT NOT NULL,recipient_id TEXT NOT NULL,format TEXT NOT NULL,content_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,message_id TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(event_id,recipient_id));
 CREATE INDEX IF NOT EXISTS jarvis_wa_queue ON jarvis_wa_deliveries(status,available_at);
 CREATE TABLE IF NOT EXISTS jarvis_wa_commands(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',error TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS jarvis_wa_runtime(key TEXT PRIMARY KEY,data_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS jarvis_trade_order_refs(account_id TEXT NOT NULL,order_id TEXT NOT NULL,symbol TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(account_id,order_id,symbol));
 CREATE TABLE IF NOT EXISTS jarvis_wa_lease(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
`);
export const now = () => Date.now();
export const id = () => randomUUID();
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const symbolKey = value => String(value || '').replace(/^[A-Z]+:/,'').replace(/\.[PS]$/,'').split(':')[0].replaceAll('/','');
export const json = value => JSON.stringify(value);
export const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
export const safeError = error => String(error?.message || error || 'Unknown error').replace(/(api.?key|secret|signature|token)=([^&\s]+)/gi,'$1=[redacted]').slice(0,350);
export const EVENT_LABELS = {
 trade_activated:'Setup activated', trade_triggered:'Condition triggered', monitoring_match:'Monitoring condition matched', approval_requested:'Trade approval required', order_accepted:'Order accepted',
 trade_filled:'Trade filled', order_failed:'Order failed', take_profit_set:'Take Profit placed', stop_loss_set:'Stop Loss placed',
 exit_rule_failed:'TP / SL placement failed', take_profit_hit:'Take Profit hit', stop_loss_hit:'Stop Loss hit',
 position_reduced:'Position partially closed', trade_closed:'Position closed', order_cancelled:'Order cancelled',
 pnl_updated:'Realized profit / loss confirmed', watcher_status:'Watcher status', exchange_status:'Exchange connection status',
 report:'Trading summary', test:'Test notification'
};
const textTemplate = '{{title}}\nSetup: {{setupName}}\nAccount: {{account}} · {{network}}\nCoin: {{symbol}} · {{side}}\nAmount: {{margin}} · Leverage: {{leverage}}\nPrice: {{price}} · Quantity: {{quantity}}\nTP: {{takeProfit}} · SL: {{stopLoss}}\nProfit/loss: {{pnl}}\nOrder: {{orderId}}\nRepeat: {{repeatProgress}}\nTime: {{time}}\n{{summary}}\n{{error}}';
export const DEFAULTS = {
 enabled:false, scope:'app', accountIds:[], setupIds:[], events:Object.fromEntries(Object.keys(EVENT_LABELS).filter(k=>!['report','test'].includes(k)).map(k=>[k,true])),
 timezone:'Asia/Dubai', countryCode:'971', alertFormat:'text',
 templateEditor:{kind:'trade_filled',format:'text'},
 templates:Object.fromEntries(Object.keys(EVENT_LABELS).map(k=>[k,{text:textTemplate,image:textTemplate,pdf:textTemplate}])),
 designs:{image:{layout:'clean_receipt',title:'Jarvis',accent:'#245be0',background:'#eef4fb',text:'#0f172a'},pdf:{layout:'clean_receipt',title:'Jarvis',accent:'#245be0',background:'#eef4fb',text:'#0f172a'}},
 reports:{enabled:false,time:'20:00',period:'today',format:'pdf',recipientIds:[]}
};
DEFAULTS.templates.report={text:'{{title}}\nTime: {{time}}\n\n{{summary}}',image:'{{title}}\nTime: {{time}}\n\n{{summary}}',pdf:'{{title}}\nTime: {{time}}\n\n{{summary}}'};
const monitoringTemplate='{{title}}\nSetup: {{setupName}}\nTrigger coin: {{triggerSymbol}} · {{timeframe}}\nCondition: {{condition}}\nCurrent value: {{currentValue}}\nMarket price: {{price}}\nTrade coins: {{symbol}} · {{side}}\nAccount: {{account}} · {{network}}\nConfigured margin: {{margin}} · Leverage: {{leverage}}\nTP: {{takeProfit}} · SL: {{stopLoss}}\nTime: {{time}}';
DEFAULTS.templates.monitoring_match={text:monitoringTemplate,image:monitoringTemplate,pdf:monitoringTemplate};
export const settings = userId => {
 const row=waDb.prepare('SELECT data_json FROM jarvis_wa_settings WHERE user_id=?').get(userId);
 const saved=row ? parse(row.data_json) : {};
 const designs=Object.fromEntries(['image','pdf'].map(type=>[type,{...DEFAULTS.designs[type],...(saved.designs?.[type]?{layout:'classic',...saved.designs[type]}:{})}]));
 return {...structuredClone(DEFAULTS),...saved,templateEditor:{...DEFAULTS.templateEditor,format:saved.alertFormat || DEFAULTS.alertFormat,...saved.templateEditor},events:{...DEFAULTS.events,...saved.events},templates:{...structuredClone(DEFAULTS.templates),...saved.templates},designs,reports:{...DEFAULTS.reports,...saved.reports}};
};
export function saveSettings(userId,value) {
 waDb.prepare('INSERT INTO jarvis_wa_settings VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(userId,json(value),now());
 return settings(userId);
}
export const recipients = userId => waDb.prepare('SELECT * FROM jarvis_wa_recipients WHERE user_id=? AND archived=0 ORDER BY rowid').all(userId).map(r=>({...r,enabled:!!r.enabled,accountIds:parse(r.accounts_json)}));
export const runtime = key => parse(waDb.prepare('SELECT data_json FROM jarvis_wa_runtime WHERE key=?').get(key)?.data_json || '{}');
export function saveRuntime(key,value) { waDb.prepare('INSERT INTO jarvis_wa_runtime VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(key,json(value),now()); }
export const connection = userId => waDb.prepare('SELECT status,number,error,updated_at FROM jarvis_wa_connections WHERE user_id=?').get(userId) || {status:'disconnected'};
export function setConnection(userId,status,value={}) {
 const old=connection(userId);
 waDb.prepare('INSERT INTO jarvis_wa_connections VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,number=excluded.number,qr=excluded.qr,error=excluded.error,updated_at=excluded.updated_at').run(userId,status,value.number ?? old.number ?? null,value.qr || null,value.error || null,now());
}
export async function ownedAccounts(userId) {
 const snap=await db.collection('userAccounts').where('userId','==',userId).get();
 return snap.docs.map(x=>({id:x.id,...x.data()}));
}
export async function ownedSetups(userId) {
 const snap=await db.collection('setups').where('userId','==',userId).get();
 return snap.docs.map(x=>({...x.data(),id:x.id}));
}
export const compactAccounts = accounts => accounts.map(a=>({id:a.id,name:a.name,exchange:a.exchangeType,network:a.network,connected:!!a.ping}));
export const eventRows = (userId,start=0,end=now()+1,limit=500) => waDb.prepare('SELECT * FROM jarvis_trade_events WHERE user_id=? AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at DESC LIMIT ?').all(userId,start,end,limit).map(r=>({...r,data:parse(r.data_json),data_json:undefined}));

