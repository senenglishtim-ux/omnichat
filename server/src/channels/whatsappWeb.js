// WhatsApp Web via Baileys (unofficial, multi-device protocol). Links like a
// regular "Linked device": scan a QR code or enter a pairing code on the
// phone. No 24-hour window and no templates, but it is not an official Meta
// API - accounts can get banned for spam-like use. Auth state lives in
// DATA_DIR/baileys/<channelId>.
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, normalizeMessageContent, getContentType,
  jidNormalizedUser, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, isLidUser, BufferJSON,
  generateMessageIDV2, Browsers, proto,
} from 'baileys';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { downloadBuffer } from '../lib/http.js';
import { baseMime, toOggOpus, toMp4Under, toJpeg, toMp3, cleanup } from '../lib/media.js';

const MB = 1024 * 1024;
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' });
const sessions = new Map(); // channelId -> session

const core = () => import('../core/inbox.js');
const registry = () => import('./index.js');

const authDir = (id) => path.join(config.baileysDir, String(id));
const toJson = (obj) => JSON.parse(JSON.stringify(obj, BufferJSON.replacer));
const fromJson = (obj) => JSON.parse(JSON.stringify(obj), BufferJSON.reviver);
const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

function skipJid(jid) {
  return !jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid);
}

async function setState(id, fields) {
  const { setChannelState } = await registry();
  await setChannelState(id, fields);
}

// ------------------------------------------------------------------ session

async function start({ channel, cfg }) {
  const existing = sessions.get(channel.id);
  if (existing && !existing.closed) return;
  const s = { channelId: channel.id, cfg, sock: null, closed: false, stopping: false, retries: 0, qrCount: 0, qr: null, pairingCode: null, sending: new Set() };
  sessions.set(channel.id, s);
  await connect(s);
}

async function connect(s) {
  fs.mkdirSync(authDir(s.channelId), { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir(s.channelId));
  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    browser: Browsers.macOS(s.cfg.device_name || 'Omnichat'),
    markOnlineOnConnect: false, // keep notifications on the phone
    syncFullHistory: false,
    getMessage: async (key) => {
      const r = (await pool.query(
        `SELECT m.raw FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_id = $1 AND m.external_id = $2 LIMIT 1`,
        [s.channelId, key.id])).rows[0];
      return r?.raw?.message ? fromJson(r.raw.message) : undefined;
    },
  });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    try {
      if (u.qr) {
        s.qrCount += 1;
        // Give up after ~5 QR rotations nobody scanned; "Connect" restarts it.
        if (s.qrCount > 5 && !sock.authState.creds.registered) {
          s.stopping = true; sock.end(undefined); s.closed = true; s.qr = null;
          await setState(s.channelId, { status: 'qr_timeout', status_detail: 'QR code was not scanned', qr: null });
          return;
        }
        s.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
        if (s.cfg.pairing_phone && !s.pairingCode && !sock.authState.creds.registered) {
          s.pairingCode = await sock.requestPairingCode(digits(s.cfg.pairing_phone)).catch((err) => { log.warn({ err: err.message }, 'pairing code failed'); return null; });
        }
        await setState(s.channelId, { status: 'qr', status_detail: null, qr: s.qr, pairing_code: s.pairingCode });
      }
      if (u.connection === 'open') {
        s.retries = 0; s.qr = null; s.qrCount = 0; s.pairingCode = null;
        const me = jidNormalizedUser(sock.user?.id);
        await setState(s.channelId, { status: 'connected', status_detail: sock.user?.name || null, account_id: me, account_label: `+${digits(me)}`, qr: null });
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (s.stopping) return;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
          s.closed = true; sessions.delete(s.channelId);
          fs.rmSync(authDir(s.channelId), { recursive: true, force: true });
          await setState(s.channelId, { status: 'logged_out', status_detail: 'Device was unlinked from the phone', qr: null });
          return;
        }
        if (s.closed) return;
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(60000, 1000 * 2 ** Math.min(s.retries, 6));
        s.retries += 1;
        await setState(s.channelId, { status: 'connecting', status_detail: `reconnecting (${code || 'network'})` });
        setTimeout(() => { if (!s.closed && !s.stopping) connect(s).catch((err) => log.error({ err: err.message }, 'baileys reconnect failed')); }, delay);
      }
      if (u.connection === 'connecting' && !s.qr) await setState(s.channelId, { status: 'connecting' });
    } catch (err) {
      log.error({ err: err.message }, 'baileys connection.update handler failed');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const m of messages) {
      try { await onMessage(s, m); } catch (err) { log.error({ err: err.message, stack: err.stack }, 'baileys message handling failed'); }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    const inbox = await core();
    for (const { key, update } of updates) {
      if (!key?.fromMe || update.status == null) continue;
      const st = { 0: 'failed', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'played' }[update.status];
      if (st) await inbox.updateStatus(s.channelId, key.id, st).catch(() => {});
    }
  });

  // Incoming calls can't be answered here - log them in the chat so nobody misses one.
  sock.ev.on('call', async (calls) => {
    for (const c of calls) {
      if (c.status !== 'offer' || c.isGroup) continue;
      const chat = await resolveChat(s, c.from);
      if (!chat) continue;
      const inbox = await core();
      await inbox.ingestInbound({ id: s.channelId }, {
        chatId: chat.chatId, contact: { phone: chat.phone },
        message: { externalId: `call:${c.id}`, direction: 'in', type: 'system', text: c.isVideo ? 'Incoming WhatsApp video call' : 'Incoming WhatsApp call', payload: { call: { video: !!c.isVideo } } },
      }).catch(() => {});
    }
  });
}

