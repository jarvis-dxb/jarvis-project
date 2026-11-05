import bcrypt from 'bcryptjs';

import {
  db,
  getDatabaseStats,
  runIntegrityCheck,
} from '../src/config/sqlite.js';

const integrity = runIntegrityCheck();
const stats = getDatabaseStats();
const userSnapshot = await db.collection('users').where('email', '==', 'user@gmail.com').limit(1).get();
const demoUser = userSnapshot.docs[0]?.data();
const demoPasswordValid = demoUser
  ? await bcrypt.compare('password123', demoUser.password)
  : false;

const result = {
  ok: integrity === 'ok' && Boolean(demoUser) && demoPasswordValid,
  integrity,
  demoUser: Boolean(demoUser),
  demoPasswordValid,
  stats,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

