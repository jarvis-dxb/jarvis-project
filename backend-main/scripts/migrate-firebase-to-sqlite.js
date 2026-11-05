import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  databasePath,
  exportCollections,
  getDatabaseStats,
  importCollections,
} from '../src/config/sqlite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const execute = args.includes('--execute');
const replace = args.includes('--replace');
const inputIndex = args.indexOf('--input');
const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : null;

const normalizeCollections = (payload) => {
  const source = payload?.firestore?.collections || payload?.collections || payload;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Migration input must contain a collections object');
  }

  return Object.fromEntries(Object.entries(source).map(([collectionName, rawCollection]) => {
    const documents = rawCollection?.documents || rawCollection;
    if (Array.isArray(documents)) {
      return [collectionName, documents.map((document) => ({
        id: document.id || document._id,
        ...(document.data || document),
      }))];
    }
    return [collectionName, documents || {}];
  }));
};

const readFirebase = async () => {
  const { default: admin } = await import('firebase-admin');
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const credentialPath = path.resolve(backendRoot, process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    credential = admin.credential.cert(JSON.parse(fs.readFileSync(credentialPath, 'utf8')));
  } else {
    throw new Error('Use --input <export.json> or provide FIREBASE_SERVICE_ACCOUNT_JSON/PATH for one-time migration');
  }

  const app = admin.apps.length ? admin.app() : admin.initializeApp({ credential });
  const firestore = app.firestore();
  const collections = {};

  for (const collection of await firestore.listCollections()) {
    const snapshot = await collection.get();
    collections[collection.id] = Object.fromEntries(
      snapshot.docs.map((document) => [document.id, document.data()])
    );
  }

  return collections;
};

const collections = inputPath
  ? normalizeCollections(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), inputPath), 'utf8')))
  : await readFirebase();

const existing = exportCollections();
const report = Object.fromEntries(Object.entries(collections).map(([collectionName, rawDocuments]) => {
  const incomingEntries = Array.isArray(rawDocuments)
    ? rawDocuments.map((document) => [document.id || document._id, document])
    : Object.entries(rawDocuments || {});
  const existingIds = new Set(Object.keys(existing[collectionName] || {}));
  return [collectionName, {
    incoming: incomingEntries.length,
    conflicts: incomingEntries.filter(([id]) => existingIds.has(String(id))).length,
    existing: existingIds.size,
  }];
}));

console.log(JSON.stringify({
  mode: execute ? (replace ? 'execute-replace' : 'execute-merge') : 'dry-run',
  sqlitePath: databasePath,
  collections: report,
}, null, 2));

if (!execute) {
  console.log('\nDry run only. Re-run with --execute after reviewing counts; add --replace only for an authoritative export.');
  process.exit(0);
}

const backupDirectory = path.resolve(backendRoot, 'data/migration-backups');
fs.mkdirSync(backupDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDirectory, `sqlite-before-firebase-${stamp}.json`);
fs.writeFileSync(backupPath, JSON.stringify({ collections: existing }, null, 2));

const imported = importCollections(collections, { replace });
console.log(JSON.stringify({
  success: true,
  imported,
  backupPath,
  stats: getDatabaseStats(),
}, null, 2));

