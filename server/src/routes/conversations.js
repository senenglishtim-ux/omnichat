import express from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { requireAuth, requireUnscoped, scopeAllows } from '../lib/auth.js';
import { downloadBuffer } from '../lib/http.js';
import { mimeFromName, extFor } from '../lib/media.js';
import * as inbox from '../core/inbox.js';
import { CONVERSATION_SELECT, serializeConversation, MESSAGE_SELECT, serializeMessage, loadConversation } from '../core/serialize.js';
import { getAdapter, channelConfig, loadChannel } from '../channels/index.js';
import { h, bad, notFound } from './util.js';

export const conversationsRouter = express.Router();
conversationsRouter.use(requireAuth);

const upload = multer({ dest: path.join(os.tmpdir(), 'omnichat-uploads'), limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });

async function loadVisible(req, id) {
  const c = (await pool.query('SELECT id, contact_id FROM conversations WHERE id = $1', [id])).rows[0];
  if (!c || !scopeAllows(req.user, c.contact_id)) throw notFound('Conversation not found');
  return c;
}

// List with filters: q (name/phone/username/message text), channel_id,
// status, filter = mine|unassigned|awaiting|unread, contact_id, external_ref.
conversationsRouter.get('/', h(async (req, res) => {
  const where = []; const vals = [];
  const p = (v) => { vals.push(v); return `$${vals.length}`; };
  const q = String(req.query.q || '').trim();
  if (q) {
    const like = p(`%${q}%`);
    where.push(`(ct.name ILIKE ${like} OR ct.phone ILIKE ${like} OR ct.username ILIKE ${like}
      OR EXISTS (SELECT 1 FROM messages s WHERE s.conversation_id = c.id AND s.text ILIKE ${like}))`);
  }
  if (req.query.channel_id) where.push(`c.channel_id = ${p(Number(req.query.channel_id))}`);
  if (req.query.status) where.push(`c.status = ${p(req.query.status)}`);
  if (req.query.contact_id) where.push(`c.contact_id = ${p(Number(req.query.contact_id))}`);
  if (req.query.external_ref) where.push(`ct.external_ref = ${p(String(req.query.external_ref))}`);
  if (req.user.scope?.contact_id) where.push(`c.contact_id = ${p(Number(req.user.scope.contact_id))}`);
  const f = req.query.filter;
  if (f === 'mine' && req.user.id) where.push(`c.assigned_user_id = ${p(req.user.id)}`);
  if (f === 'unassigned') where.push('c.assigned_user_id IS NULL');
  if (f === 'unread') where.push('c.unread_count > 0');
  if (f === 'awaiting') where.push(`EXISTS (SELECT 1 FROM messages lm2 WHERE lm2.id = c.last_message_id) AND
    (SELECT max(created_at) FROM messages x WHERE x.conversation_id = c.id AND x.direction = 'in') >
    COALESCE((SELECT max(created_at) FROM messages x WHERE x.conversation_id = c.id AND x.direction = 'out'), 'epoch')`);
  if (req.query.before) where.push(`c.last_message_at < ${p(new Date(req.query.before))}`);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const order = f === 'awaiting' ? 'last_in_at ASC' : 'c.last_message_at DESC NULLS LAST, c.id DESC';
  const rows = (await pool.query(`SELECT * FROM (${CONVERSATION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}) c ORDER BY ${order.replace('c.', '')} LIMIT ${limit}`, vals)).rows;
  const counts = req.user.scope ? null : (await pool.query(`
    SELECT count(*) FILTER (WHERE unread_count > 0)::int AS unread,
           count(*) FILTER (WHERE assigned_user_id = $1)::int AS mine
    FROM conversations WHERE status = 'open'`, [req.user.id || 0])).rows[0];
  res.json({ items: rows.map(serializeConversation), counts });
}));

// Start (or find) a conversation from the host project: { channel_id, phone | chat_id, name, external_ref }.
conversationsRouter.post('/start', requireUnscoped, h(async (req, res) => {
  const { channel_id, phone, chat_id, name, external_ref } = req.body || {};
  const ch = await loadChannel(Number(channel_id));
  if (!ch) throw bad('Unknown channel');
  let chatId = chat_id ? String(chat_id) : null;
  const digits = String(phone || '').replace(/\D/g, '');
  if (!chatId) {
    if (!digits) throw bad('phone or chat_id is required');
    if (ch.type === 'whatsapp_cloud') chatId = digits;
    else if (ch.type === 'whatsapp_web') {
      const r = await getAdapter(ch.type).lookup({ channel: ch, cfg: channelConfig(ch) }, digits);
      if (!r.exists) throw bad('This number is not on WhatsApp', 'not_on_whatsapp');
      chatId = r.chatId;
    } else throw bad('Instagram and Telegram conversations can only be started by the contact');
  }
  const existing = (await pool.query('SELECT id FROM conversations WHERE channel_id = $1 AND external_id = $2', [ch.id, chatId])).rows[0];
  let id = existing?.id;
  if (!id) {
    const phoneE164 = digits ? `+${digits}` : null;
    let contactId = phoneE164 ? (await pool.query('SELECT id FROM contacts WHERE phone = $1 ORDER BY id LIMIT 1', [phoneE164])).rows[0]?.id : null;
    if (!contactId && external_ref) contactId = (await pool.query('SELECT id FROM contacts WHERE external_ref = $1 ORDER BY id LIMIT 1', [String(external_ref)])).rows[0]?.id;
    if (!contactId) contactId = (await pool.query('INSERT INTO contacts (name, phone, external_ref) VALUES ($1,$2,$3) RETURNING id', [name || null, phoneE164, external_ref || null])).rows[0].id;
    id = (await pool.query('INSERT INTO conversations (channel_id, contact_id, external_id, last_message_at) VALUES ($1,$2,$3, now()) RETURNING id', [ch.id, contactId, chatId])).rows[0].id;
  }
  if (external_ref) await pool.query('UPDATE contacts SET external_ref = COALESCE(external_ref, $2) WHERE id = (SELECT contact_id FROM conversations WHERE id = $1)', [id, String(external_ref)]);
  const conv = await loadConversation(id);
  if (!scopeAllows(req.user, conv.contact_id)) throw notFound();
  res.status(existing ? 200 : 201).json(conv);
}));

