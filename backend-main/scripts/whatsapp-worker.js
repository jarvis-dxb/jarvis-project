import makeWASocket,{useMultiFileAuthState,Browsers} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { WhatsAppConnection } from '../src/whatsapp/connection.js';
import { waDb,settings,recipients,id,now,parse,json,saveRuntime,runtime,setConnection,safeError } from '../src/whatsapp/store.js';
import { databasePath } from '../src/config/sqlite.js';
import { queueEvent,selected } from '../src/whatsapp/events.js';
import { reportEvent } from '../src/whatsapp/templates.js';
import { deliverQueued } from '../src/whatsapp/delivery.js';
import {mediaRendererIdentity} from '../src/whatsapp/render-svg.js';
import {acquireWorkerLease} from '../src/whatsapp/worker-lease.js';
import { monitorTick,stopMonitors } from '../src/whatsapp/monitor.js';
const owner=randomUUID();let stopped=false,shuttingDown=false,busy=false,monitorAt=0;
function lease(){return waDb.prepare("INSERT INTO jarvis_wa_lease VALUES('worker',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE jarvis_wa_lease.expires_at<? OR jarvis_wa_lease.owner=?").run(owner,now()+15000,now(),owner).changes>0;}
await acquireWorkerLease({db:waDb,owner,media:mediaRendererIdentity(),
 cancelled:()=>typeof process.send==='function'&&!process.connected,
 notify:state=>{if(process.connected)process.send?.({type:'whatsapp-worker-lifecycle',state},()=>{});}
});
const receiptCache=new Map();
const connector=new WhatsAppConnection({
 sessionRoot:path.join(path.dirname(databasePath),'whatsapp-sessions'),
 open:async directory=>{
  const {state,saveCreds}=await useMultiFileAuthState(directory);
  const socket=makeWASocket({auth:state,browser:Browsers.ubuntu('Jarvis Trading'),logger:pino({level:'silent'}),markOnlineOnConnect:false,syncFullHistory:false,generateHighQualityLinkPreview:false});
  socket.ev.on('messages.update',updates=>{for(const {key,update}of updates)if(key.id&&update.status>=3) {
   const status=update.status>=4?'read':'delivered';receiptCache.set(key.id,status);
   waDb.prepare("UPDATE jarvis_wa_deliveries SET status=?,updated_at=? WHERE message_id=? AND status IN ('submitted','delivered')").run(status,now(),key.id);
   if(receiptCache.size>1000)receiptCache.delete(receiptCache.keys().next().value);
  }});
  return {socket,saveCreds};
 },
 status:(user,status,values)=>setConnection(user,status,values),
 groups:(user,groups)=>{waDb.exec('BEGIN IMMEDIATE');try{waDb.prepare('DELETE FROM jarvis_wa_groups WHERE user_id=?').run(user);for(const g of groups)waDb.prepare('INSERT INTO jarvis_wa_groups VALUES(?,?,?)').run(user,g.jid,g.name);waDb.exec('COMMIT');}catch(e){waDb.exec('ROLLBACK');throw e;}}
});
waDb.prepare("UPDATE jarvis_wa_commands SET status='failed',error='Worker restarted; try again' WHERE status='processing'").run();
waDb.prepare("UPDATE jarvis_wa_deliveries SET status='failed',error='Send outcome uncertain after worker restart',updated_at=? WHERE status='sending'").run(now());
for(const row of waDb.prepare('SELECT user_id FROM jarvis_wa_connections WHERE status<>?').all('logged_out'))if(connector.hasSession(row.user_id))void connector.connect(row.user_id).catch(()=>{});
async function commandTick(){
 const row=waDb.prepare("UPDATE jarvis_wa_commands SET status='processing' WHERE id=(SELECT id FROM jarvis_wa_commands WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING *").get();if(!row)return;
 try {
  if(row.kind==='connect')await connector.connect(row.user_id);
  else if(row.kind==='disconnect')await connector.logout(row.user_id);
  else if(row.kind==='groups')await connector.refreshGroups(row.user_id);
  else throw Error('Unknown WhatsApp command');
  waDb.prepare("UPDATE jarvis_wa_commands SET status='completed',error=NULL WHERE id=?").run(row.id);
 } catch(error){waDb.prepare("UPDATE jarvis_wa_commands SET status='failed',error=? WHERE id=?").run(safeError(error),row.id);}
}

function scheduleTick(){
 for(const {user_id:user}of waDb.prepare('SELECT user_id FROM jarvis_wa_settings').all()) {
  const s=settings(user);if(!s.reports.enabled||!s.reports.recipientIds.length)continue;
  const local=DateTime.now().setZone(s.timezone),date=local.toISODate();
  const enabledAt=s.trackingSince || now();
  if(local.toFormat('HH:mm')<s.reports.time)continue;
  const scheduled=DateTime.fromISO(date+'T'+s.reports.time,{zone:s.timezone});
  if(scheduled.toMillis()<enabledAt)continue;
  const key='report:'+user+':'+date+':'+s.reports.time,eventId=key;
  if(waDb.prepare('SELECT 1 FROM jarvis_trade_events WHERE event_key=?').get(key))continue;
  const end=s.reports.period==='previous_day'?local.startOf('day'):local,start=s.reports.period==='previous_day'?end.minus({days:1}):s.reports.period==='last_24h'?end.minus({hours:24}):local.startOf('day');
  const event={...reportEvent(user,start.toMillis(),end.toMillis(),s.accountIds),id:id(),user_id:user};
  waDb.exec('BEGIN IMMEDIATE');try{
   waDb.prepare('INSERT INTO jarvis_trade_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.id,user,key,'report',null,null,'report',json(event.data),event.occurred_at,now());
   queueEvent(event,s,s.reports.recipientIds,s.reports.format);waDb.exec('COMMIT');
  }catch(error){waDb.exec('ROLLBACK');throw error;}
 }
}
async function tick(){
 if(busy||stopped)return;busy=true;
 try{
  if(!lease()){stopped=true;throw Error('Worker lease expired');}
  saveRuntime('worker',{online:true,heartbeat:now(),mode:'notifications',media:mediaRendererIdentity()});
  await commandTick();scheduleTick();
  if(now()-monitorAt>10000){monitorAt=now();await monitorTick();}
  await deliverQueued(user=>connector.connected(user),{receiptStatus:messageId=>receiptCache.get(messageId)});
 }catch(error){saveRuntime('worker',{online:!stopped,heartbeat:now(),error:safeError(error),media:mediaRendererIdentity()});}
 finally{busy=false;}
}
const heartbeat=setInterval(()=>{if(!lease())void shutdown();},5000),timer=setInterval(tick,1200);void tick();
async function shutdown(){if(shuttingDown)return;shuttingDown=true;stopped=true;clearInterval(timer);clearInterval(heartbeat);await connector.close();await stopMonitors();saveRuntime('worker',{online:false,heartbeat:now()});waDb.prepare('DELETE FROM jarvis_wa_lease WHERE owner=?').run(owner);process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
process.on('disconnect',shutdown);

