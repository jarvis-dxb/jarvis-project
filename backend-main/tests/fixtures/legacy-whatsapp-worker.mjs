// Isolated reproduction of the deployed legacy lease/shutdown protocol.
// No WhatsApp, exchange clients, credentials or application database are loaded.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA busy_timeout=5000');
const owner = 'legacy-test-worker';
const runtime = value => db.prepare("INSERT INTO jarvis_wa_runtime VALUES('worker',?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at").run(JSON.stringify(value), Date.now());
const lease = () => db.prepare("INSERT INTO jarvis_wa_lease VALUES('worker',?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE jarvis_wa_lease.expires_at<? OR jarvis_wa_lease.owner=?").run(owner, Date.now() + 15000, Date.now(), owner).changes > 0;
if (!lease()) throw new Error('Fixture lease unavailable');
runtime({ online: true, heartbeat: Date.now(), mode: 'notifications' });
let stopped = false;
const tick = setInterval(() => {
    if (!stopped && !lease()) {
        stopped = true;
        runtime({ online: false, heartbeat: Date.now(), error: 'Worker lease expired' });
    }
}, 20);
const heartbeat = setInterval(() => { if (!lease()) void shutdown(); }, 40);
let closing = false;
async function shutdown() {
    if (closing) return;
    closing = true; stopped = true;
    clearInterval(tick); clearInterval(heartbeat);
    await new Promise(resolve => setTimeout(resolve, 40));
    db.prepare("INSERT INTO jarvis_wa_runtime VALUES('fixture-socket-closed','true',?) ON CONFLICT(key) DO UPDATE SET data_json='true',updated_at=excluded.updated_at").run(Date.now());
    runtime({ online: false, heartbeat: Date.now() });
    db.prepare('DELETE FROM jarvis_wa_lease WHERE owner=?').run(owner);
    process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);
process.send?.({ ready: true });
