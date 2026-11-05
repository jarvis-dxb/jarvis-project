import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load .env from root directory (3 levels up from src/config/env.js is watcher/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const env = {
  PORT: process.env.PORT || 3000,
  GH_TOKEN: process.env.GH_TOKEN,
  GITHUB_OWNER: 'mohd7469',
  GITHUB_REPO: 'chart',
  HTML_PATH: path.resolve(__dirname, '../public/index.html'),
  SERVER_ORIGIN: process.env.SERVER_ORIGIN || 'http://127.0.0.1:5000',
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:5173',
  WATCHER_SYNC_GITHUB: process.env.WATCHER_SYNC_GITHUB ?? 'false',
  CHROMIUM_EXECUTABLE_PATH: process.env.CHROMIUM_EXECUTABLE_PATH,
};
