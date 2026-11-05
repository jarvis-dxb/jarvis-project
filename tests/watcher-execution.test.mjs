import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('bundled watcher executes through saved-policy, approval, quota and TP/SL guards without self-HTTP',{timeout:90000},()=>{
 // A separate test runner must not inherit the parent runner's IPC context.
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks','--test','--test-reporter=tap','backend-main/tests/watcher-execution.test.js'],{
  cwd:fileURLToPath(new URL('../',import.meta.url)),env,windowsHide:true,encoding:'utf8',timeout:85000,maxBuffer:1024*1024
 });
 assert.equal(result.status,0,result.error?.message || result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/# pass 6/);
});
