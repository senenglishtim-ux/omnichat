import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// .env from the working directory, else from the repository root.
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
dotenv.config({ path: fs.existsSync('.env') ? '.env' : rootEnv });
import crypto from 'node:crypto';

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || './data');

if (!env.JWT_SECRET) console.warn('[omnichat] JWT_SECRET is not set - using a random one (sessions reset on restart)');

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  databaseUrl: env.DATABASE_URL || 'postgres://omnichat:omnichat@localhost:5432/omnichat',
  // Public https base the messengers can reach (webhooks, Instagram media links).
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  // Path prefix if served under a sub-path behind a proxy (e.g. "/chat").
  basePath: (env.BASE_PATH || '').replace(/\/$/, ''),
  jwtSecret: env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  // 32-byte key for channel secrets at rest; derived from JWT_SECRET if omitted.
  encryptionKey: env.ENCRYPTION_KEY || env.JWT_SECRET || 'omnichat-insecure-default-key',
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  baileysDir: path.join(dataDir, 'baileys'),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 100),
  adminEmail: env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: env.ADMIN_PASSWORD || '',
  // Origins allowed to embed the chat in an iframe (space separated), '*' = any.
  embedOrigins: env.EMBED_ORIGINS || '*',
  corsOrigins: env.CORS_ORIGINS || '',
  logLevel: env.LOG_LEVEL || 'info',
};
