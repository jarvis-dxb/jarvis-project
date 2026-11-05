// Restore only a user's explicitly saved running state. Reading the dashboard,
// a socket connection, or the existence of an Auto setup is never start consent.
export async function resumeSavedWatchers({
  database, startWatcherRuntime, allowTrading = false, shouldStop = () => false,
}) {
  const result = { runtime: null, monitoring: 0, trading: 0, skipped: 0, failed: 0 };
  const controls = database.collection('watcherControls');
  const snapshot = await controls.where('paused', '==', false).get();
  for (const doc of snapshot.docs) {
    if (shouldStop()) break;
    // A pause/mode change while another user's engine starts must take priority.
    const current = await controls.doc(doc.id).get();
    const saved = current.data();
    if (!current.exists || saved?.paused !== false || saved.signedOut || typeof saved.monitorOnly !== 'boolean') {
      result.skipped++;
      continue;
    }
    const monitorOnly = saved.monitorOnly || saved.forceMonitoringOnly === true;
    if (!monitorOnly && !allowTrading) {
      result.skipped++;
      continue;
    }
    if (shouldStop()) break;
    try {
      const runtime = await startWatcherRuntime({ manual: true, userId: doc.id, monitorOnly });
      if (!runtime) {
        result.failed++;
        continue;
      }
      result.runtime = runtime;
      result[monitorOnly ? 'monitoring' : 'trading']++;
    } catch {
      // Do not copy arbitrary engine errors/credentials into startup diagnostics.
      result.failed++;
    }
  }
  return result;
}
