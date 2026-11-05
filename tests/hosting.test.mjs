import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {configureHosting} from '../scripts/hosting-config.mjs';
const base=()=>({APP_ORIGIN:'https://test.hostingersite.com',AUTH_SECRET:'a'.repeat(64),ENCRYPTION_KEY:'b'.repeat(32),ENCRYPTION_IV:'c'.repeat(16),SEED_DEMO_USER:'true',DEMO_USER_EMAIL:'tester@example.com',DEMO_USER_PASSWORD:'d'.repeat(32),PORT:'4567'});
const options={home:path.resolve('private-test-home'),nodeVersion:'24.0.0',createDirectory:false};
test('runtime preserves Hostinger assigned port and stores data outside changing builds',()=>{
 const env=base(),result=configureHosting(env,options);assert.equal(env.PORT,'4567');assert.equal(env.CORS_ORIGINS,'https://test.hostingersite.com');assert.equal(env.SERVER_ORIGIN,'http://127.0.0.1:4567');assert.equal(env.FRONTEND_ORIGIN,env.CORS_ORIGINS);assert.equal(env.WATCHER_ENABLED,'false');assert.equal(env.ALLOW_REGISTRATION,'false');assert.equal(env.SQLITE_PATH,path.join(result.dataDir,'jarvis.sqlite'));assert.ok(result.dataDir.includes('.jarvis-data'));
});
test('old runtimes, HTTP production URLs and weak seed logins are rejected',()=>{
 assert.throws(()=>configureHosting(base(),{...options,nodeVersion:'20.0.0'}),/Node.js/);
 assert.throws(()=>configureHosting({...base(),APP_ORIGIN:'http://example.com'},options),/HTTPS/);
 assert.throws(()=>configureHosting({...base(),AUTH_SECRET:'auth-secret-key'},options),/AUTH_SECRET/);
 assert.throws(()=>configureHosting({...base(),DEMO_USER_PASSWORD:'password123'},options),/Initial test login/);
 assert.throws(()=>configureHosting({...base(),ENCRYPTION_KEY:'short'},options),/ENCRYPTION_KEY/);
});
test('private persistent data location and instance survive restart without rotating secrets',()=>{
 const env={...base(),JARVIS_DATA_DIR:path.resolve('persistent-private'),WATCHER_ENABLED:'true'};const result=configureHosting(env,options),before={...env};configureHosting(env,options);assert.deepEqual(env,before);assert.equal(result.dataDir,path.resolve('persistent-private'));assert.equal(env.WATCHER_ENABLED,'false');
});

test('tilde paths resolve under the hosting home and managed build paths are refused',()=>{
 const env={...base(),JARVIS_DATA_DIR:'~/jarvis-data/jarvis-test'};
 const result=configureHosting(env,options);
 assert.equal(result.dataDir,path.join(options.home,'jarvis-data','jarvis-test'));
 assert.equal(env.SOCKET_TRANSPORTS,'polling');
 for(const dir of ['relative/data',path.resolve('public_html/data'),path.resolve('hbuilds/current/data')])assert.throws(()=>configureHosting({...base(),JARVIS_DATA_DIR:dir},options),/private path|outside/);
});

test('hosting resumes saved running users without enabling all users or overriding an explicit opt-out',()=>{
 const env=base();configureHosting(env,options);
 assert.equal(env.WATCHER_ENABLED,'false');
 assert.equal(env.WATCHER_RESUME_SAVED,'true');
 const disabled={...base(),WATCHER_RESUME_SAVED:'false'};configureHosting(disabled,options);
 assert.equal(disabled.WATCHER_RESUME_SAVED,'false');
});
