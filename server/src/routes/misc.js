import express from 'express';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin, signToken, scopeAllows } from '../lib/auth.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { verifySigned, absMedia, signedPath } from '../lib/media.js';
import { deliverWebhook, invalidateWebhooks } from '../lib/webhooksOut.js';
import { emit } from '../lib/events.js';
import { getAdapter, channelConfig, loadChannel } from '../channels/index.js';
import { h, bad, notFound } from './util.js';
import fs from 'node:fs';

// ---------------------------------------------------------------- contacts
export const contactsRouter = express.Router();
contactsRouter.use(requireAuth);

const contactOut = (c) => ({ ...c, avatar_path: undefined, avatar_url: c.avatar_path ? signedPath('a', c.id, 24 * 3600) : null });

contactsRouter.get('/', h(async (req, res) => {
  const vals = []; const where = [];
  if (req.query.q) { vals.push(`%${req.query.q}%`); where.push(`(name ILIKE $1 OR phone ILIKE $1 OR username ILIKE $1)`); }
  if (req.query.external_ref) { vals.push(String(req.query.external_ref)); where.push(`external_ref = $${vals.length}`); }
  if (req.query.phone) { vals.push(`+${String(req.query.phone).replace(/\D/g, '')}`); where.push(`phone = $${vals.length}`); }
  if (req.user.scope?.contact_id) { vals.push(Number(req.user.scope.contact_id)); where.push(`id = $${vals.length}`); }
  const rows = (await pool.query(`SELECT * FROM contacts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 100`, vals)).rows;
  res.json(rows.map(contactOut));
}));

contactsRouter.get('/:id', h(async (req, res) => {
  if (!scopeAllows(req.user, req.params.id)) throw notFound();
  const c = (await pool.query('SELECT * FROM contacts WHERE id = $1', [req.params.id])).rows[0];
  if (!c) throw notFound();
  const convs = (await pool.query(`SELECT c.id, c.channel_id, ch.type AS channel_type, ch.name AS channel_name, c.last_message_at, c.unread_count
    FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.contact_id = $1 ORDER BY c.last_message_at DESC NULLS LAST`, [c.id])).rows;
  res.json({ ...contactOut(c), conversations: convs });
}));

