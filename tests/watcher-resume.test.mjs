import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('packaged restart restore keeps saved modes and cooldown, with no browser or live orders',{timeout:45000},()=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const r=spawnSync(process.execPath,['--experimental-test-module-mocks','--test','backend-main/tests/watcher-resume.test.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,windowsHide:true,encoding:'utf8',timeout:40000,maxBuffer:1024*1024});
 assert.equal(r.status,0,r.error?.message||r.stdout+'\n'+r.stderr);
 assert.match(r.stdout,/(?:#|ℹ) pass 7/);assert.match(r.stdout,/(?:#|ℹ) fail 0/);
});
