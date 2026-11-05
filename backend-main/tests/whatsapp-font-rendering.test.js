import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
process.env.SQLITE_PATH=path.join(mkdtempSync(path.join(tmpdir(),'jarvis-font-delivery-')),'test.sqlite');
process.env.AUTH_SECRET='isolated-font-delivery-test-secret';
process.env.ENCRYPTION_KEY='a'.repeat(32);process.env.ENCRYPTION_IV='b'.repeat(16);
process.env.SEED_DEMO_USER='false';process.env.WA_WORKER_ENABLED='false';process.env.WATCHER_ENABLED='false';
const {svgPng}=await import('../src/whatsapp/render-svg.js');
const {renderMedia}=await import('../src/whatsapp/media.js');
const {waDb,DEFAULTS,saveSettings,settings}=await import('../src/whatsapp/store.js');
const {recordEvent,queueEvent}=await import('../src/whatsapp/events.js');
const {deliverQueued}=await import('../src/whatsapp/delivery.js');
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
const svg=(text,weight=400)=>`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="white"/><text x="10" y="60" font-family="DejaVu Sans" font-size="48" font-weight="${weight}" fill="black">${text}</text></svg>`;

test('explicit font bytes render actual distinct letters/digits and both font weights, not missing-glyph boxes',async()=>{
 const images=await Promise.all([...'AB0123456789'].map(character=>svgPng(svg(character))));
 assert.equal(new Set(images.map(digest)).size,12);
 assert.notEqual(digest(await svgPng(svg('A',400))),digest(await svgPng(svg('A',700))));
 const {data}=await sharp(images[0]).removeAlpha().raw().toBuffer({resolveWithObject:true});
 assert.ok(data.filter(value=>value<100).length>100,'text must contain visible ink');
});

test('a fresh worker with a different cwd and broken/missing system-font configuration produces identical glyphs',async()=>{
 const env={...process.env,FONTCONFIG_FILE:'/missing/fonts.conf',FONTCONFIG_PATH:'/missing',HOME:mkdtempSync(path.join(tmpdir(),'empty-font-home-'))};
 delete env.NODE_TEST_CONTEXT;
 const code=`import {svgPng} from ${JSON.stringify(new URL('../src/whatsapp/render-svg.js',import.meta.url).href)};import {createHash} from 'node:crypto';console.log(createHash('sha256').update(await svgPng(${JSON.stringify(svg('A'))})).digest('hex'));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:tmpdir(),env,encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),digest(await svgPng(svg('A'))));
});

test('queued IMAGE/PDF delivery sends the rendered bytes and matching MIME, without contacting WhatsApp or placing trades',async()=>{
 const user='font-sample';const s=saveSettings(user,{...structuredClone(DEFAULTS),enabled:true});
 waDb.prepare('INSERT INTO jarvis_wa_recipients(id,user_id,kind,address,label) VALUES(?,?,?,?,?)').run('fake-recipient',user,'individual','000000','Isolated mock recipient');
 const before=JSON.stringify(settings(user));
 for(const format of ['image','pdf']){
  const event=recordEvent(user,'font-'+format,'test',{summary:'SAMPLE DATA - no real trade',symbol:'BTCUSDT',side:'long',margin:50,leverage:10},{source:'sample',skipDelivery:true});
  queueEvent(event,s,null,format);
  const row=waDb.prepare("SELECT * FROM jarvis_wa_deliveries WHERE status='queued'").get();
  const expected=await renderMedia(JSON.parse(row.content_json),format);
  const calls=[];
  const socket={sendMessage:async(jid,content)=>{calls.push({jid,content});return {key:{id:'mock-'+format}}}};
  await deliverQueued(()=>socket);await deliverQueued(()=>socket);assert.equal(calls.length,1);
  const payload=calls[0].content;
  if(format==='image'){
   assert.equal(payload.mimetype,'image/png');assert.deepEqual(payload.image,expected.buffer);
   assert.equal((await sharp(payload.image).metadata()).width,1000);
  }else{
   assert.equal(payload.mimetype,'application/pdf');assert.match(payload.document.subarray(0,5).toString(),/%PDF-/);
   assert.equal((await PDFDocument.load(payload.document)).getPageCount(),1);assert.equal(payload.fileName,'jarvis-report.pdf');
  }
  assert.match(payload.caption,/SAMPLE DATA/);
  assert.equal(waDb.prepare('SELECT status FROM jarvis_wa_deliveries WHERE id=?').get(row.id).status,'submitted');
 }
 assert.equal(JSON.stringify(settings(user)),before);
 assert.equal(waDb.prepare("SELECT count(*) AS n FROM documents WHERE collection_name='setups'").get().n,0);
});
