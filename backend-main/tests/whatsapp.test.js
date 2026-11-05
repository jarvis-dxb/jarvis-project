import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-whatsapp-test-'));
process.env.SQLITE_PATH=path.join(folder,'tests.sqlite');process.env.SEED_DEMO_USER='false';process.env.WA_WORKER_ENABLED='false';process.env.AUTH_SECRET='jarvis-isolated-test-secret';
const store=await import('../src/whatsapp/store.js');
const {recordEvent,queueEvent,captureAppEvent}=await import('../src/whatsapp/events.js');
const {ingestFill,ingestPositions,fillBackfill}=await import('../src/whatsapp/monitor.js');
const {sampleEvent,renderTemplate,snapshotReport,reportEvent}=await import('../src/whatsapp/templates.js');
const {deliverQueued}=await import('../src/whatsapp/delivery.js');
const {renderMedia}=await import('../src/whatsapp/media.js');
const {db}=await import('../src/config/sqlite.js');
const {waDb,DEFAULTS,saveSettings,id,json,now}=store;
const account={id:'account-a',name:'Account A',network:'testnet',exchangeType:'binance'};
function config(user='user-a',patch={}){return saveSettings(user,{...structuredClone(DEFAULTS),enabled:true,scope:'all',trackingSince:1000,...patch});}
function addRecipient(user='user-a',label='My phone',accounts=[]){const rid=id();waDb.prepare('INSERT INTO jarvis_wa_recipients(id,user_id,kind,address,label,accounts_json) VALUES(?,?,?,?,?,?)').run(rid,user,'individual','971501234567',label,json(accounts));return rid;}
function count(table){return Number(waDb.prepare('SELECT count(*) AS n FROM '+table).get().n);}
beforeEach(()=>{for(const table of ['jarvis_wa_settings','jarvis_wa_recipients','jarvis_trade_events','jarvis_wa_deliveries','jarvis_trade_order_refs','jarvis_wa_runtime','jarvis_wa_groups','jarvis_wa_connections'])waDb.exec('DELETE FROM '+table);config();});
test('duplicate event is queued once; repeated executions remain distinct',()=>{
 addRecipient();recordEvent('user-a','order:1','order_accepted',{accountId:'account-a'});recordEvent('user-a','order:1','order_accepted',{accountId:'account-a'});recordEvent('user-a','order:2','order_accepted',{accountId:'account-a'});
 assert.equal(count('jarvis_trade_events'),2);assert.equal(count('jarvis_wa_deliveries'),2);
});
test('filters and recipient routing keep account updates private',()=>{
 addRecipient('user-a','A only',['account-a']);config('user-a',{accountIds:['account-a']});recordEvent('user-a','b','trade_filled',{accountId:'account-b'},{source:'exchange'});recordEvent('user-a','a','trade_filled',{accountId:'account-a'},{source:'exchange'});
 assert.equal(count('jarvis_trade_events'),2);assert.equal(count('jarvis_wa_deliveries'),1);
});
test('disabled notifications record events without sending them',()=>{addRecipient();config('user-a',{enabled:false});recordEvent('user-a','x','order_failed',{error:'Rejected'});assert.equal(count('jarvis_trade_events'),1);assert.equal(count('jarvis_wa_deliveries'),0);});
test('confirmed partial fills use fill ids and exclude historical fills',()=>{
 addRecipient();const f={id:'fill-1',order:'order-1',timestamp:2000,symbol:'BTC/USDT:USDT',side:'buy',price:'100',amount:'0.1',info:{realizedPnl:'1.20'},fee:{cost:'0.10',currency:'USDT'}};
 ingestFill('user-a',account,f);ingestFill('user-a',account,f);ingestFill('user-a',account,{...f,id:'fill-2'});ingestFill('user-a',account,{...f,id:'old-fill',timestamp:100});
 assert.equal(count('jarvis_trade_events'),4);assert.equal(count('jarvis_wa_deliveries'),4);assert.equal(snapshotReport('user-a',0,3000).gross,'2.4000');assert.equal(snapshotReport('user-a',0,3000).fees,'0.2000');
});
test('same exchange fill id on different symbols is not lost',()=>{
 addRecipient();const fill={id:'42',order:'5',timestamp:2000,side:'buy',amount:'1'};
 ingestFill('user-a',account,{...fill,symbol:'BTC/USDT:USDT'});ingestFill('user-a',account,{...fill,symbol:'ETH/USDT:USDT'});
 assert.equal(count('jarvis_trade_events'),2);assert.equal(count('jarvis_wa_deliveries'),2);
});
test('realized PnL alerts remain independent of the fill notification switch',()=>{
 addRecipient();config('user-a',{events:{...DEFAULTS.events,trade_filled:false}});
 ingestFill('user-a',account,{id:'close',order:'order',timestamp:2000,symbol:'BTCUSDT',info:{realizedPnl:'3.25'}});
 assert.equal(count('jarvis_trade_events'),2);
 assert.equal(count('jarvis_wa_deliveries'),1);
 assert.equal(snapshotReport('user-a',0,3000).gross,'3.2500');
});
test('Binance recovery paginates income and discovers closed manual-trade symbols',async()=>{
 const at=now()-10*86400000;config('user-a',{trackingSince:at});let incomePages=[],tradeRequests=[];
 const exchange={
  fapiPrivateGetIncome:async params=>{incomePages.push(params);return params.page===1?Array.from({length:1000},()=>({symbol:'BTCUSDT'})):[{symbol:'ETHUSDT'}];},
  fapiPrivateGetUserTrades:async params=>{tradeRequests.push(params);return [{id:'1',orderId:'1',time:at+100,symbol:params.symbol,side:'BUY',price:'1',qty:'1',realizedPnl:'0',commission:'0',commissionAsset:'USDT'}];}
 };
 await fillBackfill({userId:'user-a',account,exchange},[]);
 assert.deepEqual(incomePages.map(p=>p.page),[1,2]);
 assert.equal(incomePages[0].startTime,at);assert.equal(incomePages[0].endTime,at+3600000);
 assert.deepEqual(tradeRequests.map(p=>p.symbol),['BTCUSDT','ETHUSDT']);
 assert.equal(count('jarvis_trade_events'),2);assert.equal(store.runtime('fill-cursor:account-a').at,at+3600000);
});
test('Bybit recovery does not advance a failed cursor and rejects older PnL revisions',async()=>{
 const at=now()-10000;config('user-a',{trackingSince:at});const bybit={...account,exchangeType:'bybit'};
 const exchange={privateGetV5ExecutionList:async()=>({result:{list:[]}}),privateGetV5PositionClosedPnl:async()=>{throw Error('Read failed');}};
 await assert.rejects(fillBackfill({userId:'user-a',account:bybit,exchange},[]));assert.equal(store.runtime('fill-cursor:account-a').at,undefined);
 store.saveRuntime('pnl:account-a:BTCUSDT:10',{value:'12',updatedAt:at+2000});
 exchange.privateGetV5PositionClosedPnl=async()=>({result:{list:[{orderId:'10',symbol:'BTCUSDT',closedPnl:'10',updatedTime:at+1000}]}});
 await fillBackfill({userId:'user-a',account:bybit,exchange},[]);assert.equal(count('jarvis_trade_events'),0);assert.equal(store.runtime('pnl:account-a:BTCUSDT:10').value,'12');
});
test('high-volume recovery shrinks its window rather than dropping unpaged trades',async()=>{
 const at=now()-10000;config('user-a',{trackingSince:at});
 const exchange={privateGetV5ExecutionList:async()=>({result:{list:[],nextPageCursor:'more'}})};
 await assert.rejects(fillBackfill({userId:'user-a',account:{...account,exchangeType:'bybit'},exchange},[]),/smaller window/);
 const cursor=store.runtime('fill-cursor:account-a');assert.equal(cursor.at,at);assert.equal(cursor.windowMs,1800000);
});
test('position baseline does not invent a close; reductions and closes are distinct',()=>{
 addRecipient();const position={symbol:'BTC/USDT:USDT',side:'long',contracts:2};
 ingestPositions('user-a',account,[position]);assert.equal(count('jarvis_trade_events'),0);
 ingestPositions('user-a',account,[{...position,contracts:1}]);ingestPositions('user-a',account,[{...position,contracts:0}]);
 assert.deepEqual(waDb.prepare('SELECT kind FROM jarvis_trade_events ORDER BY created_at,rowid').all().map(r=>r.kind),['position_reduced','trade_closed']);
});
test('a position omitted by a complete exchange snapshot is recognized as closed',()=>{
 addRecipient();ingestPositions('user-a',account,[{symbol:'BTC/USDT:USDT',side:'long',contracts:1}]);
 ingestPositions('user-a',account,[],{complete:false});assert.equal(count('jarvis_trade_events'),0);
 ingestPositions('user-a',account,[]);assert.equal(waDb.prepare('SELECT kind FROM jarvis_trade_events').get().kind,'trade_closed');
});
test('report routing rebuilds a recipient-specific account summary',()=>{
 addRecipient('user-a','A only',['account-a']);
 recordEvent('user-a','pnl-a','pnl_updated',{accountId:'account-a',account:'Account A',pnl:'10',currency:'USDT',pnlIncludesFees:true},{at:2000,source:'exchange'});
 recordEvent('user-a','pnl-b','pnl_updated',{accountId:'account-b',account:'PRIVATE B',pnl:'999',currency:'USDT',pnlIncludesFees:true},{at:2000,source:'exchange'});
 waDb.exec('DELETE FROM jarvis_wa_deliveries');
 const event={...reportEvent('user-a',1000,3000),id:id(),user_id:'user-a'};queueEvent(event,store.settings('user-a'));
 const content=JSON.parse(waDb.prepare('SELECT content_json FROM jarvis_wa_deliveries').get().content_json);
 assert.ok(content.text.includes('Account A'));assert.ok(!content.text.includes('PRIVATE B'));assert.ok(!content.text.includes('999'));
});
test('Bybit reported net corrections are counted once and identified separately',()=>{
 recordEvent('user-a','pnl-1','pnl_updated',{accountId:'a',account:'Bybit',pnl:'10',deltaPnl:'10',currency:'USDT',pnlIncludesFees:true},{at:2000});
 recordEvent('user-a','pnl-2','pnl_updated',{accountId:'a',account:'Bybit',pnl:'12',deltaPnl:'2',currency:'USDT',pnlIncludesFees:true},{at:2100});
 const report=reportEvent('user-a',1000,3000);assert.ok(report.data.summary.includes('Bybit · USDT (net, exchange reported): 12'));
 assert.equal(report.data.pnl,null);assert.ok(renderTemplate('{{pnl}}',report,'Asia/Dubai').includes('account breakdown'));
});
test('disconnected delivery remains durable and submits after reconnect',async()=>{
 addRecipient();recordEvent('user-a','a','order_accepted',{symbol:'BTCUSDT'});await deliverQueued(()=>null);
 assert.equal(waDb.prepare('SELECT status FROM jarvis_wa_deliveries').get().status,'pending_connection');
 waDb.prepare('UPDATE jarvis_wa_deliveries SET available_at=0').run();let calls=0;
 await deliverQueued(()=>({sendMessage:async(jid,body)=>{calls++;assert.equal(jid,'971501234567@s.whatsapp.net');assert.ok(body.text.includes('BTCUSDT'));return {key:{id:'wa-msg-1'}};}}));
 assert.equal(calls,1);assert.equal(waDb.prepare('SELECT status FROM jarvis_wa_deliveries').get().status,'submitted');
 await deliverQueued(()=>({sendMessage:()=>{throw Error('Duplicate send')}}));assert.equal(calls,1);
});
test('uncertain send failure is not auto-retried',async()=>{
 addRecipient();recordEvent('user-a','a','order_failed',{error:'Failed'});
 await deliverQueued(()=>({sendMessage:async()=>{throw Error('Connection lost after write');}}));
 const row=waDb.prepare('SELECT status,error,attempts FROM jarvis_wa_deliveries').get();assert.equal(row.status,'failed');assert.ok(row.error.includes('uncertain'));assert.equal(row.attempts,1);
 await deliverQueued(()=>({sendMessage:()=>{throw Error('Must not resend')}}));
});
test('timed-out WhatsApp send releases the queue without retrying uncertain delivery',async()=>{
 addRecipient();recordEvent('user-a','a','trade_filled',{});
 await deliverQueued(()=>({sendMessage:()=>new Promise(()=>{})}),{timeoutMs:15});assert.ok(waDb.prepare('SELECT error FROM jarvis_wa_deliveries').get().error.includes('uncertain'));
});
test('disabled recipient cannot receive an already queued message',async()=>{
 const rid=addRecipient();recordEvent('user-a','a','trade_filled',{});waDb.prepare('UPDATE jarvis_wa_recipients SET enabled=0 WHERE id=?').run(rid);
 await deliverQueued(()=>({sendMessage:()=>{throw Error('Must not send')}}));assert.equal(waDb.prepare('SELECT status FROM jarvis_wa_deliveries').get().status,'skipped');
});
test('image and PDF previews render usable artifacts without executing supplied markup',async()=>{
 const content={text:'SAMPLE DATA\n<script>alert(1)</script>\nBTCUSDT fill',design:DEFAULTS.designs.image};
 const png=await renderMedia(content,'image'),pdf=await renderMedia({...content,design:DEFAULTS.designs.pdf},'pdf');
 assert.equal(png.buffer.subarray(1,4).toString(),'PNG');assert.equal(pdf.buffer.subarray(0,4).toString(),'%PDF');
 assert.ok(renderTemplate('{{title}} {{symbol}}',sampleEvent('trade_filled'),'Asia/Dubai').includes('BTCUSDT'));
});

