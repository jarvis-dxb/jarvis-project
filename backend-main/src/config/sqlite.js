import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';

import { env } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '../..');
const requestedPath = env.SQLITE_PATH || './data/jarvis.sqlite';

export const databasePath = path.isAbsolute(requestedPath)
  ? requestedPath
  : path.resolve(backendRoot, requestedPath);

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const sqlite = new DatabaseSync(databasePath);
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS documents (
    collection_name TEXT NOT NULL,
    document_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection_name, document_id)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_collection
    ON documents (collection_name);

  CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    details_json TEXT
  );
`);

const changes = new EventEmitter();
changes.setMaxListeners(0);

class SQLiteTimestamp {
  constructor(value) {
    this.value = value instanceof Date ? value : new Date(value);
  }

  toDate() {
    return new Date(this.value);
  }

  toJSON() {
    return this.value.toISOString();
  }

  get seconds() {
    return Math.floor(this.value.getTime() / 1000);
  }

  get _seconds() {
    return this.seconds;
  }
}

const isIsoDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value);

const normalizeForStorage = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof SQLiteTimestamp) return value.toJSON();
  if (value?.__sqliteServerTimestamp) return new Date().toISOString();
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();

  if (typeof value === 'object' && Number.isFinite(value._seconds ?? value.seconds)) {
    const seconds = value._seconds ?? value.seconds;
    const nanos = value._nanoseconds ?? value.nanoseconds ?? 0;
    return new Date((seconds * 1000) + Math.floor(nanos / 1e6)).toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForStorage).filter((item) => item !== undefined);
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, nested]) => [key, normalizeForStorage(nested)])
        .filter(([, nested]) => nested !== undefined)
    );
  }

  return value;
};

const reviveFromStorage = (value) => {
  if (isIsoDate(value)) return new SQLiteTimestamp(value);
  if (Array.isArray(value)) return value.map(reviveFromStorage);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, reviveFromStorage(nested)])
    );
  }
  return value;
};

const cloneData = (value) => reviveFromStorage(JSON.parse(JSON.stringify(normalizeForStorage(value))));
const getByPath = (value, fieldPath) => fieldPath.split('.').reduce((current, key) => current?.[key], value);

const setByPath = (target, fieldPath, value) => {
  const keys = fieldPath.split('.');
  let cursor = target;
  for (const key of keys.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = value;
};

const comparable = (value) => {
  if (value instanceof SQLiteTimestamp) return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (isIsoDate(value)) return new Date(value).getTime();
  return value;
};

const matchesFilter = (data, { field, operator, value }) => {
  const left = comparable(getByPath(data, field));
  const right = comparable(value);
  switch (operator) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    case 'array-contains': return Array.isArray(left) && left.includes(right);
    case 'in': return Array.isArray(right) && right.includes(left);
    default: throw new Error(`Unsupported SQLite query operator: ${operator}`);
  }
};

const readRow = (collectionName, documentId) => sqlite.prepare(
  'SELECT data_json FROM documents WHERE collection_name = ? AND document_id = ?'
).get(collectionName, documentId);

const readCollection = (collectionName) => sqlite.prepare(
  'SELECT document_id, data_json FROM documents WHERE collection_name = ?'
).all(collectionName).map((row) => ({
  id: row.document_id,
  data: reviveFromStorage(JSON.parse(row.data_json)),
}));

const writeDocument = (collectionName, documentId, data, { merge = false, notify = true } = {}) => {
  const now = new Date().toISOString();
  const existing = readRow(collectionName, documentId);
  const currentData = existing ? JSON.parse(existing.data_json) : {};
  const nextData = normalizeForStorage(merge ? { ...currentData, ...data } : data);

  sqlite.prepare(`
    INSERT INTO documents (collection_name, document_id, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(collection_name, document_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = excluded.updated_at
  `).run(collectionName, documentId, JSON.stringify(nextData), now, now);

  if (notify) changes.emit(collectionName);
};

const updateDocument = (collectionName, documentId, updates, { notify = true } = {}) => {
  const existing = readRow(collectionName, documentId);
  if (!existing) throw new Error(`Document ${collectionName}/${documentId} does not exist`);

  const nextData = JSON.parse(existing.data_json);
  for (const [fieldPath, value] of Object.entries(updates)) {
    setByPath(nextData, fieldPath, normalizeForStorage(value));
  }
  writeDocument(collectionName, documentId, nextData, { notify });
};

class DocumentSnapshot {
  constructor(id, data) {
    this.id = id;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return this.exists ? cloneData(this._data) : undefined;
  }
}

class QuerySnapshot {
  constructor(rows) {
    this.docs = rows.map((row) => new DocumentSnapshot(row.id, row.data));
    this.empty = this.docs.length === 0;
    this.size = this.docs.length;
  }

  forEach(callback) {
    this.docs.forEach(callback);
  }
}

class Query {
  constructor(collectionName, filters = [], orders = [], rowLimit = null) {
    this.collectionName = collectionName;
    this.filters = filters;
    this.orders = orders;
    this.rowLimit = rowLimit;
  }

  where(field, operator, value) {
    return new Query(this.collectionName, [...this.filters, { field, operator, value }], this.orders, this.rowLimit);
  }

  orderBy(field, direction = 'asc') {
    return new Query(this.collectionName, this.filters, [...this.orders, { field, direction }], this.rowLimit);
  }

  limit(count) {
    return new Query(this.collectionName, this.filters, this.orders, Number(count));
  }

  async get() {
    let rows = readCollection(this.collectionName)
      .filter((row) => this.filters.every((filter) => matchesFilter(row.data, filter)));

    if (this.orders.length) {
      rows.sort((leftRow, rightRow) => {
        for (const { field, direction } of this.orders) {
          const left = comparable(getByPath(leftRow.data, field));
          const right = comparable(getByPath(rightRow.data, field));
          if (left === right) continue;
          const result = left > right ? 1 : -1;
          return direction === 'desc' ? -result : result;
        }
        return 0;
      });
    }

    if (this.rowLimit !== null) rows = rows.slice(0, this.rowLimit);
    return new QuerySnapshot(rows);
  }

  onSnapshot(onNext, onError = console.error) {
    let active = true;
    const emitSnapshot = async () => {
      if (!active) return;
      try {
        onNext(await this.get());
      } catch (error) {
        onError(error);
      }
    };

    const listener = () => queueMicrotask(emitSnapshot);
    changes.on(this.collectionName, listener);
    queueMicrotask(emitSnapshot);

    return () => {
      active = false;
      changes.off(this.collectionName, listener);
    };
  }
}

class DocumentReference {
  constructor(collectionName, id) {
    this.collectionName = collectionName;
    this.id = id;
  }

  async get() {
    const row = readRow(this.collectionName, this.id);
    return new DocumentSnapshot(this.id, row ? reviveFromStorage(JSON.parse(row.data_json)) : undefined);
  }

  async set(data, options = {}) {
    writeDocument(this.collectionName, this.id, data, { merge: Boolean(options.merge) });
    return { writeTime: new SQLiteTimestamp(new Date()) };
  }

  async update(updates) {
    updateDocument(this.collectionName, this.id, updates);
    return { writeTime: new SQLiteTimestamp(new Date()) };
  }

  // Compare and write under the same lock so a signal cannot overwrite a
  // reference changed by another signal or an edit to the saved setup.
  updateIf(updates, predicate) {
    let changed = false;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const row = readRow(this.collectionName, this.id);
      if (row && predicate(reviveFromStorage(JSON.parse(row.data_json)))) {
        updateDocument(this.collectionName, this.id, updates, { notify: false });
        changed = true;
      }
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
    if (changed) changes.emit(this.collectionName);
    return changed;
  }

  async delete() {
    sqlite.prepare('DELETE FROM documents WHERE collection_name = ? AND document_id = ?')
      .run(this.collectionName, this.id);
    changes.emit(this.collectionName);
  }

  onSnapshot(onNext, onError = console.error) {
    let active = true;
    const emitSnapshot = async () => {
      if (!active) return;
      try {
        onNext(await this.get());
      } catch (error) {
        onError(error);
      }
    };
    const listener = () => queueMicrotask(emitSnapshot);
    changes.on(this.collectionName, listener);
    queueMicrotask(emitSnapshot);
    return () => {
      active = false;
      changes.off(this.collectionName, listener);
    };
  }
}

class CollectionReference extends Query {
  constructor(collectionName) {
    super(collectionName);
    this.id = collectionName;
  }

  doc(documentId = randomUUID()) {
    return new DocumentReference(this.collectionName, documentId);
  }

  async add(data) {
    const reference = this.doc();
    await reference.set(data);
    return reference;
  }
}

class WriteBatch {
  constructor() {
    this.operations = [];
  }

  set(reference, data, options = {}) {
    this.operations.push({
      collectionName: reference.collectionName,
      run: () => writeDocument(reference.collectionName, reference.id, data, { merge: Boolean(options.merge), notify: false }),
    });
    return this;
  }

  update(reference, updates) {
    this.operations.push({
      collectionName: reference.collectionName,
      run: () => updateDocument(reference.collectionName, reference.id, updates, { notify: false }),
    });
    return this;
  }

  delete(reference) {
    this.operations.push({
      collectionName: reference.collectionName,
      run: () => sqlite.prepare(
        'DELETE FROM documents WHERE collection_name = ? AND document_id = ?'
      ).run(reference.collectionName, reference.id),
    });
    return this;
  }

  async commit() {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      this.operations.forEach((operation) => operation.run());
      sqlite.exec('COMMIT');
      for (const collectionName of new Set(this.operations.map((operation) => operation.collectionName))) {
        changes.emit(collectionName);
      }
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

export const db = {
  collection(collectionName) {
    return new CollectionReference(collectionName);
  },
  batch() {
    return new WriteBatch();
  },
};

export const serverTimestamp = () => ({ __sqliteServerTimestamp: true });

export const formatTimestamp = (timestamp) => {
  if (!timestamp) return null;
  if (typeof timestamp.toDate === 'function') return timestamp.toDate();
  if (Number.isFinite(timestamp._seconds ?? timestamp.seconds)) {
    return new Date((timestamp._seconds ?? timestamp.seconds) * 1000);
  }
  return new Date(timestamp);
};

export const copyCollection = async (sourceCollection, targetCollection) => {
  const snapshot = await db.collection(sourceCollection).get();
  const batch = db.batch();
  snapshot.docs.forEach((document) => batch.set(db.collection(targetCollection).doc(document.id), document.data()));
  await batch.commit();
  return snapshot.size;
};

export const listCollections = () => sqlite.prepare(
  'SELECT DISTINCT collection_name FROM documents ORDER BY collection_name'
).all().map((row) => row.collection_name);

export const exportCollections = () => Object.fromEntries(
  listCollections().map((collectionName) => [
    collectionName,
    Object.fromEntries(readCollection(collectionName).map((row) => [row.id, normalizeForStorage(row.data)])),
  ])
);

export const importCollections = (collections, { replace = false } = {}) => {
  const report = {};
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    for (const [collectionName, rawDocuments] of Object.entries(collections || {})) {
      if (replace) {
        sqlite.prepare('DELETE FROM documents WHERE collection_name = ?').run(collectionName);
      }

      const entries = Array.isArray(rawDocuments)
        ? rawDocuments.map((document) => [document.id || document._id || randomUUID(), document.data || document])
        : Object.entries(rawDocuments || {});

      report[collectionName] = 0;
      for (const [documentId, documentData] of entries) {
        const { id: _id, _id: _mongoId, ...cleanData } = documentData || {};
        writeDocument(collectionName, String(documentId), cleanData, { merge: !replace, notify: false });
        report[collectionName] += 1;
      }
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }

  Object.keys(report).forEach((collectionName) => changes.emit(collectionName));
  return report;
};

export const getDatabaseStats = () => ({
  client: 'sqlite',
  path: databasePath,
  collections: Object.fromEntries(
    sqlite.prepare(`
      SELECT collection_name, COUNT(*) AS count
      FROM documents
      GROUP BY collection_name
      ORDER BY collection_name
    `).all().map((row) => [row.collection_name, Number(row.count)])
  ),
});

export const runIntegrityCheck = () => sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check || 'unknown';

const seedLocalData = () => {
  if (String(env.SEED_DEMO_USER).toLowerCase() === 'false') return;
  if (readCollection('users').length > 0) return;

  const now = new Date().toISOString();
  const userId = 'local-demo-user';
  writeDocument('users', userId, {
    name: env.DEMO_USER_NAME,
    email: env.DEMO_USER_EMAIL || 'user@gmail.com',
    password: bcrypt.hashSync(env.DEMO_USER_PASSWORD || 'password123', 10),
    role: 'user',
    verified: true,
    limitTrades: '10',
    createdAt: now,
    updatedAt: now,
  }, { notify: false });

  writeDocument('userAccounts', 'local-demo-account', {
    userId,
    name: 'Local Demo Account',
    exchangeType: 'binance',
    network: 'testnet',
    connected: false,
    apiKey: '',
    apiSecret: '',
    createdAt: now,
    updatedAt: now,
  }, { notify: false });

  writeDocument('watcher', 'status', {
    online: false,
    state: 'starting',
    database: 'sqlite',
    timestamp: now,
  }, { notify: false });
};

seedLocalData();
console.log(`SQLite initialized: ${databasePath}`);
