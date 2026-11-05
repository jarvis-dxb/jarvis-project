import { createHmac } from 'node:crypto';
import { env } from '../config/env.js';
export const watcherAuthToken = () => createHmac('sha256',env.AUTH_SECRET).update('jarvis-local-watcher-v1').digest('hex');

