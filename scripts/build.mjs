import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'dist');
// Copy only release code. This build never copies local databases, credentials,
// WhatsApp linked-device keys or node_modules into the served build directory.
fs.mkdirSync(out,{recursive:true});
for(const folder of ['backend-main/src','backend-main/scripts','watcher-main/src','frontend-main/dist','scripts']) {
 fs.cpSync(path.join(root,folder),path.join(out,folder),{recursive:true});
}
fs.copyFileSync(path.join(root,'app.js'),path.join(out,'app.js'));
const runtimePackage=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
runtimePackage.scripts.start='node app.js';
fs.writeFileSync(path.join(out,'package.json'),JSON.stringify(runtimePackage,null,2));
console.log('Hostinger build ready: dist/app.js + API + watcher + prebuilt frontend');
