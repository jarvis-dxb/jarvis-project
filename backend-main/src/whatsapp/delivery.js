import { waDb,settings,recipients,now,parse,safeError } from './store.js';
import { selected, notificationContent } from './events.js';
import { renderMedia } from './media.js';
export async function deliverQueued(socketFor,options={}){
 const row=waDb.prepare("SELECT * FROM jarvis_wa_deliveries WHERE status IN ('queued','pending_connection') AND available_at<=? ORDER BY created_at LIMIT 1").get(now());if(!row)return;
 const s=settings(row.user_id),eventRow=waDb.prepare('SELECT * FROM jarvis_trade_events WHERE id=?').get(row.event_id);
 let event=eventRow?{...eventRow,data:parse(eventRow.data_json)}:null;
 let resolved;
 if(event?.source==='exchange'&&['trade_closed','take_profit_hit','stop_loss_hit','pnl_updated'].includes(event.kind)) {
  resolved=notificationContent(event,s,row.format,parse(row.content_json));event=resolved.event;
 }
 if(event?.kind==='approval_requested') {
  const approval=waDb.prepare('SELECT status,expires_at FROM jarvis_trade_approvals WHERE id=?').get(event.data.approvalId);
  if(!approval||approval.status!=='pending'||approval.expires_at<=now()) {
   waDb.prepare("UPDATE jarvis_wa_deliveries SET status='skipped',error='Approval expired or already decided',updated_at=? WHERE id=?").run(now(),row.id);return;
  }
 }
 const recipient=recipients(row.user_id).find(r=>r.id===row.recipient_id&&r.enabled);
 if(!recipient || !event || (!['test','report'].includes(event.kind)&&(!s.enabled||!s.events[event.kind]||!selected(s,event))) || (recipient.accountIds.length&&event.account_id&&!recipient.accountIds.includes(event.account_id))) {
  waDb.prepare("UPDATE jarvis_wa_deliveries SET status='skipped',error='Recipient or alert disabled',updated_at=? WHERE id=?").run(now(),row.id);return;
 }
 const socket=socketFor(row.user_id);
 if(!socket){waDb.prepare("UPDATE jarvis_wa_deliveries SET status='pending_connection',available_at=?,updated_at=? WHERE id=?").run(now()+10000,now(),row.id);return;}
 // Position polling can beat history recovery by 30 seconds. Do not freeze an
 // empty result into an image: retry without sending or consuming an attempt.
 if(resolved&&!resolved.ready&&event.kind==='trade_closed'&&now()-row.created_at<10*60000) {
  waDb.prepare("UPDATE jarvis_wa_deliveries SET content_json=?,available_at=?,error=?,updated_at=? WHERE id=?").run(JSON.stringify(resolved.content),now()+10000,resolved.reason || 'Waiting for confirmed exchange fills and fees',now(),row.id);return;
 }
 let content;
 try {
  const body=resolved?.content || parse(row.content_json);
  if(resolved)waDb.prepare('UPDATE jarvis_wa_deliveries SET content_json=?,updated_at=? WHERE id=?').run(JSON.stringify(body),now(),row.id);
  if(row.format==='text')content={text:body.text};
  else {const media=await (options.render || renderMedia)(body,row.format);if(media.buffer.length>8*1024*1024)throw Error('Attachment exceeds 8 MB');content=row.format==='pdf'?{document:media.buffer,mimetype:media.mime,fileName:media.filename,caption:body.sample?'TEST — SAMPLE DATA':'Jarvis trading update'}:{image:media.buffer,mimetype:media.mime,caption:body.sample?'TEST — SAMPLE DATA':'Jarvis trading update'};}
 }catch(error){waDb.prepare("UPDATE jarvis_wa_deliveries SET status='failed',error=?,updated_at=? WHERE id=?").run('Not sent: '+safeError(error),now(),row.id);return;}
 // Persist this boundary BEFORE network IO. An uncertain outcome is never auto-sent again.
 const claimed=waDb.prepare("UPDATE jarvis_wa_deliveries SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status IN ('queued','pending_connection')").run(now(),row.id);if(!claimed.changes)return;
 try {
  const jid=recipient.kind==='group'?recipient.address:recipient.address+'@s.whatsapp.net';
  let timer;
  let result;try { result=await Promise.race([socket.sendMessage(jid,content),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('WhatsApp acknowledgement timed out')),options.timeoutMs || 30000)})]); } finally {clearTimeout(timer);}
  const messageId=result?.key?.id || null;
  waDb.prepare('UPDATE jarvis_wa_deliveries SET status=?,message_id=?,error=NULL,updated_at=? WHERE id=?').run(options.receiptStatus?.(messageId)||'submitted',messageId,now(),row.id);
 }catch(error){waDb.prepare("UPDATE jarvis_wa_deliveries SET status='failed',error=?,updated_at=? WHERE id=?").run('Send outcome uncertain: '+safeError(error),now(),row.id);}
}
