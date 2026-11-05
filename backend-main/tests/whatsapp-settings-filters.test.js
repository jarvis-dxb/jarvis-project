import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
process.env.SQLITE_PATH=path.join(mkdtempSync(path.join(os.tmpdir(),'jarvis-wa-filters-')),'test.sqlite');
process.env.AUTH_SECRET='isolated-wa-filter-tests';process.env.SEED_DEMO_USER='false';process.env.WA_WORKER_ENABLED='false';process.env.WATCHER_ENABLED='false';
process.env.ENCRYPTION_KEY='a'.repeat(32);process.env.ENCRYPTION_IV='b'.repeat(16);
const express=(await import('express')).default;
const router=(await import('../src/routes/whatsapp.routes.js')).default;
const {signToken}=await import('../src/utils/jwt.js');
const {db}=await import('../src/config/sqlite.js');
const {waDb,settings,saveSettings,DEFAULTS}=await import('../src/whatsapp/store.js');
const {selected}=await import('../src/whatsapp/events.js');
let server,base;
const headers={'Content-Type':'application/json',Authorization:'Bearer '+signToken({id:'owner-a',role:'user',email:'isolated@example.com'})};
const put=body=>fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify(body)});
before(async()=>{
 const app=express();app.use(express.json());app.use('/wa',router);app.use((error,req,res,next)=>res.status(error.statusCode||400).json({message:error.message}));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port+'/wa';
});
beforeEach(async()=>{
 for(const doc of (await db.collection('setups').get()).docs)await db.collection('setups').doc(doc.id).delete();
 await db.collection('setups').doc('owned-current').set({userId:'owner-a',setupName:'Current setup',margin:66,leverage:13,TP:10,SL:3,triggeredCounter:2,countdown:'00:10:00'});
 await db.collection('setups').doc('foreign-current').set({userId:'owner-b',setupName:'Other owner'});
 saveSettings('owner-a',{...structuredClone(DEFAULTS),enabled:true,setupIds:['deleted-old']});
});
after(async()=>{await new Promise(r=>server.close(r));waDb.close();});

test('deleted retained filters and current owned selections save together without changing trading rules',async()=>{
 const before=(await db.collection('setups').doc('owned-current').get()).data();
 const response=await put({setupIds:['deleted-old','owned-current'],alertFormat:'pdf',events:{take_profit_hit:true}});
 assert.equal(response.status,200);const saved=(await response.json()).data;
 assert.deepEqual(saved.setupIds,['deleted-old','owned-current']);assert.equal(saved.alertFormat,'pdf');assert.equal(saved.events.take_profit_hit,true);
 assert.deepEqual((await db.collection('setups').doc('owned-current').get()).data(),before);
});
test('an entirely deleted saved filter stays restrictive instead of silently becoming all setups',async()=>{
 assert.equal((await put({setupIds:['deleted-old'],alertFormat:'image'})).status,200);
 assert.deepEqual(settings('owner-a').setupIds,['deleted-old']);
 assert.equal(selected(settings('owner-a'),{kind:'trade_filled',source:'app',setup_id:'owned-current',data:{}}),false);
});
test('unrelated template edits preserve stale filters and other formats',async()=>{
 const before=settings('owner-a');
 assert.equal((await put({templates:{trade_filled:{text:'Updated {{symbol}}'}}})).status,200);
 const saved=settings('owner-a');assert.deepEqual(saved.setupIds,before.setupIds);assert.equal(saved.templates.trade_filled.image,before.templates.trade_filled.image);
});
test('new unknown and foreign IDs are rejected without partially saving any settings',async()=>{
 const before=settings('owner-a');
 for(const id of ['never-selected','foreign-current']){
  assert.equal((await put({setupIds:['deleted-old',id],alertFormat:'pdf'})).status,400);
  assert.deepEqual(settings('owner-a'),before);
 }
});
test('a previously stored ID now belonging to another owner is still rejected',async()=>{
 const before=settings('owner-a');saveSettings('owner-a',{...before,setupIds:['foreign-current']});
 const response=await put({setupIds:['foreign-current'],alertFormat:'pdf'});
 assert.equal(response.status,400);assert.match((await response.json()).message,/Uncheck unavailable/);
 assert.equal(settings('owner-a').alertFormat,before.alertFormat);
});
test('clearing the filter is accepted only when the user explicitly submits an empty selection',async()=>{
 assert.equal((await put({setupIds:[]})).status,200);assert.deepEqual(settings('owner-a').setupIds,[]);
 assert.equal(selected(settings('owner-a'),{kind:'trade_filled',source:'app',setup_id:'owned-current',data:{}}),true);
});
test('setup document IDs remain authoritative even if legacy data includes a conflicting id field',async()=>{
 await db.collection('setups').doc('owned-current').update({id:'foreign-current'});
 const loaded=(await(await fetch(base,{headers})).json()).data;
 assert.deepEqual(loaded.setups,[{id:'owned-current',name:'Current setup'}]);
 assert.equal((await put({setupIds:['foreign-current']})).status,400);
 assert.equal((await put({setupIds:['owned-current','owned-current']})).status,200);
 assert.deepEqual(settings('owner-a').setupIds,['owned-current']);
});
test('malformed and oversized selection lists are rejected',async()=>{
 for(const setupIds of ['owned-current',[3],Array(201).fill('owned-current')])assert.equal((await put({setupIds})).status,400);
});
