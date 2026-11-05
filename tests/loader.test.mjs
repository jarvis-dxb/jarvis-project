import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('LiteSpeed require(app.js) returns synchronously while async ESM dependencies and server load successfully',()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-loader-regression-'));
 for(const folder of ['scripts','backend-main/src','node_modules/dotenv'])fs.mkdirSync(path.join(fixture,folder),{recursive:true});
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({type:'module'}));
 fs.copyFileSync(path.join(root,'app.js'),path.join(fixture,'app.js'));
 fs.copyFileSync(path.join(root,'scripts/hostinger-start.cjs'),path.join(fixture,'scripts/hostinger-start.cjs'));
 fs.writeFileSync(path.join(fixture,'scripts/hosting-config.mjs'),"export function configureHosting(){return {dataDir:'isolated-fixture'}}");
 fs.writeFileSync(path.join(fixture,'node_modules/dotenv/package.json'),JSON.stringify({name:'dotenv',type:'module',exports:'./index.js'}));
 fs.writeFileSync(path.join(fixture,'node_modules/dotenv/index.js'),"await Promise.resolve(); export default {config(){}};");
 fs.writeFileSync(path.join(fixture,'backend-main/src/server.js'),"await Promise.resolve(); console.log('ASYNC_SERVER_IMPORTED');");
 const result=spawnSync(process.execPath,['--input-type=commonjs','-e',"require('./app.js'); console.log('SYNC_LOADER_RETURNED');"],{cwd:fixture,encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);
 assert.ok(!result.stderr.includes('ERR_REQUIRE_ASYNC_MODULE'));
 assert.ok(result.stdout.includes('ASYNC_SERVER_IMPORTED'));
 assert.ok(result.stdout.indexOf('SYNC_LOADER_RETURNED')<result.stdout.indexOf('ASYNC_SERVER_IMPORTED'));
});
