import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { resumeSavedWatchers } from '../src/services/watcher-resume.service.js';

process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'watcher-resume-')), 'test.sqlite');
process.env.WATCHER_ENABLED = 'false';
process.env.WATCHER_RESUME_SAVED = 'true';
process.env.SEED_DEMO_USER = 'false';
process.env.WA_WORKER_ENABLED = 'false';
process.env.AUTH_SECRET = 'isolated-resume-test-secret';
process.env.ENCRYPTION_KEY = 'a'.repeat(32);
process.env.ENCRYPTION_IV = 'b'.repeat(16);
const feed = new EventEmitter(), orders = [];
mock.module(new URL('../../watcher-main/src/services/market-feed.js', import.meta.url).href, {
  namedExports: { dataFeed: feed, launchMarketFeed: async () => ({
    health: () => ({ healthy: true, streams: 1, freshStreams: 1 }), stop: async () => {},
  }) },
});

mock.module(new URL('../../watcher-main/src/services/api.js', import.meta.url).href, {
  namedExports: { createOrder: async setup => { orders.push(setup); return { success: true }; } },
});
const { db } = await import('../src/config/sqlite.js');
const { startWatcherRuntime, stopWatcherRuntime } = await import('../../watcher-main/src/runtime.js');

async function clear() {
  await stopWatcherRuntime();
  orders.length = 0;
  for (const collection of ['watcherControls', 'setups', 'userAccounts']) {
    for (const doc of (await db.collection(collection).get()).docs) await db.collection(collection).doc(doc.id).delete();
  }
}
const control = (id, value) => db.collection('watcherControls').doc(id).set(value);
async function protectedData() {
  return Promise.all(['watcherControls', 'setups', 'userAccounts'].map(async name =>
    (await db.collection(name).get()).docs.map(d => ({ id: d.id, data: d.data() }))));
}

test('resume restores only explicit running modes, leaving pause/mode/trade fields unchanged', async () => {
  await clear();
  await control('auto-user', { paused: false, monitorOnly: false });
  await control('monitor-user', { paused: false, monitorOnly: true });
  await control('forced-monitor', { paused: false, monitorOnly: false, forceMonitoringOnly: true });
  await control('paused-user', { paused: true, monitorOnly: false });
  await control('never-started', { monitorOnly: false });
  await control('malformed', { paused: false, monitorOnly: 'false' });
  await db.collection('setups').doc('untouched').set({ userId: 'auto-user', executionMode: 'confirmation', margin: 66, leverage: 13, TP: 10, SL: 3, triggeredCounter: 2, countdown: '00:10:00' });
  const before = await protectedData(), calls = [];
  const result = await resumeSavedWatchers({ database: db, allowTrading: true, startWatcherRuntime: async options => { calls.push(options); return {}; } });
  assert.deepEqual(calls.map(x => [x.userId, x.monitorOnly]).sort(), [['auto-user', false], ['forced-monitor', true], ['monitor-user', true]]);
  assert.ok(calls.every(x => x.manual === true));
  assert.equal(result.trading, 1); assert.equal(result.monitoring, 2); assert.equal(result.skipped, 1);
  assert.deepEqual(await protectedData(), before);
});

test('without saved-trading opt-in, startup retains monitoring-only behavior', async () => {
  await clear();
  await control('auto-user', { paused: false, monitorOnly: false });
  await control('monitor-user', { paused: false, monitorOnly: true });
  const calls = [];
  const result = await resumeSavedWatchers({ database: db, startWatcherRuntime: async options => { calls.push(options); return {}; } });
  assert.equal(result.trading, 0); assert.equal(result.monitoring, 1); assert.equal(result.skipped, 1);
  assert.equal(calls[0].userId, 'monitor-user');
});

test('fresh installation and completed/paused profiles cannot gain start consent from a setup', async () => {
  await clear();
  await db.collection('setups').doc('auto').set({ userId: 'fresh-user', executionMode: 'auto' });
  let starts = 0;
  await resumeSavedWatchers({ database: db, allowTrading: true, startWatcherRuntime: async () => { starts++; } });
  assert.equal(starts, 0);
});

test('startup rereads a pause saved after discovery and honours server shutdown', async () => {
  await clear();
  await control('changed', { paused: false, monitorOnly: false });
  const actualCollection = db.collection('watcherControls');
  const database = { collection: () => ({
    where: (...args) => ({ get: async () => {
      const snapshot = await actualCollection.where(...args).get();
      await control('changed', { paused: true, monitorOnly: false });
      return snapshot;
    } }),
    doc: id => actualCollection.doc(id),
  }) };
  let starts = 0;
  const start = async () => { starts++; return {}; };
  const result = await resumeSavedWatchers({ database, allowTrading: true, startWatcherRuntime: start });
  assert.equal(result.skipped, 1); assert.equal(starts, 0);
  await control('changed', { paused: false, monitorOnly: false });
  await resumeSavedWatchers({ database: db, allowTrading: true, shouldStop: () => true, startWatcherRuntime: start });
  assert.equal(starts, 0);
});

