import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('packaged authenticated preview identifies the vector build and keeps WhatsApp routing isolated',{timeout:90000},()=>{
 const env={...process.env,AUTH_SECRET:'isolated-vector-release-secret',ENCRYPTION_KEY:'a'.repeat(32),ENCRYPTION_IV:'b'.repeat(16),SEED_DEMO_USER:'false',WA_WORKER_ENABLED:'false',WATCHER_ENABLED:'false'};delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap','backend-main/tests/whatsapp.test.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,windowsHide:true,encoding:'utf8',timeout:85000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.error?.message || result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/authenticated routes reject cross-user/);assert.match(result.stdout,/# fail 0/);
});
