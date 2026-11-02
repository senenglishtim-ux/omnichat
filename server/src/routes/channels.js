import express from 'express';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../lib/auth.js';
import { encrypt, decrypt, isEncrypted } from '../lib/crypto.js';
import { adapters, getAdapter, channelConfig, startChannel, stopChannel, loadChannel } from '../channels/index.js';
import { h, bad, notFound } from './util.js';

export const channelsRouter = express.Router();
channelsRouter.use(requireAuth);

const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');

export function serializeChannel(ch, { admin } = {}) {
  const a = adapters[ch.type];
  const out = {
    id: ch.id, type: ch.type, name: ch.name, status: ch.status, status_detail: ch.status_detail,
    account_id: ch.account_id, account_label: ch.account_label, is_active: ch.is_active,
    capabilities: a?.capabilities || {}, created_at: ch.created_at,
  };
  if (admin) {
    const cfg = {};
    for (const f of a?.fields || []) {
      const v = ch.config?.[f.key];
      cfg[f.key] = f.secret ? mask(decrypt(v)) : v ?? null;
    }
    out.config = cfg;
    out.webhook_url = a?.webhookPath ? `${config.publicUrl}${a.webhookPath(ch)}` : null;
  }
  return out;
}

// Merge submitted values into stored config: secrets are encrypted, a masked
// value ("••••1234") means "unchanged", defaults fill empty fields.
function buildConfig(type, submitted = {}, existing = {}) {
  const a = getAdapter(type);
  const out = { ...existing };
  for (const f of a.fields) {
    let v = submitted[f.key];
    if (v === undefined || (f.secret && typeof v === 'string' && v.startsWith('••••'))) v = undefined;
    if (v !== undefined) {
      if (f.type === 'boolean') v = v === true || v === 'true' || v === 1 || v === '1';
      else if (typeof v === 'string') v = v.trim();
      out[f.key] = f.secret && v ? encrypt(v) : v;
    }
    if ((out[f.key] === undefined || out[f.key] === '' || out[f.key] === null) && f.default) {
      const d = f.default();
      out[f.key] = f.secret ? encrypt(d) : d;
    }
  }
  for (const f of a.fields) {
    if (f.required && !(isEncrypted(out[f.key]) || out[f.key])) throw bad(`${f.label} is required`);
  }
  return out;
}

channelsRouter.get('/types', (req, res) => {
  res.json(Object.values(adapters).map((a) => ({
    type: a.type, title: a.title, capabilities: a.capabilities,
    fields: a.fields.filter((f) => !f.hidden).map(({ default: _d, ...f }) => f),
    actions: Object.keys(a.actions || {}),
  })));
});

channelsRouter.get('/', h(async (req, res) => {
  const rows = (await pool.query('SELECT * FROM channels ORDER BY id')).rows;
  res.json(rows.map((ch) => serializeChannel(ch, { admin: req.user.role === 'admin' && !req.user.scope })));
}));

channelsRouter.post('/', requireAdmin, h(async (req, res) => {
  const { type, name, config: cfg } = req.body || {};
  if (!adapters[type]) throw bad('Unknown channel type');
  const built = buildConfig(type, cfg);
  const ch = (await pool.query('INSERT INTO channels (type, name, config) VALUES ($1,$2,$3) RETURNING *',
    [type, name || adapters[type].title, JSON.stringify(built)])).rows[0];
  await startChannel(ch);
  res.status(201).json(serializeChannel(await loadChannel(ch.id), { admin: true }));
}));

channelsRouter.patch('/:id', requireAdmin, h(async (req, res) => {
  const ch = await loadChannel(Number(req.params.id));
  if (!ch) throw notFound();
  const { name, config: cfg, is_active } = req.body || {};
  const built = cfg ? buildConfig(ch.type, cfg, ch.config) : ch.config;
  const updated = (await pool.query('UPDATE channels SET name = COALESCE($2, name), config = $3, is_active = COALESCE($4, is_active), updated_at = now() WHERE id = $1 RETURNING *',
    [ch.id, name || null, JSON.stringify(built), is_active ?? null])).rows[0];
  await stopChannel(ch);
  if (updated.is_active) await startChannel(updated);
  else await pool.query(`UPDATE channels SET status = 'disabled' WHERE id = $1`, [ch.id]);
  res.json(serializeChannel(await loadChannel(ch.id), { admin: true }));
}));

channelsRouter.delete('/:id', requireAdmin, h(async (req, res) => {
  const ch = await loadChannel(Number(req.params.id));
  if (!ch) throw notFound();
  await stopChannel(ch);
  const a = getAdapter(ch.type);
  if (a.remove) await a.remove({ channel: ch, cfg: channelConfig(ch) }).catch(() => {});
  await pool.query('DELETE FROM channels WHERE id = $1', [ch.id]);
  res.json({ ok: true });
}));

channelsRouter.post('/:id/test', requireAdmin, h(async (req, res) => {
  const ch = await loadChannel(Number(req.params.id));
  if (!ch) throw notFound();
  const a = getAdapter(ch.type);
  res.json({ ok: true, info: await a.test({ channel: ch, cfg: channelConfig(ch) }) });
}));

channelsRouter.post('/:id/restart', requireAdmin, h(async (req, res) => {
  const ch = await loadChannel(Number(req.params.id));
  if (!ch) throw notFound();
  await stopChannel(ch);
  await startChannel(ch);
  res.json(serializeChannel(await loadChannel(ch.id), { admin: true }));
}));

channelsRouter.post('/:id/actions/:action', requireAdmin, h(async (req, res) => {
  const ch = await loadChannel(Number(req.params.id));
  if (!ch) throw notFound();
  const fn = getAdapter(ch.type).actions?.[req.params.action];
  if (!fn) throw bad('Unknown action');
  res.json({ ok: true, result: await fn({ channel: ch, cfg: channelConfig(ch) }, req.body || {}) });
}));

channelsRouter.get('/:id/qr', requireAdmin, h(async (req, res) => {
  const ch = await loadChannel(Number(req.params.id));
  if (!ch) throw notFound();
  const a = getAdapter(ch.type);
  res.json(a.getQr ? a.getQr({ channel: ch }) : {});
}));
