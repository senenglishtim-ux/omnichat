// Instagram Direct via the Instagram Messaging API (Instagram API with
// Instagram Login "IGAA..." tokens -> graph.instagram.com, or Facebook Login
// page tokens "EAA..." -> graph.facebook.com).
// Webhook: GET/POST {PUBLIC_URL}/webhooks/instagram, routed by entry.id.
// Outgoing media is sent by URL, so PUBLIC_URL must be reachable over https.
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { fetchJson, downloadBuffer } from '../lib/http.js';
import { log } from '../lib/log.js';
import { safeEqual, randomToken, encrypt } from '../lib/crypto.js';
import { baseMime, publicUrl, toM4a, toMp4Under, toJpeg } from '../lib/media.js';

const MB = 1024 * 1024;
const core = () => import('../core/inbox.js');
const registry = () => import('./index.js');

const isIgToken = (cfg) => String(cfg.access_token || '').startsWith('IG');
const host = (cfg) => (isIgToken(cfg) ? 'https://graph.instagram.com' : 'https://graph.facebook.com');
const ver = (cfg) => cfg.api_version || 'v21.0';
const api = (cfg, p) => `${host(cfg)}/${ver(cfg)}/${p}`;
const selfId = (cfg) => (isIgToken(cfg) ? 'me' : cfg.ig_user_id);

