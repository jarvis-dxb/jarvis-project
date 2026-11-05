import express from 'express';
import path from 'node:path';
import {env} from './config/env.js';
import {startWatcherRuntime,stopWatcherRuntime} from './runtime.js';
const app=express();
app.use(express.static(path.dirname(env.HTML_PATH),{extensions:['html']}));
const server=app.listen(env.PORT,()=>console.log('[Watcher] Chart server listening on '+env.PORT));
await startWatcherRuntime({chartBaseUrl:'http://127.0.0.1:'+env.PORT});
async function shutdown(){await stopWatcherRuntime();server.close(()=>process.exit(0));}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
