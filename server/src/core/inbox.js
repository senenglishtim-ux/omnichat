// Channel-agnostic heart of the inbox. Adapters (channels/*.js) translate a
// messenger's webhook/socket events into the calls below, and implement
// send/react/markRead; everything else (contacts, conversations, statuses,
// unread counters, media storage, live events, queueing) lives here once.
import fs from 'node:fs';
import { pool, tx } from '../db/pool.js';
import { emit } from '../lib/events.js';
import { log } from '../lib/log.js';
import { saveBuffer, absMedia, kindFromMime, baseMime, moveIntoStorage } from '../lib/media.js';
import { getAdapter, channelConfig, windowInfo } from '../channels/index.js';
import { loadMessage, loadConversation } from './serialize.js';

export class InboxError extends Error {
  constructor(code, message, status = 400) { super(message || code); this.code = code; this.status = status; }
}

const normPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 7 ? `+${d}` : null;
};

async function emitMessage(type, id) {
  const m = await loadMessage(id);
  if (!m) return null;
  emit(type, { conversation_id: m.conversation_id, contact_id: m.contact_id, channel_id: m.channel_id, message: m });
  return m;
}
export async function emitConversation(id) {
  const c = await loadConversation(id);
  if (c) emit('conversation.updated', { conversation_id: c.id, contact_id: c.contact_id, conversation: c });
  return c;
}

// ---------------------------------------------------------------- inbound

async function upsertConversation(db, channel, chatId, contactInfo = {}, meta = null) {
  const existing = (await db.query('SELECT * FROM conversations WHERE channel_id = $1 AND external_id = $2 FOR UPDATE',
    [channel.id, String(chatId)])).rows[0];
  const phone = normPhone(contactInfo.phone);
  if (existing) {
    if (meta) await db.query(`UPDATE conversations SET meta = meta || $2::jsonb WHERE id = $1`, [existing.id, JSON.stringify(meta)]);
    // Fill contact gaps (never overwrite a name an agent may have edited).
    await db.query(
      `UPDATE contacts SET name = COALESCE(name, $2), phone = COALESCE(phone, $3), username = COALESCE($4, username), updated_at = now()
       WHERE id = $1`, [existing.contact_id, contactInfo.name || null, phone, contactInfo.username || null]);
    return { conversation: existing, created: false };
  }
  // Same phone on another channel (e.g. WhatsApp Cloud + WhatsApp Web) = same person.
  let contactId = null;
  if (phone) contactId = (await db.query('SELECT id FROM contacts WHERE phone = $1 ORDER BY id LIMIT 1', [phone])).rows[0]?.id;
  if (!contactId) {
    contactId = (await db.query('INSERT INTO contacts (name, phone, username) VALUES ($1,$2,$3) RETURNING id',
      [contactInfo.name || null, phone, contactInfo.username || null])).rows[0].id;
  }
  const conv = (await db.query(
    `INSERT INTO conversations (channel_id, contact_id, external_id, meta) VALUES ($1,$2,$3,$4)
     ON CONFLICT (channel_id, external_id) DO UPDATE SET meta = conversations.meta || EXCLUDED.meta
     RETURNING *`, [channel.id, contactId, String(chatId), JSON.stringify(meta || {})])).rows[0];
  return { conversation: conv, created: true };
}

/**
 * ev = {
 *   chatId, contact: { name, phone, username, avatar: async () => ({buffer, mime}) },
 *   meta,                       // merged into conversations.meta
 *   message: { externalId, direction: 'in'|'out', type, text, payload, replyToExternal,
 *              sentAt, raw, senderLabel, media: { mime, name, size, fetch: async () => ({buffer, mime, name}) } }
 * }
 * Returns the stored message, or null if it was a duplicate.
 */
