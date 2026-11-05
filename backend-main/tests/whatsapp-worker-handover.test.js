import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireWorkerLease } from '../src/whatsapp/worker-lease.js';

const media = { engine: 'outlined-glyphs-v3', build: 'c300159ba2a09df6' };
function fixture(filename = ':memory:') {
    const db = new DatabaseSync(filename);
    db.exec(`PRAGMA busy_timeout=5000;
        CREATE TABLE jarvis_wa_lease(id TEXT PRIMARY KEY,owner TEXT,expires_at INTEGER);
        CREATE TABLE jarvis_wa_runtime(key TEXT PRIMARY KEY,data_json TEXT,updated_at INTEGER);
        CREATE TABLE jarvis_wa_deliveries(id TEXT PRIMARY KEY,status TEXT);
        CREATE TABLE jarvis_wa_commands(id TEXT PRIMARY KEY,status TEXT);
        CREATE TABLE protected_data(id TEXT PRIMARY KEY,data_json TEXT);
        INSERT INTO protected_data VALUES('setup','{"margin":66,"leverage":13,"tp":10,"sl":3,"repeat":6}');
        INSERT INTO protected_data VALUES('account','{"network":"testnet","credential":"isolated-placeholder"}');
        INSERT INTO protected_data VALUES('order','{"id":"existing-test-order","status":"open"}');
    `);
    return db;
}
const write = (db, key, value, time) => db.prepare('INSERT INTO jarvis_wa_runtime VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(key, JSON.stringify(value), time);
const read = (db, key) => JSON.parse(db.prepare('SELECT data_json FROM jarvis_wa_runtime WHERE key=?').get(key)?.data_json || '{}');
function legacy(db, time = 10000, extra = {}) {
    db.prepare("INSERT INTO jarvis_wa_lease VALUES('worker','legacy',?)").run(time + 15000);
    write(db, 'worker', { online: true, heartbeat: time, ...extra }, time);
}
const ownerOf = db => db.prepare("SELECT owner FROM jarvis_wa_lease WHERE id='worker'").get()?.owner;

test('normal startup acquires or renews the lease without changing account, setup or order records', async () => {
    const db = fixture();
    const before = db.prepare('SELECT * FROM protected_data ORDER BY id').all();
    assert.deepEqual(await acquireWorkerLease({ db, owner: 'new', media, clock: () => 10000 }), { upgraded: false });
    assert.equal(ownerOf(db), 'new');
    assert.deepEqual(await acquireWorkerLease({ db, owner: 'new', media, clock: () => 11000 }), { upgraded: false });
    assert.deepEqual(db.prepare('SELECT * FROM protected_data ORDER BY id').all(), before);
    assert.deepEqual(read(db, 'worker-handover'), {});
    db.close();
});

test('legacy worker upgrade waits for clean shutdown, not merely a lease-error offline status', async () => {
    const db = fixture(); legacy(db);
    let time = 10000, waits = 0;
    const before = db.prepare('SELECT * FROM protected_data ORDER BY id').all();
    await acquireWorkerLease({ db, owner: 'updated', media, clock: () => time, wait: async () => {
        assert.match(ownerOf(db), /^handover:/);
        time += 200; waits++;
        write(db, 'worker', waits === 1
            ? { online: false, heartbeat: time, error: 'Worker lease expired' }
            : { online: false, heartbeat: time }, time);
    } });
    assert.equal(waits, 2);
    assert.equal(ownerOf(db), 'updated');
    assert.equal(read(db, 'worker-handover').state, 'completed');
    assert.deepEqual(db.prepare('SELECT * FROM protected_data ORDER BY id').all(), before);
    db.close();
});

test('a real isolated legacy process closes before its lease is passed to the new worker', async t => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), 'jarvis-worker-handover-')), 'test.sqlite');
    const db = fixture(filename);
    const childEnvironment = { ...process.env }; delete childEnvironment.NODE_TEST_CONTEXT;
    const child = fork(new URL('./fixtures/legacy-whatsapp-worker.mjs', import.meta.url), [filename], {
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: childEnvironment,
    });
    t.after(() => { if (child.exitCode === null) child.kill(); db.close(); });
    const exited = once(child, 'exit');
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(message.ready, true);
    const before = db.prepare('SELECT * FROM protected_data ORDER BY id').all();
    assert.deepEqual(await acquireWorkerLease({ db, owner: 'updated-process', media, timeoutMs: 4000 }), { upgraded: true });
    assert.equal(ownerOf(db), 'updated-process');
    assert.equal(read(db, 'fixture-socket-closed'), true);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.deepEqual(db.prepare('SELECT * FROM protected_data ORDER BY id').all(), before);
});

