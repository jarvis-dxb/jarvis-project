import { setTimeout as delay } from 'node:timers/promises';

const GUARD_PREFIX = 'handover:';
const HANDOVER_KEY = 'worker-handover';
const readRuntime = (db, key) => {
    try { return JSON.parse(db.prepare('SELECT data_json FROM jarvis_wa_runtime WHERE key=?').get(key)?.data_json || '{}'); }
    catch { return {}; }
};
const writeRuntime = (db, key, data, time) => db.prepare(
    'INSERT INTO jarvis_wa_runtime VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at',
).run(key, JSON.stringify(data), time);
const transaction = (db, action) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
};
const failure = (state, notify, message) => { notify(state); throw new Error(message); };

// Old deployments renew this same lease every five seconds and close their
// sockets on losing it. Wait for their clean shutdown record before reconnecting.
// Versioned workers are never displaced automatically, including newer builds.
export async function acquireWorkerLease({ db, owner, media, clock = Date.now, wait = delay, timeoutMs = 15000, notify = () => {}, cancelled = () => false }) {
    const lease = () => db.prepare("SELECT owner,expires_at FROM jarvis_wa_lease WHERE id='worker'").get();
    if (cancelled()) throw new Error('WhatsApp worker startup cancelled');
    let current = lease();
    let guard;
    if (current?.owner.startsWith(GUARD_PREFIX)) {
        guard = readRuntime(db, HANDOVER_KEY);
    } else {
        const time = clock();
        const claimed = transaction(db, () => {
            const changed = db.prepare("INSERT INTO jarvis_wa_lease VALUES('worker',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE jarvis_wa_lease.expires_at<? OR jarvis_wa_lease.owner=?")
                .run(owner, time + 15000, time, owner).changes;
            if (changed) writeRuntime(db, 'worker', { online: false, heartbeat: time, mode: 'starting', media }, time);
            return changed;
        });
        if (claimed) { notify('lease-acquired'); return { upgraded: false }; }
        current = lease();
        guard = transaction(db, () => {
            const active = lease(), runtime = readRuntime(db, 'worker'), time = clock();
            const legacy = runtime.online === true && !runtime.media && Number.isFinite(runtime.heartbeat)
                && time >= runtime.heartbeat && time - runtime.heartbeat < 25000;
            if (!active || active.owner !== current?.owner || active.owner.startsWith(GUARD_PREFIX)
                || !legacy || media?.engine !== 'outlined-glyphs-v3' || !/^[a-f0-9]{16}$/.test(media?.build || '')) {
                return null;
            }
            const sending = db.prepare("SELECT count(*) AS n FROM jarvis_wa_deliveries WHERE status='sending'").get().n;
            const processing = db.prepare("SELECT count(*) AS n FROM jarvis_wa_commands WHERE status='processing'").get().n;
            if (sending || processing) return { busy: true };
            const pending = { guard: GUARD_PREFIX + owner, requestedAt: time, build: media.build, state: 'waiting' };
            // Keep the fence if shutdown cannot be verified. A subsequent new
            // worker can finish this handover after a late shutdown acknowledgement.
            db.prepare("UPDATE jarvis_wa_lease SET owner=?,expires_at=? WHERE id='worker' AND owner=?")
                .run(pending.guard, time + 86400000, active.owner);
            writeRuntime(db, HANDOVER_KEY, pending, time);
            return pending;
        });
        if (guard?.busy) failure('handover-busy', notify, 'WhatsApp worker is finishing a send or command; upgrade will retry.');
        if (!guard) failure('already-running', notify, 'Another WhatsApp worker is running; no automatic takeover was attempted.');
    }
    if (!guard?.guard || guard.guard !== lease()?.owner || guard.build !== media?.build || guard.state !== 'waiting') {
        failure('handover-blocked', notify, 'WhatsApp worker handover could not be verified.');
    }
    notify('handover-waiting');
    const deadline = clock() + timeoutMs;
    while (clock() <= deadline) {
        if (cancelled()) throw new Error('WhatsApp worker startup cancelled');
        const runtime = readRuntime(db, 'worker');
        // The legacy tick's lease-error record is not a shutdown acknowledgement.
        // Only shutdown() writes offline without an error after closing sockets.
        if (runtime.online === false && !('error' in runtime) && Number.isFinite(runtime.heartbeat)
            && runtime.heartbeat >= guard.requestedAt) {
            const acquired = transaction(db, () => {
                const pending = readRuntime(db, HANDOVER_KEY), time = clock();
                if (pending.guard !== guard.guard || pending.state !== 'waiting' || pending.build !== media.build) return false;
                const changed = db.prepare("UPDATE jarvis_wa_lease SET owner=?,expires_at=? WHERE id='worker' AND owner=?")
                    .run(owner, time + 15000, guard.guard).changes;
                if (!changed) return false;
                writeRuntime(db, HANDOVER_KEY, { ...pending, state: 'completed', completedAt: time }, time);
                writeRuntime(db, 'worker', { online: false, heartbeat: time, mode: 'starting', media }, time);
                return true;
            });
            if (!acquired) failure('already-running', notify, 'Another updated WhatsApp worker acquired the lease.');
            notify('handover-complete');
            return { upgraded: true };
        }
        if (lease()?.owner !== guard.guard) failure('already-running', notify, 'WhatsApp worker lease changed during handover.');
        await wait(200);
    }
    failure('handover-timeout', notify, 'Previous WhatsApp worker shutdown is not confirmed; delivery startup remains blocked.');
}