export async function ingestInbound(channel, ev) {
  const msg = ev.message;
  const direction = msg.direction === 'out' ? 'out' : 'in';
  const result = await tx(async (db) => {
    const { conversation, created } = await upsertConversation(db, channel, ev.chatId, ev.contact, ev.meta);
    if (msg.externalId) {
      const dup = (await db.query('SELECT id FROM messages WHERE conversation_id = $1 AND external_id = $2', [conversation.id, msg.externalId])).rows[0];
      if (dup) return { duplicate: true, conversation };
    }
    let replyToId = null;
    if (msg.replyToExternal) {
      replyToId = (await db.query('SELECT id FROM messages WHERE conversation_id = $1 AND external_id = $2', [conversation.id, msg.replyToExternal])).rows[0]?.id || null;
    }
    const sentAt = msg.sentAt ? new Date(msg.sentAt) : new Date();
    const row = (await db.query(
      `INSERT INTO messages (conversation_id, direction, external_id, status, type, text, payload, reply_to_id, reply_to_external,
                             media_mime, media_name, media_size, media_status, sender_label, raw, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [conversation.id, direction, msg.externalId || null, direction === 'in' ? 'received' : (msg.status || 'sent'),
        msg.type || 'text', msg.text ?? null, msg.payload ? JSON.stringify(msg.payload) : null, replyToId, msg.replyToExternal || null,
        msg.media?.mime || null, msg.media?.name || null, msg.media?.size || null, msg.media ? 'pending' : null,
        msg.senderLabel || null, msg.raw ? JSON.stringify(msg.raw) : null, sentAt]
    )).rows[0];
    await db.query(
      `UPDATE conversations SET last_message_id = $2, last_message_at = now(),
         ${direction === 'in' ? 'last_inbound_at = GREATEST(COALESCE(last_inbound_at, $3), $3), unread_count = unread_count + 1, status = \'open\'' : 'last_outbound_at = GREATEST(COALESCE(last_outbound_at, $3), $3)'}
       WHERE id = $1`, [conversation.id, row.id, sentAt]);
    return { id: row.id, conversation, created };
  });
  if (result.duplicate) return null;

  const stored = await emitMessage('message.created', result.id);
  await emitConversation(result.conversation.id);

  if (msg.media?.fetch) fetchMedia(channel, result.id, msg.media).catch(() => {});
  if (ev.contact?.avatar) refreshAvatar(result.conversation.contact_id, ev.contact.avatar).catch(() => {});
  return stored;
}

async function fetchMedia(channel, messageId, media) {
  try {
    const got = await media.fetch();
    const mime = baseMime(got.mime || media.mime) || null;
    const name = got.name || media.name || null;
    const saved = got.buffer ? saveBuffer(channel.id, got.buffer, mime, name) : moveIntoStorage(channel.id, got.path, mime, name);
    await pool.query(
      `UPDATE messages SET media_path = $2, media_mime = COALESCE($3, media_mime), media_size = $4, media_name = COALESCE(media_name, $5),
         media_status = 'ready', media_error = NULL, updated_at = now() WHERE id = $1`,
      [messageId, saved.path, mime, saved.size, name]);
  } catch (err) {
    log.warn({ messageId, err: err.message }, 'media download failed');
    await pool.query(`UPDATE messages SET media_status = 'failed', media_error = $2, updated_at = now() WHERE id = $1`, [messageId, String(err.message).slice(0, 500)]);
  }
  await emitMessage('message.updated', messageId);
}

const AVATAR_TTL_MS = 7 * 24 * 3600 * 1000;
async function refreshAvatar(contactId, fetcher) {
  const c = (await pool.query('SELECT avatar_path, avatar_checked_at FROM contacts WHERE id = $1', [contactId])).rows[0];
  if (!c || (c.avatar_checked_at && Date.now() - new Date(c.avatar_checked_at).getTime() < AVATAR_TTL_MS)) return;
  await pool.query('UPDATE contacts SET avatar_checked_at = now() WHERE id = $1', [contactId]);
  const got = await fetcher().catch(() => null);
  if (!got?.buffer?.length) return;
  const saved = saveBuffer('avatars', got.buffer, got.mime || 'image/jpeg');
  await pool.query('UPDATE contacts SET avatar_path = $2 WHERE id = $1', [contactId, saved.path]);
}

// Delivery receipts. Ranked so a late "sent" never downgrades "read".
// A status can arrive before our own send recorded the external id (seen
// with WhatsApp Cloud), so unknown ids are retried a few times.
const RANK = { pending: 0, sent: 1, failed: 2, delivered: 3, read: 4, played: 5 };
const RETRY_MS = [250, 600, 1200, 2500];
export async function updateStatus(channelId, externalId, status, error = null, attempt = 0) {
  if (!(status in RANK) || !externalId) return;
  const r = (await pool.query(
    `SELECT m.id, m.status FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel_id = $1 AND m.external_id = $2 AND m.direction = 'out'`, [channelId, externalId])).rows[0];
  if (!r) {
    if (attempt < RETRY_MS.length) {
      await new Promise((res) => setTimeout(res, RETRY_MS[attempt]));
      return updateStatus(channelId, externalId, status, error, attempt + 1);
    }
    log.debug({ channelId, externalId, status }, 'status for unknown message');
    return;
  }
  if (RANK[status] <= (RANK[r.status] ?? -1)) return;
  await pool.query('UPDATE messages SET status = $2, error = COALESCE($3, error), updated_at = now() WHERE id = $1', [r.id, status, error]);
  await emitMessage('message.updated', r.id);
}

// The target of a reaction/edit/delete may still be on its way into the DB
// (webhooks are processed concurrently), so a miss is retried briefly.
async function findByExternal(channelId, externalId, attempt = 0) {
  const row = await findByExternalOnce(channelId, externalId);
  if (row || attempt >= RETRY_MS.length) return row;
  await new Promise((res) => setTimeout(res, RETRY_MS[attempt] * 2));
  return findByExternal(channelId, externalId, attempt + 1);
}
async function findByExternalOnce(channelId, externalId) {
  return (await pool.query(
    `SELECT m.id, m.conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.channel_id = $1 AND m.external_id = $2 ORDER BY m.id DESC LIMIT 1`, [channelId, externalId])).rows[0];
}

// side: 'in' (the contact reacted) | 'out' (we reacted from another device).
export async function setReaction(channelId, targetExternalId, side, emoji) {
  const m = await findByExternal(channelId, targetExternalId);
  if (!m) return;
  await pool.query(`UPDATE messages SET ${side === 'out' ? 'reaction_out' : 'reaction_in'} = $2, updated_at = now() WHERE id = $1`, [m.id, emoji || null]);
  await emitMessage('message.updated', m.id);
}

export async function markDeleted(channelId, externalId) {
  const m = await findByExternal(channelId, externalId);
  if (!m) return;
  await pool.query('UPDATE messages SET deleted_at = now(), updated_at = now() WHERE id = $1', [m.id]);
  await emitMessage('message.updated', m.id);
}

export async function applyEdit(channelId, externalId, text) {
  const m = await findByExternal(channelId, externalId);
  if (!m) return;
  await pool.query('UPDATE messages SET text = $2, edited_at = now(), updated_at = now() WHERE id = $1', [m.id, text]);
  await emitMessage('message.updated', m.id);
}

// Inbound messages read by the contact's side (e.g. Instagram "seen" of our message).
export async function markOutboundReadUpTo(conversationId, at = new Date()) {
  const r = await pool.query(
    `UPDATE messages SET status = 'read', updated_at = now()
     WHERE conversation_id = $1 AND direction = 'out' AND status IN ('sent', 'delivered') AND created_at <= $2 RETURNING id`,
    [conversationId, at]);
  for (const row of r.rows) await emitMessage('message.updated', row.id);
}

// ---------------------------------------------------------------- outbound

async function loadContext(conversationId) {
  const conv = (await pool.query('SELECT * FROM conversations WHERE id = $1', [conversationId])).rows[0];
  if (!conv) throw new InboxError('not_found', 'Conversation not found', 404);
  const channel = (await pool.query('SELECT * FROM channels WHERE id = $1', [conv.channel_id])).rows[0];
  if (!channel?.is_active) throw new InboxError('channel_inactive', 'Channel is disabled');
  const contact = (await pool.query('SELECT * FROM contacts WHERE id = $1', [conv.contact_id])).rows[0];
  return { conv, channel, contact, cfg: channelConfig(channel), adapter: getAdapter(channel.type) };
}

function assertWindow(ctx, type) {
  if (type === 'template' || type === 'note') return;
  const w = windowInfo(ctx.channel.type, ctx.channel.config, ctx.conv.last_inbound_at);
  if (w && !w.open) {
    throw new InboxError('window_closed', ctx.adapter.capabilities.templates
      ? 'The 24-hour window is closed — send an approved template to restart the conversation'
      : 'The messaging window is closed — the contact has to write first', 409);
  }
}

/**
 * Queue an outgoing message. The row is stored immediately (status
 * 'pending', visible in the UI at once) and delivered in the background in
 * per-conversation order; failures end up as status 'failed' + error, with
 * retry available.
 * input: { type?, text, file: {path, mime, name, size}, voice: bool, replyToId, template: {name, language, params}, clientRef }
 */
export async function sendMessage(user, conversationId, input) {
  const ctx = await loadContext(conversationId);
  const caps = ctx.adapter.capabilities;
  let type = input.template ? 'template' : input.file ? (input.voice ? 'voice' : kindFromMime(input.file.mime)) : 'text';
  if (type === 'text' && !String(input.text || '').trim()) throw new InboxError('empty', 'Message is empty');
  if (type === 'template' && !caps.templates) throw new InboxError('unsupported', 'This channel has no templates');
  if (input.replyToId && !caps.reply) input.replyToId = null;
  assertWindow(ctx, type);

  let text = input.text || null;
  let payload = null;
  if (type === 'template') {
    const tpl = (await pool.query('SELECT * FROM templates WHERE channel_id = $1 AND name = $2 AND language = $3',
      [ctx.channel.id, input.template.name, input.template.language || 'en'])).rows[0];
    if (!tpl) throw new InboxError('template_not_found', 'Template not found', 404);
    const params = input.template.params || {};
    text = ctx.adapter.renderTemplate ? ctx.adapter.renderTemplate(tpl, params) : tpl.name;
    payload = { template: { name: tpl.name, language: tpl.language, params, header: input.template.header || null } };
  }

  let media = {};
  if (input.file) {
    const saved = moveIntoStorage(ctx.channel.id, input.file.path, input.file.mime, input.file.name);
    media = { path: saved.path, mime: baseMime(input.file.mime), name: input.file.name || null, size: saved.size };
  }
  const row = (await pool.query(
    `INSERT INTO messages (conversation_id, direction, status, type, text, payload, reply_to_id, media_path, media_mime, media_name, media_size,
                           media_status, sender_user_id, sender_label, client_ref)
     VALUES ($1,'out','pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [conversationId, type, text, payload ? JSON.stringify(payload) : null, input.replyToId || null, media.path || null, media.mime || null,
      media.name || null, media.size || null, media.path ? 'ready' : null, user?.id || null, user?.isApi ? user.name : null, input.clientRef || null]
  )).rows[0];
  await pool.query(`UPDATE conversations SET last_message_id = $2, last_message_at = now(), last_outbound_at = now() WHERE id = $1`, [conversationId, row.id]);
  const stored = await emitMessage('message.created', row.id);
  await emitConversation(conversationId);
  enqueue(conversationId, () => deliver(row.id));
  return stored;
}

const queues = new Map();
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job).catch((err) => log.error({ err: err.message }, 'queue job failed'));
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
}

