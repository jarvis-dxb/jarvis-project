import { mock } from 'node:test';
const calls = [];
mock.module(new URL('../../../watcher-main/src/runtime.js', import.meta.url).href, {
  namedExports: {
    startWatcherRuntime: async options => { calls.push(options); return {}; },
    stopWatcherRuntime: async () => {},
  },
});
await import('../../src/server.js');
const deadline = Date.now() + 3000;
while (calls.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
console.log('ISOLATED_RESUME_CALLS ' + JSON.stringify(calls));
process.emit('SIGTERM');