async function stop({ channel }) {
  const s = sessions.get(channel.id);
  if (!s) return;
  s.stopping = true; s.closed = true;
  try { s.sock?.end(undefined); } catch { /* already closed */ }
  sessions.delete(channel.id);
}

async function logout({ channel }) {
  const s = sessions.get(channel.id);
  if (s?.sock) { s.stopping = true; await s.sock.logout().catch(() => {}); }
  await stop({ channel });
  fs.rmSync(authDir(channel.id), { recursive: true, force: true });
  await setState(channel.id, { status: 'logged_out', status_detail: null, account_id: null, account_label: null, qr: null });
}

async function reconnect(ctx) {
  await stop(ctx);
  await start(ctx);
  return { ok: true };
}

function getQr({ channel }) {
  const s = sessions.get(channel.id);
  return { qr: s?.qr || null, pairing_code: s?.pairingCode || null };
}

async function remove(ctx) {
  await stop(ctx);
  fs.rmSync(authDir(ctx.channel.id), { recursive: true, force: true });
}

// ------------------------------------------------------------------ inbound

// LID chats are mapped to the phone-number JID whenever WhatsApp lets us
// know it, so a person keeps one conversation.
async function resolveChat(s, jid, alt) {
  if (skipJid(jid)) return null;
  let pn = null;
  if (isLidUser(jid)) {
    if (alt && !isLidUser(alt)) pn = alt;
    else pn = await s.sock?.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null);
  } else pn = jid;
  const chatId = pn ? jidNormalizedUser(pn) : jidNormalizedUser(jid);
  return { chatId, phone: pn ? digits(pn) : null, lid: isLidUser(jid) ? jid : null };
}

function vcardPhones(vcard) {
  const out = [];
  for (const m of String(vcard || '').matchAll(/waid=(\d+)|TEL[^:]*:([+\d\s()-]+)/g)) out.push(m[1] ? `+${m[1]}` : m[2].trim());
  return [...new Set(out)];
}

function describe(content, type) {
  const c = content[type] || {};
  const payload = {};
  if (c.contextInfo?.isForwarded) payload.forwarded = true;
  const replyToExternal = c.contextInfo?.stanzaId || null;
  switch (type) {
    case 'conversation': return { type: 'text', text: content.conversation };
    case 'extendedTextMessage': return { type: 'text', text: c.text, replyToExternal, payload };
    case 'imageMessage': return { type: 'image', text: c.caption || null, media: { mime: c.mimetype, size: Number(c.fileLength) || null }, replyToExternal, payload };
    case 'videoMessage': case 'ptvMessage':
      if (c.gifPlayback) payload.gif = true;
      if (type === 'ptvMessage') payload.round = true;
      return { type: 'video', text: c.caption || null, media: { mime: c.mimetype, size: Number(c.fileLength) || null }, replyToExternal, payload };
    case 'audioMessage': return { type: c.ptt ? 'voice' : 'audio', media: { mime: c.mimetype, size: Number(c.fileLength) || null }, replyToExternal, payload };
    case 'documentMessage': return { type: 'document', text: c.caption || null, media: { mime: c.mimetype, name: c.fileName || c.title || null, size: Number(c.fileLength) || null }, replyToExternal, payload };
    case 'stickerMessage': if (c.isAnimated) payload.animated = true; return { type: 'sticker', media: { mime: c.mimetype || 'image/webp' }, replyToExternal, payload };
    case 'locationMessage': case 'liveLocationMessage':
      payload.location = { latitude: c.degreesLatitude, longitude: c.degreesLongitude, name: c.name || null, address: c.address || null, live: type === 'liveLocationMessage' };
      return { type: 'location', text: [c.name, c.address].filter(Boolean).join(', ') || null, payload, replyToExternal };
    case 'contactMessage':
      payload.contacts = [{ name: c.displayName, phones: vcardPhones(c.vcard) }];
      return { type: 'contact', text: c.displayName, payload, replyToExternal };
    case 'contactsArrayMessage':
      payload.contacts = (c.contacts || []).map((x) => ({ name: x.displayName, phones: vcardPhones(x.vcard) }));
      return { type: 'contact', text: payload.contacts.map((x) => x.name).join(', '), payload };
    case 'pollCreationMessage': case 'pollCreationMessageV2': case 'pollCreationMessageV3':
      payload.poll = { name: c.name, options: (c.options || []).map((o) => o.optionName) };
      return { type: 'text', text: `📊 ${c.name}\n${payload.poll.options.map((o) => `• ${o}`).join('\n')}`, payload };
    case 'buttonsResponseMessage': return { type: 'text', text: c.selectedDisplayText, replyToExternal };
    case 'listResponseMessage': return { type: 'text', text: c.title || c.singleSelectReply?.selectedRowId, replyToExternal };
    case 'templateButtonReplyMessage': return { type: 'text', text: c.selectedDisplayText, replyToExternal };
    case 'interactiveResponseMessage': return { type: 'text', text: c.body?.text || 'Response', replyToExternal };
    case 'eventMessage': return { type: 'text', text: `📅 ${c.name || ''}${c.description ? `\n${c.description}` : ''}` };
    default: return null;
  }
}

