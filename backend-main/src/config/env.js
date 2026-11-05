import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always load .env from backend root directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const env = {
  APP_NAME: process.env.APP_NAME || 'Jarvis',
  APP_ENV: process.env.APP_ENV || 'development',
  PORT: process.env.PORT || 5000,

  AUTH_SECRET: process.env.AUTH_SECRET,
  JWT_ACCESS_EXPIRE_IN_MINUTES: process.env.JWT_ACCESS_EXPIRE_IN_MINUTES || '60',
  JWT_REFRESH_EXPIRE_IN_HOURS: process.env.JWT_REFRESH_EXPIRE_IN_HOURS || '24',

  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  ENCRYPTION_IV: process.env.ENCRYPTION_IV,

  SQLITE_PATH: process.env.SQLITE_PATH || './data/jarvis.sqlite',
  SEED_DEMO_USER: process.env.SEED_DEMO_USER ?? 'true',
  DEMO_USER_EMAIL: process.env.DEMO_USER_EMAIL || 'user@gmail.com',
  DEMO_USER_NAME: process.env.DEMO_USER_NAME || 'Local Demo User',
  DEMO_USER_PASSWORD: process.env.DEMO_USER_PASSWORD || 'password123',
  WATCHER_ENABLED: process.env.WATCHER_ENABLED ?? 'true',
  WATCHER_RESUME_SAVED: process.env.WATCHER_RESUME_SAVED ?? 'false',
  WATCHER_SYNC_GITHUB: process.env.WATCHER_SYNC_GITHUB ?? 'false',
  CHROMIUM_EXECUTABLE_PATH: process.env.CHROMIUM_EXECUTABLE_PATH,

  CORS_ORIGINS: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(url => url.trim())
    : [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        `http://localhost:${process.env.PORT || 5000}`,
        `http://127.0.0.1:${process.env.PORT || 5000}`,
      ],

  SALT_ROUNDS: parseInt(process.env.SALT_ROUNDS) || 10,
  LINK_AND_OTP_EXPIRY_MINUTES: parseInt(process.env.LINK_AND_OTP_EXPIRY_MINUTES) || 3,
  EMAIL_SERVICE: process.env.EMAIL_SERVICE,
  EMAIL_HOST: process.env.EMAIL_HOST,
  EMAIL_PORT: process.env.EMAIL_PORT,
  EMAIL_USER: process.env.EMAIL_USER,
  EMAIL_PASS: process.env.EMAIL_PASS,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_SECURE: process.env.EMAIL_SECURE,

  ADMIN_ORIGIN: process.env.ADMIN_ORIGIN,
  SERVER_ORIGIN: process.env.SERVER_ORIGIN,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
};

// Validate required environment variables
const requiredEnvVars = ['AUTH_SECRET'];
for (const envVar of requiredEnvVars) {
  if (!env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}