test('new image/PDF defaults use Clean Receipt without changing legacy customized designs',()=>{
 assert.equal(store.settings('new-user').designs.image.layout,'clean_receipt');assert.equal(store.settings('new-user').designs.pdf.layout,'clean_receipt');
 store.saveSettings('legacy-user',{designs:{image:{title:'Custom',background:'#112233',text:'#ffffff'}}});
 assert.equal(store.settings('legacy-user').designs.image.layout,'classic');assert.equal(store.settings('legacy-user').designs.image.title,'Custom');
 assert.equal(store.settings('legacy-user').designs.pdf.layout,'clean_receipt');
});
test('app execution captures every account/symbol result and TP/SL failures',async()=>{
 await db.collection('userAccounts').doc('account-a').set({userId:'user-a',name:'A',network:'testnet'});
 addRecipient();
 await captureAppEvent({userId:'user-a',type:'trade_executed',executionId:'x',setup:{id:'setup-a',margin:'50',leverage:'10'},results:[{account:'account-a',symbol:'BTCUSDT',success:true,order:{id:'o1'},tpOrder:{id:'tp1'},slError:'Invalid SL'},{account:'account-a',symbol:'ETHUSDT',success:false,error:'Rejected'}]});
 const kinds=waDb.prepare('SELECT kind FROM jarvis_trade_events').all().map(r=>r.kind);
 assert.deepEqual(kinds.sort(),['order_accepted','take_profit_set','exit_rule_failed','order_failed'].sort());
 assert.equal(count('jarvis_trade_order_refs'),2);
});
test('authenticated routes reject cross-user recipients/settings and isolate templates',async()=>{
 const express=(await import('express')).default;
 const router=(await import('../src/routes/whatsapp.routes.js')).default;
 const {signToken}=await import('../src/utils/jwt.js');
 const app=express();app.use(express.json());app.use('/api',router);app.use((error,req,res,next)=>res.status(error.statusCode||400).json({message:error.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port+'/api';
 const token=signToken({id:'user-a',email:'test@example.com',role:'user'}),headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
 try{
  assert.equal((await fetch(base)).status,401);
  assert.equal((await fetch(base+'/recipients',{method:'POST',headers,body:JSON.stringify({kind:'group',address:'123@g.us',label:'Foreign group'})})).status,400);
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({accountIds:['foreign-account']})})).status,400);
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({timezone:'Invalid/Zone'})})).status,400);
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({templates:{trade_filled:{text:'{{apiKey}}'}}})})).status,400);
  const previous=store.settings('user-a').templates.trade_filled.image;
  const saved=await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({templates:{trade_filled:{text:'Changed {{symbol}}'}}})});assert.equal(saved.status,200);assert.equal(store.settings('user-a').templates.trade_filled.image,previous);
  const pdfBefore=store.settings('user-a').designs.pdf;
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({designs:{image:{layout:'clean_receipt',title:'Receipt'}}})})).status,200);
  assert.equal(store.settings('user-a').designs.image.layout,'clean_receipt');assert.deepEqual(store.settings('user-a').designs.pdf,pdfBefore);
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({designs:{image:{layout:'bad'}}})})).status,400);
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({templateEditor:{kind:'pnl_updated',format:'pdf'}})})).status,200);
  let loaded=(await (await fetch(base,{headers})).json()).data.settings;
  assert.deepEqual(loaded.templateEditor,{kind:'pnl_updated',format:'pdf'});
  const delivery=loaded.alertFormat;
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({templateEditor:{format:'image'}})})).status,200);
  loaded=(await (await fetch(base,{headers})).json()).data.settings;
  assert.deepEqual(loaded.templateEditor,{kind:'pnl_updated',format:'image'});assert.equal(loaded.alertFormat,delivery);
  assert.equal((await fetch(base+'/settings',{method:'PUT',headers,body:JSON.stringify({templateEditor:{format:'invalid'}})})).status,400);
  const preview=await fetch(base+'/preview',{method:'POST',headers,body:JSON.stringify({kind:'pnl_updated',format:'image'})});assert.equal(preview.status,200);assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(1,4).toString(),'PNG');
  assert.equal(preview.headers.get('x-jarvis-media-engine'),'outlined-glyphs-v3');
  assert.match(preview.headers.get('x-jarvis-media-build'),/^[a-f0-9]{16}$/);
  const diagnostics=(await (await fetch(base,{headers})).json()).data.media;
  assert.equal(diagnostics.engine,'outlined-glyphs-v3');assert.equal(diagnostics.build,preview.headers.get('x-jarvis-media-build'));
  const response=await fetch(base); // no auth should reveal neither QR nor settings
  assert.equal(response.status,401);
 }finally{await new Promise(r=>server.close(r));}
});
test('trade source requires login and binds trades to the authenticated user',async()=>{
 const express=(await import('express')).default,{authenticateTradeSource}=await import('../src/middlewares/authenticate.trade.middleware.js'),{signToken}=await import('../src/utils/jwt.js'),{watcherAuthToken}=await import('../src/utils/watcher-auth.js');
 const app=express();app.use(express.json());app.post('/trade',authenticateTradeSource,(req,res)=>res.json({userId:req.body.userId,accounts:req.body.accounts}));app.use((error,req,res,next)=>res.status(error.statusCode||400).json({message:error.message}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/trade';
 try{
  assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+signToken({id:'user-a',role:'user'})},body:JSON.stringify({userId:'foreign-user',accounts:[]})});assert.equal(response.status,200);assert.equal((await response.json()).userId,'user-a');
  await db.collection('users').doc('user-a').set({role:'user',email:'test@example.com'});await db.collection('setups').doc('owned-setup').set({userId:'user-a',accounts:['account-a'],isCompleted:false});
  const internal=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Jarvis-Watcher':watcherAuthToken()},body:JSON.stringify({id:'owned-setup',userId:'foreign-user',accounts:['foreign-account']})});assert.equal(internal.status,200);assert.deepEqual(await internal.json(),{userId:'user-a',accounts:['account-a']});
 }finally{await new Promise(r=>server.close(r));}
});
after(()=>{waDb.close();console.log('Test database was isolated at '+folder);});

