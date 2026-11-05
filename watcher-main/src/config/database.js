// The watcher and API share one SQLite database and one compatibility layer.
export {
  db,
  formatTimestamp,
  serverTimestamp,
} from '../../../backend-main/src/config/sqlite.js';