conversationsRouter.get('/:id', h(async (req, res) => {
  await loadVisible(req, req.params.id);
  res.json(await loadConversation(req.params.id));
}));

conversationsRouter.patch('/:id', h(async (req, res) => {
  await loadVisible(req, req.params.id);
  const { assigned_user_id, status } = req.body || {};
  if (assigned_user_id !== undefined) await pool.query('UPDATE conversations SET assigned_user_id = $2 WHERE id = $1', [req.params.id, assigned_user_id || null]);
  if (status) await pool.query('UPDATE conversations SET status = $2 WHERE id = $1', [req.params.id, status === 'closed' ? 'closed' : 'open']);
  res.json(await inbox.emitConversation(Number(req.params.id)));
}));

conversationsRouter.post('/:id/read', h(async (req, res) => {
  await loadVisible(req, req.params.id);
  await inbox.markConversationRead(Number(req.params.id));
  res.json({ ok: true });
}));

// Messages, newest page first: ?before=<message id>&limit=
conversationsRouter.get('/:id/messages', h(async (req, res) => {
  await loadVisible(req, req.params.id);
  const limit = Math.min(200, Number(req.query.limit) || 60);
  const vals = [req.params.id];
  let extra = '';
  if (req.query.before) { vals.push(Number(req.query.before)); extra = ` AND m.id < $${vals.length}`; }
  if (req.query.after) { vals.push(Number(req.query.after)); extra += ` AND m.id > $${vals.length}`; }
  const rows = (await pool.query(`${MESSAGE_SELECT} WHERE m.conversation_id = $1${extra} ORDER BY m.id DESC LIMIT ${limit}`, vals)).rows;
  res.json({ items: rows.map(serializeMessage).reverse(), has_more: rows.length === limit });
}));

// Send: JSON { text, reply_to_id, template: {name, language, params}, media_url, client_ref }
// or multipart with "file" (+ text as caption, voice=1 for a voice note).
conversationsRouter.post('/:id/messages', upload.single('file'), h(async (req, res) => {
  await loadVisible(req, req.params.id);
  const b = req.body || {};
  let file = null;
  if (req.file) {
    file = { path: req.file.path, mime: req.file.mimetype && req.file.mimetype !== 'application/octet-stream' ? req.file.mimetype : mimeFromName(req.file.originalname), name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), size: req.file.size };
  } else if (b.media_url) {
    const got = await downloadBuffer(b.media_url);
    const name = b.media_name || path.basename(new URL(b.media_url).pathname) || 'file';
    const mime = got.mime && got.mime !== 'application/octet-stream' ? got.mime : mimeFromName(name);
    const tmp = path.join(os.tmpdir(), `omnichat-${Date.now()}${extFor(mime, name)}`);
    fs.writeFileSync(tmp, got.buffer);
    file = { path: tmp, mime, name, size: got.buffer.length };
  }
  let template = b.template;
  if (typeof template === 'string') { try { template = JSON.parse(template); } catch { throw bad('template must be JSON'); } }
  try {
    const m = await inbox.sendMessage(req.user, Number(req.params.id), {
      text: b.text || null, file, voice: b.voice === '1' || b.voice === true || b.voice === 'true',
      replyToId: b.reply_to_id ? Number(b.reply_to_id) : null, template, clientRef: b.client_ref || null,
    });
    res.status(201).json(m);
  } catch (err) {
    if (file && fs.existsSync(file.path)) fs.unlink(file.path, () => {});
    throw err;
  }
}));

conversationsRouter.post('/:id/notes', h(async (req, res) => {
  await loadVisible(req, req.params.id);
  res.status(201).json(await inbox.addNote(req.user, Number(req.params.id), req.body?.text));
}));

export const messagesRouter = express.Router();
messagesRouter.use(requireAuth);

async function visibleMessage(req) {
  const m = (await pool.query('SELECT m.id, c.contact_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1', [req.params.id])).rows[0];
  if (!m || !scopeAllows(req.user, m.contact_id)) throw notFound('Message not found');
}

messagesRouter.post('/:id/react', h(async (req, res) => {
  await visibleMessage(req);
  res.json(await inbox.reactToMessage(req.user, Number(req.params.id), String(req.body?.emoji || '')));
}));

messagesRouter.post('/:id/retry', h(async (req, res) => {
  await visibleMessage(req);
  await inbox.retryMessage(Number(req.params.id));
  res.json({ ok: true });
}));
