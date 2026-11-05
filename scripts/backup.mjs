import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {dataDirectory} from './hosting-config.mjs';
const dataDir=dataDirectory(process.env);
const destination=process.argv[2];if(!destination||!path.isAbsolute(destination))throw Error('Pass an absolute PRIVATE backup directory outside public_html and hbuilds');
const out=path.join(destination,'jarvis-'+new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(out,{recursive:true,mode:0o700});
const database=new DatabaseSync(path.join(dataDir,'jarvis.sqlite'));
database.exec("VACUUM INTO '"+path.join(out,'jarvis.sqlite').replaceAll("'","''")+"'");database.close();
// For a consistent linked-device backup, stop the app before copying session keys.
if(fs.existsSync(path.join(dataDir,'whatsapp-sessions')))fs.cpSync(path.join(dataDir,'whatsapp-sessions'),path.join(out,'whatsapp-sessions'),{recursive:true});
console.log('Private backup created. Keep AUTH_SECRET/encryption values separately. Do not publish backup files.');