contactsRouter.patch('/:id', h(async (req, res) => {
  if (!scopeAllows(req.user, req.params.id)) throw notFound();
  const { name, external_ref, custom, phone } = req.body || {};
  const c = (await pool.query(
    `UPDATE contacts SET name = COALESCE($2, name), external_ref = COALESCE($3, external_ref), custom = COALESCE($4, custom),
       phone = COALESCE($5, phone), updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, name ?? null, external_ref ?? null, custom ? JSON.stringify(custom) : null, phone ? `+${String(phone).replace(/\D/g, '')}` : null])).rows[0];
  if (!c) throw notFound();
  const convs = (await pool.query('SELECT id FROM conversations WHERE contact_id = $1', [c.id])).rows;
  for (const cv of convs) emit('conversation.updated', { conversation_id: cv.id, contact_id: c.id, contact: contactOut(c) });
  res.json(contactOut(c));
}));

// ---------------------------------------------------------------- templates
export const templatesRouter = express.Router();
templatesRouter.use(requireAuth);

templatesRouter.get('/', h(async (req, res) => {
  const vals = []; let where = '';
  if (req.query.channel_id) { vals.push(Number(req.query.channel_id)); where = 'WHERE channel_id = $1'; }
  if (req.query.approved) where += `${where ? ' AND' : ' WHERE'} status = 'APPROVED'`;
  res.json((await pool.query(`SELECT * FROM templates ${where} ORDER BY name, language`, vals)).rows);
}));

templatesRouter.post('/', requireAdmin, h(async (req, res) => {
  const { channel_id, name, language, category, header_text, body_text, footer_text, buttons } = req.body || {};
  const ch = await loadChannel(Number(channel_id));
  if (!ch || ch.type !== 'whatsapp_cloud') throw bad('Templates exist only for WhatsApp Cloud channels');
  if (!/^[a-z0-9_]+$/.test(name || '')) throw bad('Template name: lowercase latin letters, digits and _');
  if (!String(body_text || '').trim()) throw bad('Body text is required');
  const components = [];
  const example = (t) => { const n = [...String(t).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].length; return n ? Array.from({ length: n }, (_, i) => `example${i + 1}`) : null; };
  if (header_text?.trim()) { const ex = example(header_text); components.push({ type: 'HEADER', format: 'TEXT', text: header_text.trim(), ...(ex ? { example: { header_text: ex } } : {}) }); }
  { const ex = example(body_text); components.push({ type: 'BODY', text: body_text.trim(), ...(ex ? { example: { body_text: [ex] } } : {}) }); }
  if (footer_text?.trim()) components.push({ type: 'FOOTER', text: footer_text.trim() });
  const btns = (buttons || []).filter((b) => b?.text?.trim());
  if (btns.length) components.push({ type: 'BUTTONS', buttons: btns.map((b) => (b.type === 'URL' ? { type: 'URL', text: b.text.trim(), url: b.url } : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text.trim(), phone_number: b.phone_number } : { type: 'QUICK_REPLY', text: b.text.trim() })) });
  const r = await getAdapter(ch.type).createTemplate({ channel: ch, cfg: channelConfig(ch) }, { name, language: language || 'en', category: category || 'UTILITY', components });
  res.status(201).json(r);
}));

templatesRouter.delete('/:channelId/:name', requireAdmin, h(async (req, res) => {
  const ch = await loadChannel(Number(req.params.channelId));
  if (!ch || ch.type !== 'whatsapp_cloud') throw notFound();
  await getAdapter(ch.type).deleteTemplate({ channel: ch, cfg: channelConfig(ch) }, req.params.name);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- admin: API keys / webhooks
export const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get('/api-keys', h(async (req, res) => {
  res.json((await pool.query('SELECT id, name, key_prefix, last_used_at, created_at FROM api_keys ORDER BY id')).rows);
}));
adminRouter.post('/api-keys', h(async (req, res) => {
  const key = `ock_${randomToken(30)}`;
  const row = (await pool.query('INSERT INTO api_keys (name, key_hash, key_prefix, created_by) VALUES ($1,$2,$3,$4) RETURNING id, name, key_prefix, created_at',
    [req.body?.name || 'API key', sha256(key), key.slice(0, 10), req.user.id])).rows[0];
  res.status(201).json({ ...row, key }); // shown once
}));
adminRouter.delete('/api-keys/:id', h(async (req, res) => {
  await pool.query('DELETE FROM api_keys WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

adminRouter.get('/webhooks', h(async (req, res) => {
  res.json((await pool.query('SELECT * FROM webhooks ORDER BY id')).rows);
}));
adminRouter.post('/webhooks', h(async (req, res) => {
  const { url, events } = req.body || {};
  if (!/^https?:\/\//.test(url || '')) throw bad('A valid URL is required');
  const row = (await pool.query('INSERT INTO webhooks (url, secret, events) VALUES ($1,$2,$3) RETURNING *',
    [url, randomToken(24), Array.isArray(events) && events.length ? events : ['*']])).rows[0];
  invalidateWebhooks();
  res.status(201).json(row);
}));
adminRouter.patch('/webhooks/:id', h(async (req, res) => {
  const { url, events, is_active } = req.body || {};
  const row = (await pool.query('UPDATE webhooks SET url = COALESCE($2, url), events = COALESCE($3, events), is_active = COALESCE($4, is_active) WHERE id = $1 RETURNING *',
    [req.params.id, url || null, Array.isArray(events) ? events : null, is_active ?? null])).rows[0];
  invalidateWebhooks();
  res.json(row);
}));
adminRouter.delete('/webhooks/:id', h(async (req, res) => {
  await pool.query('DELETE FROM webhooks WHERE id = $1', [req.params.id]);
  invalidateWebhooks();
  res.json({ ok: true });
}));
adminRouter.post('/webhooks/:id/test', h(async (req, res) => {
  const hook = (await pool.query('SELECT * FROM webhooks WHERE id = $1', [req.params.id])).rows[0];
  if (!hook) throw notFound();
  res.json(await deliverWebhook(hook, { event: 'ping', data: { hello: 'omnichat' }, at: new Date().toISOString() }));
}));

// ---------------------------------------------------------------- embed
// The host project's backend (API key) asks for an embed URL for one of its
// customers; the returned page shows only that contact's conversations and
// can be put into an <iframe> inside the host's own UI.
export const embedRouter = express.Router();
embedRouter.use(requireAuth);
embedRouter.post('/token', requireAdmin, h(async (req, res) => {
  const { contact_id, external_ref, phone, user_id, user_email, ttl } = req.body || {};
  let contactId = contact_id ? Number(contact_id) : null;
  if (!contactId && external_ref) contactId = (await pool.query('SELECT id FROM contacts WHERE external_ref = $1 ORDER BY id LIMIT 1', [String(external_ref)])).rows[0]?.id;
  if (!contactId && phone) contactId = (await pool.query('SELECT id FROM contacts WHERE phone = $1 ORDER BY id LIMIT 1', [`+${String(phone).replace(/\D/g, '')}`])).rows[0]?.id;
  if (!contactId) throw notFound('Contact not found - start a conversation first (POST /api/conversations/start)');
  const user = (await pool.query(
    user_id ? 'SELECT * FROM users WHERE id = $1' : user_email ? 'SELECT * FROM users WHERE lower(email) = lower($1)' : `SELECT * FROM users WHERE role = 'admin' AND is_active ORDER BY id LIMIT 1`,
    user_id ? [user_id] : user_email ? [user_email] : [])).rows[0];
  if (!user) throw bad('Agent user not found');
  const token = signToken(user, { scope: { contact_id: contactId }, expiresIn: ttl || '12h' });
  res.json({ token, contact_id: contactId, url: `${config.publicUrl}/embed/${contactId}?token=${encodeURIComponent(token)}` });
}));

// ---------------------------------------------------------------- signed files
export const filesRouter = express.Router();
filesRouter.get('/:kind/:id', h(async (req, res) => {
  const { kind, id } = req.params;
  if (!['m', 'a'].includes(kind) || !verifySigned(kind, id, req.query.e, req.query.s)) return res.sendStatus(403);
  const row = kind === 'm'
    ? (await pool.query('SELECT media_path AS p, media_mime AS mime, media_name AS name FROM messages WHERE id = $1', [id])).rows[0]
    : (await pool.query(`SELECT avatar_path AS p, 'image/jpeg' AS mime FROM contacts WHERE id = $1`, [id])).rows[0];
  if (!row?.p || !fs.existsSync(absMedia(row.p))) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (req.query.download && row.name) res.attachment(row.name);
  res.sendFile(absMedia(row.p), { headers: row.mime ? { 'Content-Type': row.mime } : {} });
}));
