import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Set this before importing the API/sharp. The forked WhatsApp worker inherits
// these process-local paths; no system font installation or manual env is needed.
export function configureBundledFonts(env) {
 const directory=fileURLToPath(new URL('../backend-main/src/whatsapp/fonts/',import.meta.url));
 for(const file of ['fonts.conf','DejaVuSans.ttf','DejaVuSans-Bold.ttf']) {
  if(!fs.existsSync(path.join(directory,file)))throw Error('Bundled notification font is missing: '+file);
 }
 // Replace stale paths left by an earlier manual font fix. Each release points
 // to its own bundled files, even when Hostinger changes the build directory.
 env.FONTCONFIG_FILE=path.join(directory,'fonts.conf');
 env.FONTCONFIG_PATH=directory;
 return directory;
}
export function dataDirectory(env,home=os.homedir()) {
 const requested=env.JARVIS_DATA_DIR?.trim();
 const expanded=requested?.replace(/^~[\\/]/,home+path.sep);
 if(expanded&&!path.isAbsolute(expanded))throw Error('JARVIS_DATA_DIR must be an absolute private path, or begin with ~/');
 const dataDir=path.resolve(expanded || path.join(home,'.jarvis-data',env.JARVIS_INSTANCE || 'jarvis-test'));
 if(dataDir.split(/[\\/]/).some(part=>['public_html','hbuilds'].includes(part.toLowerCase())))throw Error('JARVIS_DATA_DIR must stay outside public_html and hbuilds');
 return dataDir;
}
export function configureHosting(env,{home=os.homedir(),nodeVersion=process.versions.node,createDirectory=true}={}) {
 const [major,minor]=nodeVersion.split('.').map(Number);
 if(major<22||(major===22&&minor<13))throw Error('Select Node.js 24.x or Node.js 22.13+ in Hostinger. This app uses node:sqlite.');
 env.APP_ENV ||= 'production';env.NODE_ENV ||= 'production';env.PORT ||= '5000';
 const origin=new URL(env.APP_ORIGIN || 'http://localhost:'+env.PORT);
 if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('APP_ORIGIN must be the origin only, without path or credentials');
 if(env.APP_ENV==='production') {
  if(!env.APP_ORIGIN||origin.protocol!=='https:')throw Error('Set APP_ORIGIN to the HTTPS temporary Hostinger URL or your domain');
  if(!env.AUTH_SECRET||env.AUTH_SECRET.length<32||env.AUTH_SECRET.includes('CHANGE_'))throw Error('Set a unique AUTH_SECRET (32+ characters)');
  if(Buffer.byteLength(env.ENCRYPTION_KEY || '')!==32||Buffer.byteLength(env.ENCRYPTION_IV || '')!==16)throw Error('ENCRYPTION_KEY must contain 32 bytes; ENCRYPTION_IV 16 bytes');
  if(env.SEED_DEMO_USER==='true'&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.DEMO_USER_EMAIL || '')||(env.DEMO_USER_PASSWORD || '').length<16||env.DEMO_USER_PASSWORD==='password123'))throw Error('Initial test login needs your email and a unique password of at least 16 characters');
 }
 if(!/^[a-zA-Z0-9_-]{1,64}$/.test(env.JARVIS_INSTANCE || 'jarvis-test'))throw Error('JARVIS_INSTANCE must contain only letters, numbers, dash or underscore');
 const dataDir=dataDirectory(env,home);
 if(createDirectory)fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 env.SQLITE_PATH=path.join(dataDir,'jarvis.sqlite');
 env.CORS_ORIGINS ||= origin.origin;env.FRONTEND_ORIGIN=origin.origin;env.ADMIN_ORIGIN=origin.origin;
 env.SERVER_ORIGIN='http://127.0.0.1:'+env.PORT;
 env.AUTH_TRUST_HOST='true';env.ALLOW_REGISTRATION ||= 'false';env.SEED_DEMO_USER ||= 'false';
 // Never enable all users at boot. Resume only explicitly saved running users;
 // fresh, paused and unreviewed profiles remain inactive. Keep saved modes.
 env.WATCHER_ENABLED='false';env.WATCHER_RESUME_SAVED ??= 'true';
 env.WATCHER_SYNC_GITHUB='false';env.WA_WORKER_ENABLED ||= 'true';env.SOCKET_TRANSPORTS ||= 'polling';
 configureBundledFonts(env);
 return {dataDir,origin:origin.origin};
}
