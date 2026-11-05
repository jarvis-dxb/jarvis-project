const path = require('node:path');

async function start() {
    const [{default:dotenv}, {configureHosting}] = await Promise.all([
        import('dotenv'),
        import('./hosting-config.mjs'),
    ]);
    dotenv.config({path:path.resolve(__dirname,'..','.env')});
    const deployment=configureHosting(process.env);
    console.log(`[Hostinger] Data directory: ${deployment.dataDir}`);
    console.log('[Hostinger] One Node process with supervised WhatsApp worker. Saved watcher restart resume: ' +
        (String(process.env.WATCHER_RESUME_SAVED).toLowerCase() === 'true' ? 'enabled' : 'monitoring only') + '.');
    await import('../backend-main/src/server.js');
}

// Do not export or await the startup promise at module scope: lsnode.js calls
// require(app.js), which cannot synchronously load top-level-await ESM graphs.
void start().catch(error => {
    console.error('[Hostinger] Startup failed:', error.message);
    process.exit(1);
});
