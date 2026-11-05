import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('packaged legacy worker handover preserves saved data, waits for shutdown and prevents duplicate senders',{timeout:30000},()=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--test','--test-reporter=tap','backend-main/tests/whatsapp-worker-handover.test.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,windowsHide:true,encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.error?.message||result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/# pass 11/);assert.match(result.stdout,/# fail 0/);
});