test('versioned or stale workers are not automatically displaced', async () => {
    for (const extra of [{ media }, { media: { engine: 'future-renderer', build: 'b'.repeat(16) } }, { heartbeat: -30000 }, { online: false }]) {
        const db = fixture(); legacy(db, 10000, extra);
        await assert.rejects(acquireWorkerLease({ db, owner: 'new', media, clock: () => 10000 }), /Another WhatsApp worker/);
        assert.equal(ownerOf(db), 'legacy');
        assert.deepEqual(read(db, 'worker-handover'), {});
        db.close();
    }
});

test('an in-flight send or connection command defers upgrading without changing either row', async () => {
    for (const [table, status] of [['jarvis_wa_deliveries', 'sending'], ['jarvis_wa_commands', 'processing']]) {
        const db = fixture(); legacy(db);
        db.prepare(`INSERT INTO ${table} VALUES('in-flight',?)`).run(status);
        await assert.rejects(acquireWorkerLease({ db, owner: 'new', media, clock: () => 10000 }), /finishing a send or command/);
        assert.equal(ownerOf(db), 'legacy');
        assert.equal(db.prepare(`SELECT status FROM ${table}`).get().status, status);
        assert.deepEqual(read(db, 'worker-handover'), {});
        db.close();
    }
});

test('missing shutdown acknowledgement fails closed; a later acknowledgement lets a retry finish safely', async () => {
    const db = fixture(); legacy(db);
    let time = 10000;
    await assert.rejects(acquireWorkerLease({ db, owner: 'first', media, clock: () => time,
        timeoutMs: 200, wait: async () => { time += 200; } }), /shutdown is not confirmed/);
    assert.equal(ownerOf(db), 'handover:first');
    assert.equal(read(db, 'worker-handover').state, 'waiting');
    write(db, 'worker', { online: false, heartbeat: time }, time);
    assert.deepEqual(await acquireWorkerLease({ db, owner: 'retry', media, clock: () => time }), { upgraded: true });
    assert.equal(ownerOf(db), 'retry');
    db.close();
});

