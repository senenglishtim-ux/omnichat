import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { log } from './lib/log.js';
import { requireAuth } from './lib/auth.js';
import { sseHandler } from './lib/events.js';
import { startWebhookFanout } from './lib/webhooksOut.js';
import { adapters, startAll, stopChannel } from './channels/index.js';
import { authRouter, usersRouter } from './routes/auth.js';
import { channelsRouter } from './routes/channels.js';
import { conversationsRouter, messagesRouter } from './routes/conversations.js';
import { contactsRouter, templatesRouter, adminRouter, embedRouter, filesRouter } from './routes/misc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST || path.resolve(here, '../../web/dist');

async function seedAdmin() {
  const n = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (n) return;
  const password = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  await pool.query(`INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Admin', $2, 'admin')`, [config.adminEmail, await bcrypt.hash(password, 10)]);
  log.warn(`Created admin user ${config.adminEmail}${config.adminPassword ? '' : ` with password: ${password}  (change it in Settings)`}`);
}

export async function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Raw body is kept for Meta's X-Hub-Signature-256 verification.
  app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));

  if (config.corsOrigins) {
    const allowed = config.corsOrigins.split(/[\s,]+/);
    app.use((req, res, next) => {
      const o = req.headers.origin;
      if (o && (allowed.includes('*') || allowed.includes(o))) {
        res.setHeader('Access-Control-Allow-Origin', o);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  const r = express.Router();
  r.get('/health', (req, res) => res.json({ ok: true }));
  r.use('/webhooks/whatsapp', adapters.whatsapp_cloud.router);
  r.use('/webhooks/instagram', adapters.instagram.router);
  r.use('/webhooks/telegram', adapters.telegram.router);
  r.use('/files', filesRouter);
  r.use('/api/auth', authRouter);
  r.use('/api/users', usersRouter);
  r.use('/api/channels', channelsRouter);
  r.use('/api/conversations', conversationsRouter);
  r.use('/api/messages', messagesRouter);
  r.use('/api/contacts', contactsRouter);
  r.use('/api/templates', templatesRouter);
  r.use('/api/admin', adminRouter);
  r.use('/api/embed', embedRouter);
  r.get('/api/events', requireAuth, sseHandler);
  r.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // The web UI (built by `npm run build`). /embed/* may be framed by the host app.
  if (fs.existsSync(webDist)) {
    r.use(express.static(webDist, { index: false, maxAge: '7d', setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    // Re-read when the build changes (asset hashes), injecting the base path.
    let cached = { mtime: 0, html: '' };
    const indexHtml = () => {
      const file = path.join(webDist, 'index.html');
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime !== cached.mtime) {
        cached = { mtime, html: fs.readFileSync(file, 'utf8')
          .replace('<head>', `<head><script>window.__OMNICHAT_BASE__=${JSON.stringify(config.basePath)}</script>`)
          .replaceAll('="/assets/', `="${config.basePath}/assets/`) };
      }
      return cached.html;
    };
    r.get('*', (req, res) => {
      if (req.path.startsWith('/embed/')) {
        const origins = config.embedOrigins.trim() === '*' ? '*' : config.embedOrigins;
        res.setHeader('Content-Security-Policy', `frame-ancestors ${origins === '*' ? '*' : `'self' ${origins}`}`);
      } else {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(indexHtml());
    });
  }
  app.use(config.basePath || '/', r);

  app.use((err, req, res, next) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large', message: `Max upload size is ${config.maxUploadMb} MB` });
    log.error({ err: err.message, stack: err.stack, url: req.originalUrl }, 'request failed');
    res.status(500).json({ error: 'internal_error', message: err.message });
  });
  return app;
}

async function main() {
  fs.mkdirSync(config.mediaDir, { recursive: true });
  fs.mkdirSync(config.baileysDir, { recursive: true });
  await migrate();
  await seedAdmin();
  const app = await createApp();
  startWebhookFanout();
  const server = app.listen(config.port, config.host, () => log.info(`omnichat listening on ${config.host}:${config.port} (public ${config.publicUrl}${config.basePath})`));
  await startAll();

  const shutdown = async () => {
    log.info('shutting down');
    server.close();
    const rows = (await pool.query('SELECT * FROM channels').catch(() => ({ rows: [] }))).rows;
    for (const ch of rows) await stopChannel(ch);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => { log.error({ err: err.message, stack: err.stack }, 'fatal'); process.exit(1); });
