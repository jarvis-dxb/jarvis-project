import test,{mock,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
process.env.SQLITE_PATH=path.join(mkdtempSync(path.join(os.tmpdir(),'jarvis-auto-execution-')),'test.sqlite');
process.env.AUTH_SECRET='isolated-watcher-execution-secret';process.env.SEED_DEMO_USER='false';
process.env.ENCRYPTION_KEY='a'.repeat(32);process.env.ENCRYPTION_IV='b'.repeat(16);
process.env.WATCHER_ENABLED='false';process.env.WA_WORKER_ENABLED='false';
// Deliberately unreachable. A regression to the old self-HTTP path must fail.
process.env.SERVER_ORIGIN='http://127.0.0.1:1';
const orders=[];let allRejected=false;
mock.module(new URL('../src/services/exchange.service.js',import.meta.url).href,{namedExports:{executeMarketOrder:async payload=>{
 orders.push(payload);
 return [{account:'account-a',symbol:'BTCUSDT',side:payload.side,success:!allRejected,error:allRejected?'Isolated exchange rejection':undefined,
  order:allRejected?undefined:{id:'entry-a',average:100,amount:1,filled:1,status:'closed'},tpOrder:allRejected?undefined:{id:'tp-a'},slOrder:allRejected?undefined:{id:'sl-a'}}];
}}});
const {db}=await import('../src/config/sqlite.js');
const {waDb}=await import('../src/whatsapp/store.js');
const {createOrder}=await import('../../watcher-main/src/services/api.js');
const {liveSnapshot}=await import('../src/services/watcher-live.service.js');
const {authenticateTradeSource}=await import('../src/middlewares/authenticate.trade.middleware.js');
const {watcherAuthToken}=await import('../src/utils/watcher-auth.js');
const setup={userId:'auto-user',setupName:'Isolated Auto',accounts:['account-a'],triggerSymbol:'BINANCE:BTCUSDT.P',tradingSymbol:['BINANCE:BTCUSDT.P'],timeframe:'1',logicType:'candle_strike',candleRange:2,candleColor:'red',side:'short',margin:'50',leverage:'10',TP:'15',TP_mode:'pnl',SL:'5',SL_mode:'pnl',executionMode:'auto',repeatCounter:4,triggeredCounter:0,isCompleted:false,countdown:'00:01:00'};
const payload=()=>({...setup,id:'setup-a',notificationExecutionId:'signal-'+Date.now()});
beforeEach(async()=>{
 orders.length=0;allRejected=false;
 for(const d of (await db.collection('setups').get()).docs)await db.collection('setups').doc(d.id).delete();
 for(const table of ['jarvis_trade_events','jarvis_trade_order_refs'])waDb.exec('DELETE FROM '+table);
 await db.collection('users').doc(setup.userId).set({role:'user',limitTrades:10});
 await db.collection('userAccounts').doc('account-a').set({userId:setup.userId,name:'Isolated Mainnet',exchangeType:'binance',accountType:'futures',network:'mainnet',ping:true,apiKey:'FAKE-KEY',apiSecret:'FAKE-SECRET'});
 await db.collection('setups').doc('setup-a').set(setup);
 await db.collection('watcherControls').doc(setup.userId).set({monitorOnly:false,paused:false});
 await new Promise(r=>setImmediate(r));
});

test('a genuine watcher dispatch reaches the existing fill/TP/SL/counter path without localhost HTTP',async()=>{
 const result=await createOrder({...payload(),margin:'999',leverage:'100',TP:'999',SL:'999'});
 assert.equal(result.success,true);assert.equal(orders.length,1);
 for(const key of ['margin','leverage','TP','SL','side','tradingSymbol'])assert.deepEqual(orders[0][key],setup[key],'reload saved '+key);
 const saved=(await db.collection('setups').doc('setup-a').get()).data();assert.equal(saved.triggeredCounter,1);
 for(const key of Object.keys(setup).filter(k=>k!=='triggeredCounter'))assert.deepEqual(saved[key],setup[key]);
 assert.equal(waDb.prepare("SELECT count(*) AS n FROM jarvis_trade_events WHERE kind='order_accepted'").get().n,1);
 assert.equal(waDb.prepare("SELECT count(*) AS n FROM jarvis_trade_events WHERE kind IN ('take_profit_set','stop_loss_set')").get().n,2);
 assert.equal(waDb.prepare('SELECT count(*) AS n FROM jarvis_trade_order_refs').get().n,3);
});

test('pause/global monitoring/per-setup monitoring/completed guards still stop automatic orders',async()=>{
 for(const [change,control] of [[{watcherPaused:true},{}],[{}, {paused:true}],[{}, {monitorOnly:true}],[{}, {forceMonitoringOnly:true}],[{executionMode:'monitoring'},{}],[{isCompleted:true},{}]]){
  await db.collection('setups').doc('setup-a').set({...setup,...change});
  await db.collection('watcherControls').doc(setup.userId).set({monitorOnly:false,paused:false,...control});
  const result=await createOrder(payload());assert.equal(result.success,false);assert.equal(orders.length,0);
 }
 assert.equal((await db.collection('setups').doc('setup-a').get()).data().triggeredCounter,0);
});

test('confirmation cannot bypass Yes/No approval and its rejection is visible in watcher activity',async()=>{
 await db.collection('setups').doc('setup-a').update({executionMode:'confirmation'});
 const result=await createOrder(payload());assert.equal(result.success,false);assert.equal(orders.length,0);
 assert.match(result.error,/approval link/);
 const event=(await liveSnapshot(setup.userId)).events.find(e=>e.kind==='order_failed');
 assert.ok(event);assert.match(event.data.error,/approval link/);
 assert.equal((await db.collection('setups').doc('setup-a').get()).data().triggeredCounter,0);
});

test('quota rejection is visible and does not place an order or increment counters',async()=>{
 await db.collection('users').doc(setup.userId).update({limitTrades:1});
 await db.collection('setups').doc('second').set({...setup});await new Promise(r=>setImmediate(r));
 const result=await createOrder(payload());assert.equal(result.success,false);assert.match(result.error,/limit reached/);assert.equal(orders.length,0);
 assert.equal(waDb.prepare("SELECT count(*) AS n FROM jarvis_trade_events WHERE kind='order_failed'").get().n,1);
});

test('per-coin rejections are recorded once with no automatic retry',async()=>{
 allRejected=true;const result=await createOrder(payload());assert.equal(result.success,false);assert.equal(orders.length,1);
 assert.equal(waDb.prepare("SELECT count(*) AS n FROM jarvis_trade_events WHERE kind='order_failed'").get().n,1);
 assert.equal((await db.collection('setups').doc('setup-a').get()).data().triggeredCounter,0);
});

test('in-process dispatch rejects another owner and public HTTP watcher authentication stays strict',async()=>{
 assert.equal((await createOrder({...payload(),userId:'foreign-user'})).success,false);assert.equal(orders.length,0);
 let denied;
 await authenticateTradeSource({get:()=>watcherAuthToken(),socket:{remoteAddress:'203.0.113.20'},body:{id:'setup-a'}},null,error=>{denied=error});
 assert.equal(denied.statusCode,401);
});
