console.log(`\n\nStarting backend server...\n`);

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { fork } from 'node:child_process';

import { initSocket } from './socket.js';
import { env } from './config/index.js';
import { corsConfig } from './config/index.js';
import { helmetConfig } from './config/index.js';
import { databasePath, getDatabaseStats, db } from './config/sqlite.js';
import { resumeSavedWatchers } from './services/watcher-resume.service.js';
import { mountFrontendAssets } from './middlewares/frontend-assets.middleware.js';

import { errors, errorHandler, limiter } from './utils/index.js';

import routes from './routes/index.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const watcherPublicDirectory = path.resolve(__dirname, '../../watcher-main/src/public');
const frontendDistDirectory = path.resolve(__dirname, '../../frontend-main/dist');
let watcherRuntime = null;
let whatsappWorker = null;
let whatsappRestart = null;
let stopping = false;
let lastWhatsAppLifecycle = null;
const whatsappLifecycleMessages = {
    'lease-acquired': 'Notification worker lease acquired.',
    'handover-waiting': 'Waiting for the previous notification worker to close its connections.',
    'handover-complete': 'Previous notification worker stopped; updated renderer is starting.',
    'handover-busy': 'Previous notification worker is finishing a send; upgrade will retry.',
    'handover-timeout': 'Previous notification worker shutdown is not confirmed; new delivery startup is blocked.',
    'handover-blocked': 'Notification worker handover could not be verified.',
    'already-running': 'Another notification worker owns the lease; duplicate startup was prevented.',
};
const startWhatsAppWorker = () => {
    if (stopping || String(process.env.WA_WORKER_ENABLED).toLowerCase() === 'false') return;
    whatsappWorker = fork(path.resolve(__dirname, '../scripts/whatsapp-worker.js'), [], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    whatsappWorker.on('message', message => {
        if (message?.type !== 'whatsapp-worker-lifecycle') return;
        const text = Object.hasOwn(whatsappLifecycleMessages, message.state) && whatsappLifecycleMessages[message.state];
        if (text && lastWhatsAppLifecycle !== message.state) {
            lastWhatsAppLifecycle = message.state;
            console.info('[WhatsApp] ' + text);
        }
    });
    whatsappWorker.on('exit', () => {
        whatsappWorker = null;
        if (!stopping) whatsappRestart = setTimeout(startWhatsAppWorker, 20000);
    });
    whatsappWorker.on('error', () => console.warn('[WhatsApp] Worker could not start'));
};

// for 'X-Forwarded-For' header trust proxy
app.set('trust proxy', 1);

// Cloudflare protocol fix
app.use((req, res, next) => {
    if (req.headers['cf-visitor']) {
        try {
            const visitor = JSON.parse(req.headers['cf-visitor']);
            if (visitor.scheme === 'https') {
                req.headers['x-forwarded-proto'] = 'https';
            }
        } catch (e) { }
    }
    next();
});

// server logger
morgan.token('safe-path', req => req.path);
app.use(morgan(':method :safe-path :status :response-time ms'));

// The embedded watcher uses trusted bundled HTML plus external TradingView assets.
// Mount it before the API's restrictive Helmet policy and keep it isolated at /watcher.
if (fs.existsSync(watcherPublicDirectory)) {
    app.use('/watcher', express.static(watcherPublicDirectory, { index: 'index.html' }));
}

// security middlewares
app.use(helmet(helmetConfig));

mountFrontendAssets(app, frontendDistDirectory);

// cors middlewares
app.use(cors(corsConfig));

// rate limiter
app.use(limiter);

// body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// prevent clients from overriding database-maintained timestamps
app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        delete req.body.createdAt;
        delete req.body.updatedAt;
    }
    next();
});