async function onMessage(s, m) {
  const inbox = await core();
  const key = m.key || {};
  if (!m.message || skipJid(key.remoteJid)) return;
  if (key.fromMe && s.sending.has(key.id)) return; // our own send echoing back
  const content = normalizeMessageContent(m.message);
  const type = content && getContentType(content);
  if (!type) return;

  if (type === 'protocolMessage') {
    const p = content.protocolMessage;
    if (p.type === proto.Message.ProtocolMessage.Type.REVOKE && p.key?.id) await inbox.markDeleted(s.channelId, p.key.id);
    if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && p.key?.id) {
      const e = normalizeMessageContent(p.editedMessage);
      const t = e?.conversation || e?.extendedTextMessage?.text || e?.imageMessage?.caption || e?.videoMessage?.caption;
      if (t != null) await inbox.applyEdit(s.channelId, p.key.id, t);
    }
    return;
  }
  if (type === 'reactionMessage') {
    const r = content.reactionMessage;
    await inbox.setReaction(s.channelId, r.key?.id, key.fromMe ? 'out' : 'in', r.text || null);
    return;
  }
  const d = describe(content, type);
  if (!d) return;

  const chat = await resolveChat(s, key.remoteJid, key.remoteJidAlt);
  if (!chat) return;
  const sock = s.sock;
  const media = d.media ? {
    ...d.media,
    fetch: async () => ({
      buffer: await downloadMediaMessage(m, 'buffer', {}, { logger: baileysLogger, reuploadRequest: sock.updateMediaMessage }),
      mime: d.media.mime,
    }),
  } : null;
  await inbox.ingestInbound({ id: s.channelId }, {
    chatId: chat.chatId,
    meta: chat.lid ? { lid: chat.lid } : null,
    contact: {
      name: key.fromMe ? null : (m.pushName || null),
      phone: chat.phone,
      avatar: async () => {
        const url = await sock.profilePictureUrl(chat.chatId, 'image');
        return url ? downloadBuffer(url) : null;
      },
    },
    message: {
      externalId: key.id,
      direction: key.fromMe ? 'out' : 'in',
      senderLabel: key.fromMe ? 'phone' : null,
      type: d.type, text: d.text ?? null, payload: d.payload && Object.keys(d.payload).length ? d.payload : null,
      replyToExternal: d.replyToExternal || null,
      sentAt: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : new Date(),
      media,
      raw: toJson({ key: m.key, message: m.message, messageTimestamp: m.messageTimestamp, pushName: m.pushName }),
    },
  });
}

// ------------------------------------------------------------------ outbound

function liveSession(channelId) {
  const s = sessions.get(channelId);
  if (!s?.sock?.user || s.closed) throw new Error('WhatsApp Web is not connected - scan the QR code in channel settings');
  return s;
}
const toJid = (id) => (String(id).includes('@') ? id : `${digits(id)}@s.whatsapp.net`);