test('failed engine startup is reported without rewriting state or exposing its raw error', async () => {
  await clear();
  await control('running', { paused: false, monitorOnly: false });
  const before = await protectedData();
  const result = await resumeSavedWatchers({ database: db, allowTrading: true, startWatcherRuntime: async () => { throw Error('secret=FAKE-DO-NOT-LOG'); } });
  assert.equal(result.failed, 1); assert.equal(result.runtime, null);
  assert.ok(!JSON.stringify(result).includes('FAKE'));
  assert.deepEqual(await protectedData(), before);
});

test('actual engine resumes after process-style restart with no browser and no unsolicited order', async () => {
  await clear();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await control('running', { paused: false, monitorOnly: false });
  const saved = { userId: 'running', executionMode: 'auto', isCompleted: false,
    logicType: 'price_movement', triggerSymbol: 'BINANCE:BTCUSDT.P', timeframe: '1',
    watchPrice: 100, usdChange: 5, direction: 'up', side: 'long', accounts: ['fake-account'],
    margin: 66, leverage: 13, TP: 10, SL: 3, repeatCounter: 6, triggeredCounter: 2, countdown: '00:10:00', updatedAt: new Date().toISOString() };
  await db.collection('userAccounts').doc('fake-account').set({ userId: 'running', ping: true, apiKey: 'FAKE', apiSecret: 'FAKE' });
  await db.collection('setups').doc('saved-strategy').set(saved);
  const before = await protectedData();
  try {
    for (let restart = 0; restart < 2; restart++) {
      const result = await resumeSavedWatchers({ database: db, allowTrading: true, startWatcherRuntime });
      assert.equal(result.trading, 1); assert.equal(result.failed, 0);
      assert.equal(orders.length, 0, 'restart must not itself dispatch an entry');
      assert.equal(feed.listenerCount('incoming-data'), 1, 'exactly one in-process feed consumer');
      assert.deepEqual(await protectedData(), before);
      await stopWatcherRuntime();
      assert.equal(feed.listenerCount('incoming-data'), 0);
    }
    await resumeSavedWatchers({ database: db, allowTrading: true, startWatcherRuntime });
    feed.emit('incoming-data', JSON.stringify({ symbol: saved.triggerSymbol, interval: '1m', data: [{ time: Date.now(), open: 100, close: 108 }] }));
    for (let i = 0; i < 100 && !(await db.collection('watcherSamples').doc('saved-strategy').get()).exists; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(orders.length, 0, 'a restart must preserve the saved execution cooldown');
    mock.timers.tick(11 * 60 * 1000);
    feed.emit('incoming-data', JSON.stringify({ symbol: saved.triggerSymbol, interval: '1m', data: [{ time: Date.now(), open: 100, close: 108 }] }));
    for (let i = 0; i < 100 && !orders.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(orders.length, 1, 'a subsequent matching feed update uses the existing dispatch');
    assert.equal(orders[0].id, 'saved-strategy');
    assert.deepEqual(await protectedData(), before, 'the mocked dispatcher cannot alter saved rules/counters');
  } finally { await stopWatcherRuntime(); mock.timers.reset(); }
});

test('real server bootstrap invokes saved resume without any dashboard request', { timeout: 40000 }, async () => {
  await clear();
  await control('saved-auto', { paused: false, monitorOnly: false });
  await control('saved-monitor', { paused: false, monitorOnly: true });
  await control('keep-paused', { paused: true, monitorOnly: false });
  await control('never-started', { monitorOnly: false });
  const before = await protectedData(), env = { ...process.env, PORT: '0', WATCHER_ENABLED: 'false', WATCHER_RESUME_SAVED: 'true', WA_WORKER_ENABLED: 'false' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/resume-server.mjs', import.meta.url))], {
    env, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stdout + '\n' + result.stderr);
  const line = result.stdout.split('\n').find(x => x.startsWith('ISOLATED_RESUME_CALLS '));
  assert.ok(line, result.stdout);
  const calls = JSON.parse(line.slice('ISOLATED_RESUME_CALLS '.length));
  assert.deepEqual(calls.map(x => [x.userId, x.monitorOnly]).sort(), [['saved-auto', false], ['saved-monitor', true]]);
  assert.match(result.stdout, /Restart resume: 1 monitoring, 1 saved execution/);
  assert.deepEqual(await protectedData(), before);
  assert.equal(orders.length, 0);
});