// Trading/account endpoints are live data. Prevent conditional 304 responses
// with empty bodies from breaking clients that expect the JSON payload.
app.use('/api', (req, res, next) => {
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// main entrance
app.use('/api/v1', routes);

app.get('/api/health', (_req, res) => {
    if(env.APP_ENV==='production')return res.json({ok:true,databaseClient:'sqlite'});
    res.json({
        ok: true,
        databaseClient: 'sqlite',
        databasePath,
        ...getDatabaseStats(),
    });
});
app.get('/api/ready', (_req,res) => {
    try {db.collection('watcher');getDatabaseStats();res.json({ok:true,databaseClient:'sqlite',node:process.versions.node});}
    catch {res.status(503).json({ok:false});}
});

// Serve the verified production frontend from the backend so a packaged
// deployment only needs the backend and watcher dependencies installed.
if (fs.existsSync(path.join(frontendDistDirectory, 'index.html'))) {
    app.use(express.static(frontendDistDirectory));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/') || req.path==='/watcher' || req.path.startsWith('/watcher/')) {
            return next();
        }
        return res.sendFile(path.join(frontendDistDirectory, 'index.html'));
    });
} else {
    app.get('/', (_req, res) => res.send('API server is running...'));
}

const serverInstance = http.createServer(app);
initSocket(serverInstance, corsConfig);

// ignore icon requests
app.get('/favicon.ico', (req, res) => res.status(204).end());

// handle undefined routes (404)
app.use('*', (req, res, next) => next(errors.notFound(`Route "${req.originalUrl}" not found`)));

// error middleware should be last
app.use(errorHandler);

// start server
const protocol = false ? 'HTTPS' : 'HTTP';
const server = serverInstance.listen(env.PORT, () => {
    console.log(`\nEnvironment: ${env.APP_ENV}`);
    console.log(`Protocol: ${protocol}`);
    console.log(`Server running on port: ${env.PORT}\n`);
    startWhatsAppWorker();

    if (String(env.WATCHER_ENABLED).toLowerCase() !== 'false') {
        process.env.SERVER_ORIGIN ||= `http://127.0.0.1:${env.PORT}`;
        const runtimeUrl = pathToFileURL(path.resolve(__dirname, '../../watcher-main/src/runtime.js')).href;
        import(runtimeUrl)
            .then(({ startWatcherRuntime }) => startWatcherRuntime({
                chartBaseUrl: `http://127.0.0.1:${env.PORT}/watcher`,
            }))
            .then((runtime) => { watcherRuntime = runtime; })
            .catch((error) => console.error('[Watcher] Startup failed:', error.message));
    } else {
        // Hosting restores saved start/pause intent instead of enabling every
        // account at boot. Condition, approval and order guards stay in runtime.
        void resumeSavedWatchers({
            database: db,
            allowTrading: String(env.WATCHER_RESUME_SAVED).toLowerCase() === 'true',
            shouldStop: () => stopping,
            startWatcherRuntime: async options => {
                const { startWatcherRuntime } = await import(pathToFileURL(path.resolve(__dirname,'../../watcher-main/src/runtime.js')).href);
                if (stopping) return null;
                return startWatcherRuntime(options);
            },
        }).then(result => {
            if (result.runtime) watcherRuntime = result.runtime;
            console.info(`[Watcher] Restart resume: ${result.monitoring} monitoring, ${result.trading} saved execution, ${result.skipped} skipped, ${result.failed} failed.`);
        }).catch(() => console.error('[Watcher] Saved restart state could not be read; no additional watcher was started.'));
    }
});

// ec2 shutdown handling
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION!');
    console.error(err.name, err.message, err.stack);
    process.exit(1); // PM2 khud server restart kar dega
});
process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED REJECTION!');
    console.error(err.name, err.message);
    server.close(() => process.exit(1));
});

// graceful shutdown handling
const shutdown = async (signal) => {
    stopping = true;
    clearTimeout(whatsappRestart);
    whatsappWorker?.kill();
    console.log(`\n${signal} received, closing server...`);
    try {
        const {stopWatcherRuntime}=await import(pathToFileURL(path.resolve(__dirname,'../../watcher-main/src/runtime.js')).href);
        await stopWatcherRuntime();
    } catch (error) {
        console.error('[Watcher] Shutdown failed:', error.message);
    }
    server.close(() => {
        console.log('server closed.');
        process.exit(0);
    });

    // force close after 5s
    setTimeout(() => {
        console.error('connections could not be closed, forcefully shutting down..');
        process.exit(1);
    }, 5000);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGUSR2', () => void shutdown('SIGUSR2'));
process.on('SIGINT', () => void shutdown('SIGINT'));