async function content(message, file) {
  const temps = [];
  const caption = message.text || undefined;
  if (!file) return { content: { text: message.text }, temps };
  const mime = baseMime(file.mime);
  const kind = message.type;
  if (kind === 'voice') {
    const r = await toOggOpus(file.path); temps.push(r.path);
    return { content: { audio: { url: r.path }, mimetype: 'audio/ogg; codecs=opus', ptt: true }, temps };
  }
  if (kind === 'image') {
    if (mime === 'image/gif') {
      const v = await toMp4Under(file.path, mime, 64 * MB).catch(() => null);
      if (v) { if (!v.same) temps.push(v.path); return { content: { video: { url: v.path }, gifPlayback: true, caption, mimetype: 'video/mp4' }, temps }; }
    }
    if (['image/jpeg', 'image/png'].includes(mime)) return { content: { image: { url: file.path }, caption, mimetype: mime }, temps };
    const j = await toJpeg(file.path).catch(() => null);
    if (j) { temps.push(j.path); return { content: { image: { url: j.path }, caption, mimetype: 'image/jpeg' }, temps }; }
  }
  if (kind === 'video') {
    const v = await toMp4Under(file.path, mime, 64 * MB).catch(() => null);
    if (v) { if (!v.same) temps.push(v.path); return { content: { video: { url: v.path }, caption, mimetype: 'video/mp4' }, temps }; }
  }
  if (kind === 'audio') {
    if (['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg'].includes(mime)) return { content: { audio: { url: file.path }, mimetype: mime }, temps };
    const a = await toMp3(file.path).catch(() => null);
    if (a) { temps.push(a.path); return { content: { audio: { url: a.path }, mimetype: 'audio/mpeg' }, temps }; }
  }
  return { content: { document: { url: file.path }, mimetype: mime || 'application/octet-stream', fileName: file.name || path.basename(file.path), caption }, temps };
}

async function send({ channel, conv, message, file, replyTo }) {
  const s = liveSession(channel.id);
  const jid = toJid(conv.external_id);
  const messageId = generateMessageIDV2(s.sock.user.id);
  // Record the id before sending: Baileys echoes our own message back via
  // messages.upsert, which must be recognised as this row, not a new one.
  await pool.query('UPDATE messages SET external_id = $2 WHERE id = $1', [message.id, messageId]);
  s.sending.add(messageId);
  const { content: c, temps } = await content(message, file);
  try {
    const opts = { messageId };
    if (replyTo?.raw?.key) opts.quoted = fromJson(replyTo.raw);
    const sent = await s.sock.sendMessage(jid, c, opts);
    return { externalId: sent?.key?.id || messageId, status: 'sent', raw: toJson({ key: sent.key, message: sent.message, messageTimestamp: sent.messageTimestamp }) };
  } catch (err) {
    await pool.query('UPDATE messages SET external_id = NULL WHERE id = $1', [message.id]);
    throw err;
  } finally {
    cleanup(...temps);
    setTimeout(() => s.sending.delete(messageId), 60000);
  }
}

function keyFor(conv, m) {
  if (m.raw?.key) return fromJson(m.raw.key);
  return { remoteJid: toJid(conv.external_id), id: m.external_id, fromMe: m.direction === 'out' };
}

async function react({ channel, conv, target, emoji }) {
  const s = liveSession(channel.id);
  await s.sock.sendMessage(toJid(conv.external_id), { react: { text: emoji || '', key: keyFor(conv, target) } });
}

async function markRead({ channel, conv, messages }) {
  const s = sessions.get(channel.id);
  if (!s?.sock?.user) return;
  await s.sock.readMessages(messages.filter((m) => m.external_id && !m.external_id.startsWith('call:')).map((m) => keyFor(conv, { ...m, direction: 'in' })));
}

async function test({ channel }) {
  const s = sessions.get(channel.id);
  if (!s?.sock?.user) throw new Error('Not connected');
  return { jid: s.sock.user.id, name: s.sock.user.name };
}

// Check whether a number has WhatsApp before starting a conversation.
async function lookup({ channel }, phone) {
  const s = liveSession(channel.id);
  const [r] = await s.sock.onWhatsApp(digits(phone));
  return r?.exists ? { exists: true, chatId: jidNormalizedUser(r.jid) } : { exists: false };
}

export default {
  type: 'whatsapp_web',
  title: 'WhatsApp Web (Baileys)',
  capabilities: { windowHours: null, templates: false, reactions: true, reply: true, voice: true, readReceipts: true, deliveryReceipts: true, qr: true },
  fields: [
    { key: 'device_name', label: 'Device name shown on the phone', default: () => 'Omnichat' },
    { key: 'pairing_phone', label: 'Phone for pairing code (optional, instead of QR)', help: 'International format, e.g. +77001234567' },
    { key: 'send_read_receipts', label: 'Send read receipts (blue ticks)', type: 'boolean', default: () => true },
  ],
  start, stop, send, react, markRead, test, lookup, remove,
  getQr,
  actions: { logout, reconnect },
};