async function call(cfg, p, { method = 'GET', body, params = {} } = {}) {
  const qs = new URLSearchParams({ ...params, access_token: cfg.access_token });
  return fetchJson(`${api(cfg, p)}?${qs}`, {
    method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
}

// ------------------------------------------------------------------ profiles

const profileCache = new Map();
async function profile(cfg, igsid) {
  const c = profileCache.get(igsid);
  if (c && Date.now() - c.at < 6 * 3600e3) return c.p;
  const p = await call(cfg, igsid, { params: { fields: 'name,username,profile_pic' } }).catch((err) => { log.debug({ err: err.message }, 'ig profile failed'); return null; });
  profileCache.set(igsid, { p, at: Date.now() });
  return p;
}

// ------------------------------------------------------------------ outbound

const sentMids = new Map(); // mid -> timestamp, to recognise our own echoes
function rememberMid(mid) {
  if (!mid) return;
  sentMids.set(mid, Date.now());
  if (sentMids.size > 5000) for (const [k, t] of sentMids) if (Date.now() - t > 600000) sentMids.delete(k);
}

function tagFor(cfg, conv) {
  const hrs = conv.last_inbound_at ? (Date.now() - new Date(conv.last_inbound_at).getTime()) / 3600e3 : 999;
  return hrs > 24 && (cfg.human_agent_tag === true || cfg.human_agent_tag === 'true') ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : {};
}

async function postMessage(cfg, conv, message, replyTo) {
  const body = { recipient: { id: conv.external_id }, message, ...tagFor(cfg, conv) };
  if (replyTo?.external_id) body.reply_to = { mid: replyTo.external_id };
  try {
    return await call(cfg, `${selfId(cfg)}/messages`, { method: 'POST', body });
  } catch (err) {
    if (!body.reply_to) throw err;
    delete body.reply_to; // older API versions don't know reply_to
    return call(cfg, `${selfId(cfg)}/messages`, { method: 'POST', body });
  }
}

// Converts the stored file to a format Instagram accepts (replacing the
// message's media so the public URL points at the converted file).
async function prepare(message, file) {
  const inbox = await core();
  const mime = baseMime(file.mime);
  const kind = message.type;
  let conv = null;
  if (kind === 'voice' || (kind === 'audio' && !['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/mpeg'].includes(mime))) conv = await toM4a(file.path);
  else if (kind === 'video') { const v = await toMp4Under(file.path, mime, 25 * MB); if (!v) throw new Error('Video is too large for Instagram (25 MB)'); if (!v.same) conv = v; }
  else if (kind === 'image' && !['image/jpeg', 'image/png', 'image/gif'].includes(mime)) conv = await toJpeg(file.path);
  if (conv) await inbox.replaceMessageMedia(message.id, conv.path, conv.mime);
  const t = kind === 'voice' ? 'audio' : kind === 'document' ? 'file' : kind;
  return { type: ['image', 'video', 'audio', 'file'].includes(t) ? t : 'file' };
}

async function send({ cfg, conv, message, file, replyTo }) {
  if (file && !/^https:\/\//.test(config.publicUrl)) throw new Error('Instagram fetches media by URL: set PUBLIC_URL to a public https address');
  let first = null;
  if (file) {
    const { type } = await prepare(message, file);
    const r = await postMessage(cfg, conv, { attachment: { type, payload: { url: publicUrl('m', message.id, 3600) } } }, replyTo);
    rememberMid(r.message_id); first = r.message_id;
  }
  if (message.text) {
    const r = await postMessage(cfg, conv, { text: message.text }, file ? null : replyTo);
    rememberMid(r.message_id); first = first || r.message_id;
  }
  return { externalId: first, status: 'sent' };
}

async function react({ cfg, conv, target, emoji }) {
  await call(cfg, `${selfId(cfg)}/messages`, {
    method: 'POST',
    body: { recipient: { id: conv.external_id }, sender_action: emoji ? 'react' : 'unreact', payload: { message_id: target.external_id, ...(emoji ? { reaction: 'love' } : {}) } },
  });
}

async function markRead({ cfg, conv }) {
  await call(cfg, `${selfId(cfg)}/messages`, { method: 'POST', body: { recipient: { id: conv.external_id }, sender_action: 'mark_seen' } });
}

// ------------------------------------------------------------------ admin

async function test({ channel, cfg }) {
  const me = isIgToken(cfg)
    ? await call(cfg, 'me', { params: { fields: 'user_id,username,name' } })
    : await call(cfg, cfg.ig_user_id, { params: { fields: 'id,username,name' } });
  const accountId = String(me.user_id || me.id);
  const { setChannelState } = await registry();
  await setChannelState(channel.id, { status: 'connected', status_detail: me.name || null, account_id: accountId, account_label: me.username ? `@${me.username}` : accountId });
  return me;
}

// Instagram-Login tokens live 60 days and must be refreshed.
async function refreshToken({ channel, cfg }) {
  if (!isIgToken(cfg)) return { skipped: true };
  const r = await fetchJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(cfg.access_token)}`);
  await pool.query(`UPDATE channels SET config = config || jsonb_build_object('access_token', $2::text, 'token_refreshed_at', $3::text) WHERE id = $1`,
    [channel.id, encrypt(r.access_token), new Date().toISOString()]);
  return { expires_in: r.expires_in };
}

const timers = new Map();
async function start(ctx) {
  if (!ctx.cfg.access_token) return;
  await test(ctx).catch(async (err) => (await registry()).setChannelState(ctx.channel.id, { status: 'error', status_detail: err.message }));
  clearInterval(timers.get(ctx.channel.id));
  timers.set(ctx.channel.id, setInterval(async () => {
    const { loadChannel, channelConfig } = await registry();
    const ch = await loadChannel(ctx.channel.id);
    if (ch?.is_active) refreshToken({ channel: ch, cfg: channelConfig(ch) }).catch((err) => log.warn({ err: err.message }, 'ig token refresh failed'));
  }, 24 * 3600e3).unref());
}
async function stop({ channel }) { clearInterval(timers.get(channel.id)); timers.delete(channel.id); }

// ------------------------------------------------------------------ webhook

async function channelsOfType() {
  const { channelConfig } = await registry();
  return (await pool.query(`SELECT * FROM channels WHERE type = 'instagram'`)).rows.map((ch) => ({ channel: ch, cfg: channelConfig(ch) }));
}

const router = express.Router();
router.get('/', async (req, res) => {
  const token = req.query['hub.verify_token'];
  if (req.query['hub.mode'] === 'subscribe' && token) {
    const all = await channelsOfType();
    if (all.some(({ cfg }) => cfg.verify_token && safeEqual(cfg.verify_token, token))) return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

router.post('/', async (req, res) => {
  const all = await channelsOfType();
  const ids = new Set((req.body?.entry || []).map((e) => String(e.id)));
  const targets = all.filter(({ channel, cfg }) => ids.has(String(channel.account_id)) || ids.has(String(cfg.ig_user_id)));
  const sig = req.headers['x-hub-signature-256'];
  const ok = (secret) => !secret || (sig?.startsWith('sha256=') && req.rawBody && safeEqual(crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex'), sig.slice(7)));
  if (targets.length && !targets.some(({ cfg }) => ok(cfg.app_secret))) { log.warn('instagram webhook: bad signature'); return res.sendStatus(401); }
  res.sendStatus(200);
  for (const entry of req.body?.entry || []) {
    const target = targets.find(({ channel, cfg }) => String(channel.account_id) === String(entry.id) || String(cfg.ig_user_id) === String(entry.id));
    if (!target || !target.channel.is_active) { if (!target) log.warn({ id: entry.id }, 'instagram webhook for unknown account'); continue; }
    const events = [...(entry.messaging || []), ...(entry.changes || []).filter((c) => c.field === 'messages').map((c) => c.value)];
    for (const ev of events) {
      try { await handleEvent(target, String(entry.id), ev); } catch (err) { log.error({ err: err.message, stack: err.stack }, 'instagram event failed'); }
    }
  }
});

function attachmentToMessage(a) {
  const p = a.payload || {};
  switch (a.type) {
    case 'image': return p.sticker_id ? { type: 'sticker', media: { url: p.url } } : { type: 'image', media: { url: p.url } };
    case 'animated_image': return { type: 'image', media: { url: p.url } };
    case 'video': return { type: 'video', media: { url: p.url } };
    case 'audio': return { type: 'voice', media: { url: p.url } };
    case 'file': return { type: 'document', media: { url: p.url } };
    case 'story_mention': return { type: 'image', text: 'Mentioned you in their story', media: { url: p.url }, payload: { story_mention: true } };
    case 'ig_reel': case 'reel': return { type: 'text', text: `🎬 ${p.title || 'Reel'}${p.url ? `\n${p.url}` : ''}`, payload: { reel: p } };
    case 'share': return { type: 'text', text: `🔗 ${p.url || 'Shared post'}`, payload: { share: p } };
    case 'fallback': return { type: 'text', text: p.url || p.title || 'Link', payload: { fallback: p } };
    default: return { type: 'unsupported', text: `Unsupported attachment (${a.type})` };
  }
}

async function handleEvent({ channel, cfg }, accountId, ev) {
  const inbox = await core();
  const fromUs = String(ev.sender?.id) === accountId;
  const other = String(fromUs ? ev.recipient?.id : ev.sender?.id);
  if (!other || other === 'undefined') return;

  if (ev.reaction) {
    if (fromUs) return;
    await inbox.setReaction(channel.id, ev.reaction.mid, 'in', ev.reaction.action === 'unreact' ? null : (ev.reaction.emoji || '❤️'));
    return;
  }
  if (ev.read) {
    if (fromUs) return;
    const conv = (await pool.query('SELECT id FROM conversations WHERE channel_id = $1 AND external_id = $2', [channel.id, other])).rows[0];
    if (conv) await inbox.markOutboundReadUpTo(conv.id, ev.timestamp ? new Date(Number(ev.timestamp)) : new Date());
    return;
  }
  const msg = ev.message || (ev.postback ? { mid: ev.postback.mid, text: ev.postback.title, postback: ev.postback } : null);
  if (!msg) return;
  if (msg.is_deleted) { await inbox.markDeleted(channel.id, msg.mid); return; }
  if (fromUs) {
    if (sentMids.has(msg.mid)) return;
    await new Promise((r) => setTimeout(r, 3000)); // let our own send record its mid first
    if (sentMids.has(msg.mid)) return;
  }

  const prof = await profile(cfg, other);
  const contact = {
    name: prof?.name || null,
    username: prof?.username ? `@${prof.username}` : null,
    avatar: prof?.profile_pic ? () => downloadBuffer(prof.profile_pic) : null,
  };
  const base = {
    direction: fromUs ? 'out' : 'in', senderLabel: fromUs ? 'Instagram app' : null,
    sentAt: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(),
    replyToExternal: msg.reply_to?.mid || null,
  };
  const payload = {};
  if (msg.reply_to?.story) payload.story_reply = msg.reply_to.story;
  if (msg.quick_reply) payload.quick_reply = msg.quick_reply;
  if (msg.postback) payload.postback = msg.postback;
  if (msg.referral || ev.referral) payload.referral = msg.referral || ev.referral;

  const parts = [];
  for (const a of msg.attachments || []) parts.push(attachmentToMessage(a));
  if (msg.is_unsupported) parts.push({ type: 'unsupported', text: 'Message type not supported by the Instagram API' });
  if (msg.text) {
    if (parts.length === 1 && !parts[0].text && parts[0].media) parts[0].text = msg.text;
    else parts.unshift({ type: 'text', text: msg.text });
  }
  if (!parts.length) return;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    await inbox.ingestInbound(channel, {
      chatId: other, contact,
      message: {
        ...base, externalId: i === 0 ? msg.mid : `${msg.mid}:${i}`,
        type: p.type, text: p.text || null,
        payload: Object.keys({ ...payload, ...(p.payload || {}) }).length ? { ...payload, ...(p.payload || {}) } : null,
        media: p.media?.url ? { fetch: () => downloadBuffer(p.media.url) } : null,
        raw: ev,
      },
    });
  }
}

export default {
  type: 'instagram',
  title: 'Instagram Direct',
  capabilities: { windowHours: 24, templates: false, reactions: ['❤️'], reply: true, voice: true, readReceipts: true, deliveryReceipts: false, seenReceipts: true },
  fields: [
    { key: 'access_token', label: 'Access token (IGAA... or Page token EAA...)', secret: true, required: true },
    { key: 'ig_user_id', label: 'Instagram account ID', help: 'Needed for Page (EAA...) tokens; filled automatically for Instagram Login tokens' },
    { key: 'app_secret', label: 'App secret', secret: true, help: 'Verifies webhook signatures' },
    { key: 'verify_token', label: 'Webhook verify token', default: () => randomToken(16) },
    { key: 'human_agent_tag', label: 'Use HUMAN_AGENT tag (reply up to 7 days)', type: 'boolean', help: 'Requires the Human Agent permission approved for your app' },
    { key: 'api_version', label: 'Graph API version', default: () => 'v21.0' },
  ],
  webhookPath: () => '/webhooks/instagram',
  router,
  start, stop, send, react, markRead, test,
  actions: { refresh_token: refreshToken },
};
