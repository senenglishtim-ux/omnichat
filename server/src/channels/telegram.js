// Telegram Bot API (private chats with your bot). Works with a webhook when
// PUBLIC_URL is https, otherwise falls back to long polling - handy locally.
// Telegram gives bots no delivered/read receipts, so outgoing messages stop at "sent".
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { fetchJson, downloadBuffer } from '../lib/http.js';
import { log } from '../lib/log.js';
import { safeEqual, randomToken } from '../lib/crypto.js';
import { baseMime, toOggOpus, toMp4Under, cleanup } from '../lib/media.js';

const MB = 1024 * 1024;
const core = () => import('../core/inbox.js');
const registry = () => import('./index.js');

// Reactions a bot is allowed to set.
const TG_REACTIONS = ['👍', '❤', '🔥', '🤣', '😱', '😢', '🙏', '👌', '🎉', '🤔', '👏', '😍', '💯', '👀', '🤝', '😎'];

const api = (cfg, method) => `https://api.telegram.org/bot${cfg.bot_token}/${method}`;
async function tg(cfg, method, body, opts = {}) {
  const isForm = body instanceof FormData;
  const r = await fetchJson(api(cfg, method), {
    method: 'POST',
    ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }),
    timeout: opts.timeout || 120000, signal: opts.signal,
  });
  return r.result;
}

const extId = (chatId, messageId) => `${chatId}:${messageId}`;
const msgIdOf = (ext) => Number(String(ext).split(':').pop());

// ------------------------------------------------------------------ runtime

const pollers = new Map();

