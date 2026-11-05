import { db } from '../config/sqlite.js';

export async function startSessionWatcher(userId, { signedIn = false } = {}) {
    if (!userId) return;
    const controlRef = db.collection('watcherControls').doc(userId);
    if (signedIn) await controlRef.set({ signedOut: false }, { merge: true });
    const setups = await db.collection('setups').where('userId', '==', userId).get();
    if (!setups.docs.some(doc => {
        const setup = doc.data();
        return !setup.isCompleted && !setup.watcherPaused &&
            Number(setup.triggeredCounter || 0) < Number(setup.repeatCounter || 1);
    })) return;
    const { startWatcherRuntime } = await import('../../../watcher-main/src/runtime.js');
    const control = (await controlRef.get()).data() || {};
    if (control.paused || control.signedOut) return;
    await startWatcherRuntime({
        manual: true,
        userId,
        monitorOnly: control.monitorOnly === true || control.forceMonitoringOnly === true,
    });
}

export async function stopSessionWatcher(userId) {
    if (!userId) return;
    await db.collection('watcherControls').doc(userId).set({ signedOut: true }, { merge: true });
    const { stopWatchingUser } = await import('../../../watcher-main/src/runtime.js');
    await stopWatchingUser(userId);
}