test('concurrent replacement workers cannot both acquire the handover lease', async () => {
    const db = fixture(); legacy(db, Date.now());
    const one = acquireWorkerLease({ db, owner: 'one', media, timeoutMs: 1000 });
    const two = acquireWorkerLease({ db, owner: 'two', media, timeoutMs: 1000 });
    write(db, 'worker', { online: false, heartbeat: Date.now() }, Date.now());
    const results = await Promise.allSettled([one, two]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.ok(['one', 'two'].includes(ownerOf(db)));
    db.close();
});

test('a second new worker cannot mistake a just-acquired lease for the previous unversioned worker', async () => {
    const db = fixture();
    write(db, 'worker', { online: true, heartbeat: 10000 }, 10000);
    await acquireWorkerLease({ db, owner: 'first-new-worker', media, clock: () => 10000 });
    await assert.rejects(acquireWorkerLease({ db, owner: 'second-new-worker', media, clock: () => 10000 }), /Another WhatsApp worker/);
    assert.equal(ownerOf(db), 'first-new-worker');
    assert.equal(read(db, 'worker').media.build, media.build);
    assert.deepEqual(read(db, 'worker-handover'), {});
    db.close();
});

test('an expired handover guard with an unverifiable build is not stolen', async () => {
    const db = fixture();
    db.prepare("INSERT INTO jarvis_wa_lease VALUES('worker','handover:other',0)").run();
    write(db, 'worker-handover', { guard: 'handover:other', build: 'f'.repeat(16), state: 'waiting', requestedAt: 1 }, 1);
    await assert.rejects(acquireWorkerLease({ db, owner: 'new', media, clock: () => 10000 }), /could not be verified/);
    assert.equal(ownerOf(db), 'handover:other');
    db.close();
});

test('a stopped parent prevents the worker from starting or taking another lease', async () => {
    const db = fixture(); legacy(db);
    await assert.rejects(acquireWorkerLease({ db, owner: 'orphan', media, cancelled: () => true }), /startup cancelled/);
    assert.equal(ownerOf(db), 'legacy');
    assert.deepEqual(read(db, 'worker-handover'), {});
    db.close();
});

test('the actual updated worker replaces a legacy process and publishes the vector identity with an empty isolated account store', { timeout: 30000 }, async t => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), 'jarvis-actual-worker-')), 'test.sqlite');
    const env = { ...process.env, SQLITE_PATH: filename, AUTH_SECRET: 'isolated-worker-startup-test-secret',
        ENCRYPTION_KEY: 'a'.repeat(32), ENCRYPTION_IV: 'b'.repeat(16), SEED_DEMO_USER: 'false',
        WATCHER_ENABLED: 'false', APP_ENV: 'development', NODE_ENV: 'test', EMAIL_HOST: '', EMAIL_USER: '', EMAIL_PASS: '' };
    delete env.NODE_TEST_CONTEXT;
    const children = [];
    const launch = (file, args = []) => {
        const child = fork(new URL(file, import.meta.url), args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(child);
        return child;
    };
    const stop = async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exit = once(child, 'exit');
        if (child.connected) child.disconnect();
        const timer = setTimeout(() => child.kill(), 2000);
        try { await exit; } finally { clearTimeout(timer); }
    };
    t.after(async () => { for (const child of children) await stop(child); });
    const waitOnline = async child => {
        for (let i = 0; i < 120; i++) {
            assert.equal(child.exitCode, null, 'the isolated worker must remain running');
            try {
                const db = new DatabaseSync(filename);
                try { if (read(db, 'worker').online === true) return; } finally { db.close(); }
            } catch {}
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.fail('Isolated worker did not publish its heartbeat');
    };
    // First boot creates the real application schema, with no linked accounts,
    // session rows or settings, so no WhatsApp/exchange connection can be opened.
    const first = launch('../scripts/whatsapp-worker.js');
    await waitOnline(first);
    await stop(first);
    const old = launch('./fixtures/legacy-whatsapp-worker.mjs', [filename]);
    await once(old, 'message', { signal: AbortSignal.timeout(5000) });
    const stages = [];
    const updated = launch('../scripts/whatsapp-worker.js');
    updated.on('message', message => { if (message.type === 'whatsapp-worker-lifecycle') stages.push(message.state); });
    const oldExit = once(old, 'exit');
    await oldExit;
    await waitOnline(updated);
    const db = new DatabaseSync(filename);
    try {
        const actual = read(db, 'worker');
        assert.equal(actual.media.engine, media.engine);
        assert.equal(actual.media.build, media.build);
        assert.ok(stages.includes('handover-waiting'));
        assert.ok(stages.includes('handover-complete'));
        assert.equal(db.prepare('SELECT count(*) AS n FROM jarvis_wa_connections').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM jarvis_wa_deliveries').get().n, 0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM documents WHERE collection_name IN ('accounts','setups')").get().n, 0);
    } finally { db.close(); }
});