async function deliver(messageId) {
  const m = (await pool.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
  if (!m || m.status !== 'pending') return;
  let ctx;
  try {
    ctx = await loadContext(m.conversation_id);
    const replyTo = m.reply_to_id ? (await pool.query('SELECT id, external_id, raw, direction FROM messages WHERE id = $1', [m.reply_to_id])).rows[0] : null;
    const file = m.media_path ? { path: absMedia(m.media_path), mime: m.media_mime, name: m.media_name, size: m.media_size, messageId: m.id } : null;
    const res = await ctx.adapter.send({ ...ctx, message: m, file, replyTo });
    await pool.query(
      `UPDATE messages SET status = CASE WHEN status = 'pending' THEN $2 ELSE status END, external_id = COALESCE($3, external_id),
         raw = COALESCE($4, raw), sent_at = now(), error = NULL, updated_at = now() WHERE id = $1`,
      [messageId, res?.status || 'sent', res?.externalId || null, res?.raw ? JSON.stringify(res.raw) : null]);
  } catch (err) {
    log.warn({ messageId, channel: ctx?.channel?.id, err: err.message }, 'send failed');
    await pool.query(`UPDATE messages SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [messageId, String(err.message).slice(0, 1000)]);
  }
  await emitMessage('message.updated', messageId);
}

export async function retryMessage(messageId) {
  const m = (await pool.query(`UPDATE messages SET status = 'pending', error = NULL, updated_at = now()
     WHERE id = $1 AND direction = 'out' AND status = 'failed' RETURNING conversation_id`, [messageId])).rows[0];
  if (!m) throw new InboxError('not_failed', 'Only failed messages can be retried');
  await emitMessage('message.updated', messageId);
  enqueue(m.conversation_id, () => deliver(messageId));
}

export async function addNote(user, conversationId, text) {
  if (!String(text || '').trim()) throw new InboxError('empty', 'Note is empty');
  const row = (await pool.query(
    `INSERT INTO messages (conversation_id, direction, status, type, text, sender_user_id, sender_label)
     VALUES ($1,'note','sent','note',$2,$3,$4) RETURNING id`, [conversationId, text, user?.id || null, user?.isApi ? user.name : null])).rows[0];
  return emitMessage('message.created', row.id);
}

export async function reactToMessage(user, messageId, emoji) {
  const m = (await pool.query('SELECT * FROM messages WHERE id = $1', [messageId])).rows[0];
  if (!m || m.direction === 'note') throw new InboxError('not_found', 'Message not found', 404);
  if (!m.external_id) throw new InboxError('not_sent', 'Message has not been delivered yet');
  const ctx = await loadContext(m.conversation_id);
  const allowed = ctx.adapter.capabilities.reactions;
  if (!allowed) throw new InboxError('unsupported', 'Reactions are not supported on this channel');
  if (emoji && Array.isArray(allowed) && !allowed.includes(emoji)) throw new InboxError('unsupported', `Only ${allowed.join(' ')} is supported on this channel`);
  assertWindow(ctx, 'reaction');
  await ctx.adapter.react({ ...ctx, target: m, emoji: emoji || '' });
  await pool.query('UPDATE messages SET reaction_out = $2, updated_at = now() WHERE id = $1', [messageId, emoji || null]);
  return emitMessage('message.updated', messageId);
}

export async function markConversationRead(conversationId) {
  const r = await pool.query('UPDATE conversations SET unread_count = 0 WHERE id = $1 AND unread_count > 0 RETURNING id', [conversationId]);
  const unseen = (await pool.query(
    `UPDATE messages SET status = 'read' WHERE id IN (
       SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' AND status = 'received' ORDER BY id DESC LIMIT 50)
     RETURNING id, external_id, raw`, [conversationId])).rows;
  if (unseen.length) {
    try {
      const ctx = await loadContext(conversationId);
      if (ctx.adapter.markRead && ctx.cfg.send_read_receipts !== false) await ctx.adapter.markRead({ ...ctx, messages: unseen });
    } catch (err) { log.debug({ err: err.message }, 'markRead failed'); }
  }
  if (r.rowCount) await emitConversation(conversationId);
}

export function readMediaFile(rel) {
  const p = absMedia(rel);
  return fs.existsSync(p) ? p : null;
}

// An adapter converted the agent's file for its messenger (e.g. voice note
// to m4a for Instagram) - the message now points at the converted file.
export async function replaceMessageMedia(messageId, tmpPath, mime) {
  const m = (await pool.query('SELECT m.media_path, c.channel_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1', [messageId])).rows[0];
  if (!m) return;
  const saved = moveIntoStorage(m.channel_id, tmpPath, mime);
  await pool.query('UPDATE messages SET media_path = $2, media_mime = $3, media_size = $4, updated_at = now() WHERE id = $1', [messageId, saved.path, baseMime(mime), saved.size]);
  if (m.media_path) fs.unlink(absMedia(m.media_path), () => {});
}