async function start({ channel, cfg }) {
  if (!cfg.bot_token) return;
  const { setChannelState } = await registry();
  const me = await tg(cfg, 'getMe');
  await setChannelState(channel.id, { account_id: String(me.id), account_label: `@${me.username}`, status_detail: me.first_name });
  const useWebhook = cfg.mode === 'webhook' || (cfg.mode !== 'polling' && /^https:\/\//.test(config.publicUrl));
  await stop({ channel });
  const allowed = ['message', 'edited_message', 'message_reaction'];
  if (useWebhook) {
    await tg(cfg, 'setWebhook', { url: `${config.publicUrl}/webhooks/telegram/${channel.id}`, secret_token: cfg.webhook_secret, allowed_updates: allowed, drop_pending_updates: false });
    await setChannelState(channel.id, { status: 'connected' });
  } else {
    await tg(cfg, 'deleteWebhook', { drop_pending_updates: false });
    const ctl = new AbortController();
    pollers.set(channel.id, ctl);
    await setChannelState(channel.id, { status: 'connected' });
    (async () => {
      let offset = 0;
      while (!ctl.signal.aborted) {
        try {
          const updates = await tg(cfg, 'getUpdates', { offset, timeout: 50, allowed_updates: allowed }, { timeout: 70000, signal: ctl.signal });
          for (const u of updates) {
            offset = u.update_id + 1;
            await handleUpdate(channel, cfg, u).catch((err) => log.error({ err: err.message }, 'telegram update failed'));
          }
        } catch (err) {
          if (ctl.signal.aborted) break;
          log.warn({ err: err.message }, 'telegram polling error');
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }
}

async function stop({ channel }) {
  const ctl = pollers.get(channel.id);
  if (ctl) { ctl.abort(); pollers.delete(channel.id); }
}

async function test({ channel, cfg }) {
  const me = await tg(cfg, 'getMe');
  const hook = await tg(cfg, 'getWebhookInfo');
  return { bot: `@${me.username}`, webhook: hook.url || '(long polling)', pending: hook.pending_update_count, last_error: hook.last_error_message || null };
}

// ------------------------------------------------------------------ inbound

function fileFetcher(cfg, fileId) {
  return async () => {
    const f = await tg(cfg, 'getFile', { file_id: fileId });
    if (!f.file_path) throw new Error('File is larger than 20 MB (Bot API download limit)');
    return downloadBuffer(`https://api.telegram.org/file/bot${cfg.bot_token}/${f.file_path}`);
  };
}

function describe(cfg, m) {
  const media = (obj, name) => ({ mime: obj.mime_type || null, name: name || obj.file_name || null, size: obj.file_size || null, fetch: fileFetcher(cfg, obj.file_id) });
  const caption = m.caption || null;
  if (m.text != null) return { type: 'text', text: m.text };
  if (m.photo) return { type: 'image', text: caption, media: { ...media(m.photo[m.photo.length - 1]), mime: 'image/jpeg' } };
  if (m.animation) return { type: 'video', text: caption, media: media(m.animation), payload: { gif: true } };
  if (m.video) return { type: 'video', text: caption, media: media(m.video) };
  if (m.video_note) return { type: 'video', media: { ...media(m.video_note), mime: 'video/mp4' }, payload: { round: true } };
  if (m.voice) return { type: 'voice', media: media(m.voice) };
  if (m.audio) return { type: 'audio', text: caption, media: media(m.audio, m.audio.file_name || [m.audio.performer, m.audio.title].filter(Boolean).join(' - ')) };
  if (m.document) return { type: 'document', text: caption, media: media(m.document) };
  if (m.sticker) {
    const s = m.sticker;
    if (s.is_animated) return { type: 'sticker', text: s.emoji || 'Sticker', payload: { animated: true, emoji: s.emoji } }; // .tgs can't be shown in a browser without lottie
    return { type: 'sticker', media: { ...media(s), mime: s.is_video ? 'video/webm' : 'image/webp' }, payload: { emoji: s.emoji, video: !!s.is_video } };
  }
  if (m.location || m.venue) {
    const l = m.venue?.location || m.location;
    return { type: 'location', text: m.venue ? [m.venue.title, m.venue.address].filter(Boolean).join(', ') : null,
      payload: { location: { latitude: l.latitude, longitude: l.longitude, name: m.venue?.title || null, address: m.venue?.address || null, live: !!l.live_period } } };
  }
  if (m.contact) {
    const name = [m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ');
    return { type: 'contact', text: name, payload: { contacts: [{ name, phones: [m.contact.phone_number] }] } };
  }
  if (m.poll) return { type: 'text', text: `📊 ${m.poll.question}\n${m.poll.options.map((o) => `• ${o.text}`).join('\n')}`, payload: { poll: m.poll } };
  if (m.dice) return { type: 'text', text: `${m.dice.emoji} ${m.dice.value}` };
  return { type: 'unsupported', text: 'Unsupported Telegram message' };
}

async function handleUpdate(channel, cfg, u) {
  const inbox = await core();
  if (u.message_reaction) {
    const r = u.message_reaction;
    if (r.chat?.type !== 'private') return;
    const emoji = (r.new_reaction || []).find((x) => x.type === 'emoji')?.emoji || null;
    await inbox.setReaction(channel.id, extId(r.chat.id, r.message_id), 'in', emoji);
    return;
  }
  if (u.edited_message) {
    const m = u.edited_message;
    if (m.chat?.type === 'private') await inbox.applyEdit(channel.id, extId(m.chat.id, m.message_id), m.text ?? m.caption ?? '');
    return;
  }
  const m = u.message;
  if (!m || m.chat?.type !== 'private') return;
  const d = describe(cfg, m);
  const from = m.from || {};
  const payload = { ...(d.payload || {}) };
  if (m.forward_origin) payload.forwarded = true;
  await inbox.ingestInbound(channel, {
    chatId: String(m.chat.id),
    contact: {
      name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
      username: from.username ? `@${from.username}` : null,
      avatar: async () => {
        const photos = await tg(cfg, 'getUserProfilePhotos', { user_id: from.id, limit: 1 });
        const p = photos.photos?.[0];
        return p ? fileFetcher(cfg, p[p.length - 1].file_id)() : null;
      },
    },
    message: {
      externalId: extId(m.chat.id, m.message_id), direction: 'in',
      type: d.type, text: d.text ?? null, payload: Object.keys(payload).length ? payload : null,
      replyToExternal: m.reply_to_message ? extId(m.chat.id, m.reply_to_message.message_id) : null,
      sentAt: new Date(m.date * 1000), media: d.media || null, raw: m,
    },
  });
}

const router = express.Router();
router.post('/:channelId', async (req, res) => {
  const { loadChannel, channelConfig } = await registry();
  const channel = await loadChannel(Number(req.params.channelId)).catch(() => null);
  if (!channel || channel.type !== 'telegram') return res.sendStatus(404);
  const cfg = channelConfig(channel);
  if (!cfg.webhook_secret || !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', cfg.webhook_secret)) return res.sendStatus(401);
  res.sendStatus(200);
  if (channel.is_active) handleUpdate(channel, cfg, req.body).catch((err) => log.error({ err: err.message }, 'telegram update failed'));
});

// ------------------------------------------------------------------ outbound

function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) f.append(k, typeof v === 'object' && !(v instanceof Blob) ? JSON.stringify(v) : v);
  return f;
}
const blob = (p, mime, name) => new Blob([fs.readFileSync(p)], { type: baseMime(mime) || 'application/octet-stream' });

async function send({ cfg, conv, message, file, replyTo }) {
  const chat_id = conv.external_id;
  const reply_parameters = replyTo?.external_id ? { message_id: msgIdOf(replyTo.external_id), allow_sending_without_reply: true } : undefined;
  let res;
  if (!file) {
    res = await tg(cfg, 'sendMessage', { chat_id, text: message.text, reply_parameters });
  } else {
    const temps = [];
    try {
      const mime = baseMime(file.mime);
      const name = file.name || path.basename(file.path);
      const longCaption = (message.text || '').length > 1024;
      const caption = longCaption ? undefined : message.text || undefined;
      let method = 'sendDocument'; let field = 'document'; let p = file.path; let m = mime;
      if (message.type === 'voice') { const o = await toOggOpus(file.path); temps.push(o.path); p = o.path; m = 'audio/ogg'; method = 'sendVoice'; field = 'voice'; }
      else if (message.type === 'image' && mime === 'image/gif') { method = 'sendAnimation'; field = 'animation'; }
      else if (message.type === 'image' && ['image/jpeg', 'image/png', 'image/webp'].includes(mime) && file.size <= 10 * MB) { method = 'sendPhoto'; field = 'photo'; }
      else if (message.type === 'video') {
        const v = await toMp4Under(file.path, mime, 49 * MB).catch(() => null);
        if (v) { if (!v.same) temps.push(v.path); p = v.path; m = 'video/mp4'; method = 'sendVideo'; field = 'video'; }
      } else if (message.type === 'audio' && ['audio/mpeg', 'audio/mp4', 'audio/x-m4a'].includes(mime)) { method = 'sendAudio'; field = 'audio'; }
      if (fs.statSync(p).size > 50 * MB) throw new Error('Telegram bots can send files up to 50 MB');
      res = await tg(cfg, method, form({ chat_id, caption, reply_parameters, [field]: new File([blob(p, m)], method === 'sendVoice' ? 'voice.ogg' : name, { type: baseMime(m) }) }), { timeout: 300000 });
      if (longCaption) await tg(cfg, 'sendMessage', { chat_id, text: message.text });
    } finally { cleanup(...temps); }
  }
  return { externalId: extId(chat_id, res.message_id), status: 'sent' };
}

async function react({ cfg, conv, target, emoji }) {
  await tg(cfg, 'setMessageReaction', { chat_id: conv.external_id, message_id: msgIdOf(target.external_id), reaction: emoji ? [{ type: 'emoji', emoji }] : [] });
}

export default {
  type: 'telegram',
  title: 'Telegram Bot',
  capabilities: { windowHours: null, templates: false, reactions: TG_REACTIONS, reply: true, voice: true, readReceipts: false, deliveryReceipts: false },
  fields: [
    { key: 'bot_token', label: 'Bot token from @BotFather', secret: true, required: true },
    { key: 'mode', label: 'Updates', type: 'select', options: ['auto', 'webhook', 'polling'], default: () => 'auto', help: 'auto = webhook when PUBLIC_URL is https, otherwise long polling' },
    { key: 'webhook_secret', label: 'Webhook secret', secret: true, default: () => randomToken(24), hidden: true },
  ],
  webhookPath: (ch) => `/webhooks/telegram/${ch.id}`,
  router,
  start, stop, send, react, test,
};
