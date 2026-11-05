import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('release boots via LiteSpeed loader, serves SPA/API/polling, refuses unauthenticated controls and preserves SQLite after restart',{timeout:180000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-release-'));
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const origin='http://127.0.0.1:'+port;
 const env={...process.env,APP_ENV:'production',NODE_ENV:'production',APP_ORIGIN:'https://test.hostingersite.com',PORT:String(port),JARVIS_DATA_DIR:temp,AUTH_SECRET:randomBytes(48).toString('hex'),ENCRYPTION_KEY:randomBytes(16).toString('hex'),ENCRYPTION_IV:randomBytes(8).toString('hex'),SEED_DEMO_USER:'false',WA_WORKER_ENABLED:'false',WATCHER_ENABLED:'false',SOCKET_TRANSPORTS:'polling'};
 let child,logs='';
 const start=async()=>{
  child=spawn(process.execPath,['--input-type=commonjs','-e',"require('./app.js')"],{cwd:path.join(root,'dist'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{logs=(logs+b).slice(-5000)});child.stderr.on('data',b=>{logs=(logs+b).slice(-5000)});
  for(let i=0;i<180;i++){
   if(child.exitCode!==null)throw Error('Release failed to start: '+logs);
   try{const r=await fetch(origin+'/api/ready',{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}
   await new Promise(r=>setTimeout(r,500));
  }
  throw Error('Release startup timed out: '+logs);
 };
 const stop=async()=>{if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}};
 try{
  await start();
  const health=await(await fetch(origin+'/api/health')).json();assert.equal(health.ok,true);assert.equal(health.databaseClient,'sqlite');assert.equal(health.databasePath,undefined,'private path is not public');
  for(const route of ['/watcher-live','/portfolio','/setup','/calendar','/whatsapp']){
   const r=await fetch(origin+route);assert.equal(r.status,200);assert.match(await r.text(),/id="root"/);
   if(route==='/setup'){
    const policy=Object.fromEntries(r.headers.get('content-security-policy').split(';').map(part=>{const [key,...values]=part.trim().split(/\s+/);return [key,values]}));
    assert.ok(policy['base-uri'].includes('https://cdn.jsdelivr.net'),'blob chart iframe may resolve library_path on its existing CDN');
    for(const source of ['https://cdn.jsdelivr.net','blob:'])assert.ok(policy['style-src'].includes(source),'chart bundles and custom CSS must load');
    assert.ok(policy['font-src'].includes('https://cdn.jsdelivr.net'));
    assert.ok(policy['frame-src'].includes('https://s.tradingview.com'),'datafeed fallback frame must load');
    assert.deepEqual(policy['object-src'],["'none'"]);
    assert.deepEqual(policy['frame-ancestors'],["'self'"]);
    assert.ok(!policy['script-src'].includes("'unsafe-eval'"));
    for(const key of ['base-uri','style-src','font-src','frame-src'])assert.ok(!policy[key].includes('*'),'do not disable the policy or permit every origin');
   }
  }
  const bundleNames=fs.readdirSync(path.join(root,'dist/frontend-main/dist/assets'));
  const bundles=['.js','.css'].map(ext=>bundleNames.find(name=>name.endsWith(ext)));
  for(const name of bundles){
   assert.ok(name,'release contains JavaScript and CSS');
   const expected=fs.readFileSync(path.join(root,'dist/frontend-main/dist/assets',name));
   for(const requestOrigin of [undefined,env.APP_ORIGIN,'https://preview.example','null']){
    const r=await fetch(origin+'/assets/'+name,{headers:requestOrigin?{Origin:requestOrigin}:{}});
    assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'*');
    assert.equal(r.headers.get('access-control-allow-credentials'),null);
    assert.equal(r.headers.get('cross-origin-resource-policy'),'cross-origin');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()),expected);
   }
  }
  const absentAsset=await fetch(origin+'/assets/absent-release-file.js',{headers:{Origin:'null'}});
  assert.equal(absentAsset.status,404);assert.equal(await absentAsset.text(),'Asset not found');
  for(const requestOrigin of [env.APP_ORIGIN,'https://preview.example','null']){
   const r=await fetch(origin+'/api/v1/watcher/live',{headers:{Origin:requestOrigin}});
   assert.equal(r.status,requestOrigin===env.APP_ORIGIN?401:403);
   if(requestOrigin===env.APP_ORIGIN)assert.equal(r.headers.get('access-control-allow-origin'),env.APP_ORIGIN);
   else assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  const transport=await(await fetch(origin+'/socket.io/?EIO=4&transport=polling')).text();assert.equal(transport[0],'0');assert.deepEqual(JSON.parse(transport.slice(1)).upgrades,[]);
  assert.equal((await fetch(origin+'/api/v1/watcher/live')).status,401);
  assert.equal((await fetch(origin+'/api/v1/watcher/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start',confirmActiveOrders:true})})).status,401);
  assert.ok(!logs.includes('ERR_REQUIRE_ASYNC_MODULE'));
  const db=new DatabaseSync(path.join(temp,'jarvis.sqlite'));
  db.exec("CREATE TABLE deployment_persistence (id INTEGER PRIMARY KEY, value TEXT);INSERT INTO deployment_persistence VALUES(1,'preserved');");db.close();
  await stop();await start();
  const reopened=new DatabaseSync(path.join(temp,'jarvis.sqlite'));assert.equal(reopened.prepare('SELECT value FROM deployment_persistence WHERE id=1').get().value,'preserved');
  assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM documents WHERE collection_name='setups'").get().n,0,'no local strategies imported');reopened.close();
 }finally{await stop();}
});
