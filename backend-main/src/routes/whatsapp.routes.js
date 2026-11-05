import express from 'express';
import QRCode from 'qrcode';
import { DateTime } from 'luxon';
import { authenticateUser } from '../middlewares/index.js';
import { errors } from '../utils/index.js';
import { waDb,settings,saveSettings,connection,recipients,ownedAccounts,ownedSetups,compactAccounts,eventRows,runtime,id,now,json,EVENT_LABELS,DEFAULTS } from '../whatsapp/store.js';
import { FIELDS,sampleEvent,renderTemplate,reportEvent } from '../whatsapp/templates.js';
import { queueEvent } from '../whatsapp/events.js';
import { renderMedia } from '../whatsapp/media.js';
import {mediaRendererIdentity} from '../whatsapp/render-svg.js';
import { receiptData } from '../whatsapp/receipt.js';
import { db } from '../config/sqlite.js';
import { validateSetupSelections } from '../whatsapp/setup-selections.js';
const router=express.Router();router.use(authenticateUser);
const wrap=handler=>async(req,res,next)=>{try{await handler(req,res);}catch(error){next(error.statusCode ? error : errors.badRequest(error.message));}};
const send=(res,data)=>res.json({status:'success',data});
const fail=message=>{throw errors.badRequest(message);};
const ownIds=(values,allowed,label)=>{
 if(!Array.isArray(values)||values.length>200||values.some(x=>typeof x!=='string'||!allowed.includes(x))) fail('Choose your own '+label+'.');
 return [...new Set(values)];
};
const format=value=>{if(!['text','image','pdf'].includes(value))fail('Choose text, image or PDF.');return value;};
async function validateSettings(value,current,accounts,setups,recipientRows) {
 const next=structuredClone(current);
 for(const key of ['enabled']) if(key in value) {if(typeof value[key]!=='boolean')fail('Invalid '+key);next[key]=value[key];}
 if('scope' in value) {if(!['app','all'].includes(value.scope))fail('Invalid trade scope');next.scope=value.scope;}
 if('accountIds' in value)next.accountIds=ownIds(value.accountIds,accounts.map(x=>x.id),'exchange accounts');
 if('setupIds' in value)next.setupIds=await validateSetupSelections(value.setupIds,{
  ownedIds:setups.map(x=>x.id),previousIds:current.setupIds,
  exists:async setupId=>(await db.collection('setups').doc(setupId).get()).exists,
 });
 if('timezone' in value) {if(typeof value.timezone!=='string'||!DateTime.now().setZone(value.timezone).isValid)fail('Invalid timezone');next.timezone=value.timezone;}
 if('countryCode' in value) {if(!/^[1-9]\d{0,2}$/.test(value.countryCode))fail('Invalid country code');next.countryCode=value.countryCode;}
 if('alertFormat' in value)next.alertFormat=format(value.alertFormat);
 if('templateEditor' in value) {
  const editor=value.templateEditor;
  if(!editor||typeof editor!=='object'||Array.isArray(editor))fail('Invalid template editor preference');
  const kind=editor.kind ?? next.templateEditor.kind;
  if(typeof kind!=='string'||!(kind in EVENT_LABELS))fail('Choose a valid event template');
  next.templateEditor={kind,format:format(editor.format ?? next.templateEditor.format)};
 }
 if(value.events) {for(const [key,enabled] of Object.entries(value.events)) {if(!(key in DEFAULTS.events)||typeof enabled!=='boolean')fail('Invalid alert event');next.events[key]=enabled;}}
 if(value.templates) {
  for(const [kind,templates] of Object.entries(value.templates)) {
   if(!(kind in EVENT_LABELS)||!templates||typeof templates!=='object')fail('Invalid template');
   for(const [type,text] of Object.entries(templates)) {
    format(type);if(typeof text!=='string'||!text.trim()||text.length>12000)fail('Template must have 1–12000 characters');
    for(const match of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g))if(!FIELDS.includes(match[1]))fail('Unknown placeholder: '+match[1]);
    next.templates[kind]={...next.templates[kind],[type]:text};
   }
  }
 }
 if(value.designs)for(const [type,design]of Object.entries(value.designs)) {
  if(!['image','pdf'].includes(type))fail('Invalid report design');
  next.designs[type]={...next.designs[type]};
  if('layout'in design){if(!['clean_receipt','classic'].includes(design.layout))fail('Invalid template layout');next.designs[type].layout=design.layout;}
  if('title'in design){if(typeof design.title!=='string'||design.title.length>120)fail('Title is too long');next.designs[type].title=design.title;}
  for(const key of ['accent','background','text'])if(key in design){if(!/^#[\da-f]{6}$/i.test(design[key]))fail('Use a six-digit hex color');next.designs[type][key]=design[key];}
 }
 if(value.reports) {
  const r=value.reports;
  if('enabled'in r){if(typeof r.enabled!=='boolean')fail('Invalid schedule switch');next.reports.enabled=r.enabled;}
  if('time'in r){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time))fail('Invalid send time');next.reports.time=r.time;}
  if('period'in r){if(!['today','previous_day','last_24h'].includes(r.period))fail('Invalid report period');next.reports.period=r.period;}
  if('format'in r)next.reports.format=format(r.format);
  if('recipientIds'in r)next.reports.recipientIds=ownIds(r.recipientIds,recipientRows.map(x=>x.id),'recipients');
 }
 if(!current.trackingSince && (next.enabled||next.reports.enabled))next.trackingSince=now();
 return next;
}
router.get('/',wrap(async(req,res)=>{
 const user=req.user.id,[accounts,setups]=await Promise.all([ownedAccounts(user),ownedSetups(user)]);
 const c=connection(user),qr=waDb.prepare('SELECT qr FROM jarvis_wa_connections WHERE user_id=?').get(user)?.qr;
 const queue=waDb.prepare('SELECT status,count(*) AS count FROM jarvis_wa_deliveries WHERE user_id=? GROUP BY status').all(user);
 const media=mediaRendererIdentity();
 send(res,{settings:settings(user),connection:{...c,qrDataUrl:qr?await QRCode.toDataURL(qr,{width:280,margin:2}):null},groups:waDb.prepare('SELECT jid,name FROM jarvis_wa_groups WHERE user_id=? ORDER BY name').all(user),recipients:recipients(user),accounts:compactAccounts(accounts),setups:setups.map(s=>({id:s.id,name:s.setupName})),eventLabels:EVENT_LABELS,templateDefaults:DEFAULTS.templates,designDefaults:DEFAULTS.designs,placeholders:FIELDS,queue,media,worker:runtime('worker'),monitors:runtime('monitor:'+user),watcher:runtime('watcher')});
}));
router.put('/settings',wrap(async(req,res)=>{const user=req.user.id;const [accounts,setups]=await Promise.all([ownedAccounts(user),ownedSetups(user)]);const validated=await validateSettings(req.body||{},settings(user),accounts,setups,recipients(user));send(res,saveSettings(user,validated));}));
router.post('/connection/:action',wrap(async(req,res)=>{
 if(!['connect','disconnect','groups'].includes(req.params.action))fail('Invalid connection action');
 const user=req.user.id;
 if(req.params.action==='groups'&&connection(user).status!=='connected')fail('Connect WhatsApp before refreshing groups');
 const existing=waDb.prepare("SELECT id FROM jarvis_wa_commands WHERE user_id=? AND kind=? AND status IN ('queued','processing')").get(user,req.params.action);
 if(existing)return send(res,{commandId:existing.id});
 const command=id();waDb.prepare('INSERT INTO jarvis_wa_commands(id,user_id,kind,created_at) VALUES(?,?,?,?)').run(command,user,req.params.action,now());send(res,{commandId:command});
}));
router.post('/recipients',wrap(async(req,res)=>{
 const user=req.user.id,{kind,address,label,accountIds=[]}=req.body||{};
 if(!['individual','group'].includes(kind))fail('Choose number or group');
 let normalized=String(address||'').trim();
 if(kind==='individual'){normalized=normalized.replace(/[^\d+]/g,'');if(normalized.startsWith('+'))normalized=normalized.slice(1);else if(normalized.startsWith('00'))normalized=normalized.slice(2);else if(normalized.startsWith('0'))normalized=settings(user).countryCode+normalized.slice(1);if(!/^[1-9]\d{7,14}$/.test(normalized))fail('Enter a WhatsApp number with country code');}
 else if(!waDb.prepare('SELECT 1 FROM jarvis_wa_groups WHERE user_id=? AND jid=?').get(user,normalized))fail('Choose a group from your connected WhatsApp');
 const routing=ownIds(accountIds,(await ownedAccounts(user)).map(x=>x.id),'exchange accounts');
 if(typeof label!=='string'||label.length>100)fail('Enter a label under 100 characters');
 waDb.prepare('INSERT INTO jarvis_wa_recipients(id,user_id,kind,address,label,accounts_json) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,kind,address) DO UPDATE SET archived=0,enabled=1,label=excluded.label,accounts_json=excluded.accounts_json').run(id(),user,kind,normalized,label.trim()||normalized,json(routing));
 send(res,recipients(user));
}));
router.patch('/recipients/:id',wrap(async(req,res)=>{
 const user=req.user.id,r=recipients(user).find(r=>r.id===req.params.id);if(!r)throw errors.notFound('Recipient not found');
 const enabled=req.body.enabled ?? r.enabled;if(typeof enabled!=='boolean')fail('Invalid recipient switch');
 const accountIds=ownIds(req.body.accountIds ?? r.accountIds,(await ownedAccounts(user)).map(x=>x.id),'exchange accounts');
 waDb.prepare('UPDATE jarvis_wa_recipients SET enabled=?,accounts_json=? WHERE id=? AND user_id=?').run(enabled?1:0,json(accountIds),r.id,user);send(res,recipients(user));
}));
router.delete('/recipients/:id',wrap(async(req,res)=>{waDb.prepare('UPDATE jarvis_wa_recipients SET enabled=0,archived=1 WHERE user_id=? AND id=?').run(req.user.id,req.params.id);send(res,recipients(req.user.id));}));
router.post('/preview',wrap(async(req,res)=>{
 const type=format(req.body.format||'text'),kind=req.body.kind||'trade_filled';if(!(kind in EVENT_LABELS))fail('Invalid preview event');
 const s=settings(req.user.id),template=req.body.template || s.templates[kind][type];
 if(typeof template!=='string'||template.length>12000)fail('Invalid template');
 const event=kind==='report'?reportEvent(req.user.id,now()-86400000,now()):sampleEvent(kind);
 const text=renderTemplate(template,event,s.timezone);
 if(type==='text')return send(res,{text,sample:kind!=='report'});
 const design=req.body.design||s.designs[type];
 if(design?.layout!==undefined&&!['clean_receipt','classic'].includes(design.layout))fail('Invalid preview layout');
 if(design?.title !== undefined && (typeof design.title!=='string'||design.title.length>120))fail('Preview title must be under 120 characters');
 for(const color of ['accent','background','text'])if(design?.[color]&&!/^#[\da-f]{6}$/i.test(design[color]))fail('Invalid preview color');
 const receipt=receiptData(event,s.timezone);
 if(kind==='report'||template!==DEFAULTS.templates[kind][type])receipt.extraText=text;
 if(receipt.note&&receipt.extraText.includes(receipt.note))receipt.note='';
 const media=await renderMedia({text,design,receipt,sample:kind!=='report'},type);
 const renderer=mediaRendererIdentity();
 res.type(media.mime).set('Content-Disposition','inline; filename="'+media.filename+'"').set('X-Jarvis-Media-Engine',renderer.engine).set('X-Jarvis-Media-Build',renderer.build).send(media.buffer);
}));
router.post('/test',wrap(async(req,res)=>{
 const user=req.user.id,r=recipients(user).find(x=>x.id===req.body.recipientId&&x.enabled);
 if(!r)fail('Choose one enabled recipient');if(connection(user).status!=='connected')fail('Connect WhatsApp before sending a test');
 const event={...sampleEvent('test'),id:id(),user_id:user,kind:'test'};
 waDb.prepare('INSERT INTO jarvis_trade_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.id,user,event.id,'test',null,null,'sample',json(event.data),event.occurred_at,now());
 queueEvent(event,settings(user),[r.id],format(req.body.format||'text'));send(res,{queued:true});
}));
router.post('/reports/send',wrap(async(req,res)=>{
 const user=req.user.id,s=settings(user),list=ownIds(req.body.recipientIds||[],recipients(user).filter(r=>r.enabled).map(r=>r.id),'enabled recipients');
 if(!list.length)fail('Select report recipients');
 const start=DateTime.fromISO(String(req.body.from),{zone:s.timezone}),end=DateTime.fromISO(String(req.body.to),{zone:s.timezone}).plus({days:1}).startOf('day');
 if(!start.isValid||!end.isValid||start>=end||end.diff(start,'days').days>366)fail('Choose a valid date range up to 366 days');
 const event={...reportEvent(user,start.toMillis(),end.toMillis(),s.accountIds),id:id(),user_id:user};
 waDb.prepare('INSERT INTO jarvis_trade_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.id,user,event.id,'report',null,null,'report',json(event.data),event.occurred_at,now());
 queueEvent(event,s,list,format(req.body.format||s.reports.format));send(res,{queued:true});
}));
router.get('/history',wrap(async(req,res)=>{
 const user=req.user.id;
 send(res,{events:eventRows(user,0,now()+1,100),deliveries:waDb.prepare('SELECT d.id,d.event_id,d.format,d.status,d.attempts,d.message_id,d.error,d.created_at,d.updated_at,r.label,r.address FROM jarvis_wa_deliveries d LEFT JOIN jarvis_wa_recipients r ON r.id=d.recipient_id WHERE d.user_id=? ORDER BY d.created_at DESC LIMIT 100').all(user),commands:waDb.prepare('SELECT id,kind,status,error,created_at FROM jarvis_wa_commands WHERE user_id=? ORDER BY created_at DESC LIMIT 15').all(user)});
}));
router.post('/history/:id/retry',wrap(async(req,res)=>{
 const d=waDb.prepare('SELECT * FROM jarvis_wa_deliveries WHERE id=? AND user_id=?').get(req.params.id,req.user.id);
 if(!d||d.status!=='failed'||d.error?.includes('uncertain'))fail('Only confirmed unsent failures can be retried');
 waDb.prepare("UPDATE jarvis_wa_deliveries SET status='queued',error=NULL,available_at=?,updated_at=? WHERE id=?").run(now(),now(),d.id);send(res,{queued:true});
}));
export default router;

