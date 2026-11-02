// WhatsApp Business Platform (Cloud API) - the official Meta API.
// Webhook: GET/POST {PUBLIC_URL}/webhooks/whatsapp (one URL for every
// number of the Meta app; events are routed by metadata.phone_number_id).
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { fetchJson, downloadBuffer } from '../lib/http.js';
import { log } from '../lib/log.js';
import { safeEqual, randomToken } from '../lib/crypto.js';
import { baseMime, toOggOpus, toMp4Under, toJpeg, toMp3, cleanup } from '../lib/media.js';
import { config } from '../config.js';

const MB = 1024 * 1024;
const graph = (cfg) => `https://graph.facebook.com/${cfg.graph_version || 'v21.0'}`;
const auth = (cfg) => ({ Authorization: `Bearer ${cfg.access_token}` });

async function core() { return import('../core/inbox.js'); }
async function registry() { return import('./index.js'); }

// ------------------------------------------------------------------ sending

async function postMessage(cfg, body) {
  return fetchJson(`${graph(cfg)}/${cfg.phone_number_id}/messages`, {
    method: 'POST',
    headers: { ...auth(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
  });
}

async function uploadMedia(cfg, file, mime) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', baseMime(mime));
  form.append('file', new Blob([fs.readFileSync(file)], { type: baseMime(mime) }), path.basename(file));
  const r = await fetchJson(`${graph(cfg)}/${cfg.phone_number_id}/media`, { method: 'POST', headers: auth(cfg), body: form, timeout: 300000 });
  return r.id;
}

const AUDIO_OK = new Set(['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg']);

// Converts whatever the agent attached into something Cloud API accepts;
// falls back to sending it as a plain document.
async function prepare(kind, file) {
  const mime = baseMime(file.mime);
  const temps = [];
  const out = (p, m, k) => ({ path: p, mime: m, kind: k, temps });
  if (kind === 'voice') { const r = await toOggOpus(file.path); temps.push(r.path); return out(r.path, 'audio/ogg', 'audio'); }
  if (kind === 'image') {
    if (mime === 'image/gif') {
      const v = await toMp4Under(file.path, mime, 16 * MB).catch(() => null);
      if (v) { if (!v.same) temps.push(v.path); return out(v.path, 'video/mp4', 'video'); }
    }
    let p = file.path; let m = mime;
    if (!['image/jpeg', 'image/png'].includes(mime)) {
      const r = await toJpeg(file.path).catch(() => null);
      if (!r) return out(file.path, mime, 'document');
      temps.push(r.path); p = r.path; m = r.mime;
    }
    return fs.statSync(p).size <= 5 * MB ? out(p, m, 'image') : out(file.path, mime, 'document');
  }
  if (kind === 'video') {
    const v = await toMp4Under(file.path, mime, 16 * MB).catch((err) => { log.warn({ err: err.message }, 'video transcode failed'); return null; });
    if (v) { if (!v.same) temps.push(v.path); return out(v.path, 'video/mp4', 'video'); }
    return out(file.path, mime, 'document');
  }
  if (kind === 'audio') {
    let p = file.path; let m = mime;
    if (!AUDIO_OK.has(mime)) { const r = await toMp3(file.path).catch(() => null); if (!r) return out(file.path, mime, 'document'); temps.push(r.path); p = r.path; m = r.mime; }
    return fs.statSync(p).size <= 16 * MB ? out(p, m, 'audio') : out(file.path, mime, 'document');
  }
  return out(file.path, mime || 'application/octet-stream', 'document');
}

function maxPlaceholder(text) {
  const nums = [...String(text || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

// params: { '1': 'Anna', '2': '42', h1: 'header var', header_url: 'https://...', btn0: 'url-suffix' }
function templateComponents(tpl, params = {}) {
  const out = [];
  for (const c of tpl.components || []) {
    if (c.type === 'HEADER') {
      if (c.format === 'TEXT' && maxPlaceholder(c.text)) {
        out.push({ type: 'header', parameters: [{ type: 'text', text: String(params.h1 ?? '') }] });
      } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format)) {
        const link = params.header_url || c.example?.header_handle?.[0];
        if (link) { const k = c.format.toLowerCase(); out.push({ type: 'header', parameters: [{ type: k, [k]: { link } }] }); }
      }
    } else if (c.type === 'BODY') {
      const n = maxPlaceholder(c.text);
      if (n) out.push({ type: 'body', parameters: Array.from({ length: n }, (_, i) => ({ type: 'text', text: String(params[i + 1] ?? '') })) });
    } else if (c.type === 'BUTTONS') {
      (c.buttons || []).forEach((b, i) => {
        if (b.type === 'URL' && maxPlaceholder(b.url)) {
          out.push({ type: 'button', sub_type: 'url', index: String(i), parameters: [{ type: 'text', text: String(params[`btn${i}`] ?? '') }] });
        }
      });
    }
  }
  return out;
}

function renderTemplate(tpl, params = {}) {
  const fill = (t, header) => String(t || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => (header ? params.h1 : params[n]) ?? `{{${n}}}`);
  const comps = tpl.components || [];
  const h = comps.find((c) => c.type === 'HEADER');
  const b = comps.find((c) => c.type === 'BODY');
  const f = comps.find((c) => c.type === 'FOOTER');
  const btns = comps.find((c) => c.type === 'BUTTONS');
  return [h?.format === 'TEXT' ? fill(h.text, true) : null, fill(b?.text), f?.text,
    btns?.buttons?.length ? btns.buttons.map((x) => `[${x.text}]`).join(' ') : null].filter(Boolean).join('\n');
}

async function send({ cfg, conv, message, file, replyTo }) {
  const to = conv.external_id;
  const context = replyTo?.external_id ? { context: { message_id: replyTo.external_id } } : {};
  let r;
  if (message.type === 'template') {
    const t = message.payload.template;
    const tpl = (await pool.query('SELECT * FROM templates WHERE channel_id = $1 AND name = $2 AND language = $3', [conv.channel_id, t.name, t.language])).rows[0];
    if (!tpl) throw new Error('Template not found');
    r = await postMessage(cfg, { to, type: 'template', template: { name: t.name, language: { code: t.language }, components: templateComponents(tpl, t.params) } });
  } else if (file) {
    const p = await prepare(message.type, file);
    try {
      const id = await uploadMedia(cfg, p.path, p.mime);
      const obj = { id };
      if (message.text && p.kind !== 'audio') obj.caption = message.text;
      if (p.kind === 'document') obj.filename = file.name || path.basename(file.path);
      r = await postMessage(cfg, { to, type: p.kind, [p.kind]: obj, ...context });
    } finally { cleanup(...p.temps); }
  } else {
    r = await postMessage(cfg, { to, type: 'text', text: { body: message.text, preview_url: /https?:\/\//.test(message.text || '') }, ...context });
  }
  return { externalId: r.messages?.[0]?.id, status: 'sent' };
}

async function react({ cfg, conv, target, emoji }) {
  await postMessage(cfg, { to: conv.external_id, type: 'reaction', reaction: { message_id: target.external_id, emoji } });
}

// Blue ticks for the contact: marking the newest one read marks everything before it.
async function markRead({ cfg, messages }) {
  const last = messages.find((m) => m.external_id);
  if (!last) return;
  await fetchJson(`${graph(cfg)}/${cfg.phone_number_id}/messages`, {
    method: 'POST', headers: { ...auth(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: last.external_id }),
  });
}

// ------------------------------------------------------------------ admin

async function test({ channel, cfg }) {
  const info = await fetchJson(`${graph(cfg)}/${cfg.phone_number_id}?fields=verified_name,display_phone_number,quality_rating`, { headers: auth(cfg) });
  const { setChannelState } = await registry();
  await setChannelState(channel.id, { status: 'connected', status_detail: info.verified_name || null, account_id: cfg.phone_number_id, account_label: info.display_phone_number });
  return info;
}

async function start(ctx) {
  const { setChannelState } = await registry();
  await setChannelState(ctx.channel.id, { account_id: ctx.cfg.phone_number_id });
  if (ctx.cfg.access_token && ctx.cfg.phone_number_id) {
    await test(ctx).catch((err) => setChannelState(ctx.channel.id, { status: 'error', status_detail: err.message }));
  }
}

// Registers our callback for the app and links the WABA to it - what you
// would otherwise click through in the Meta App Dashboard.
async function subscribeWebhooks({ cfg }) {
  if (!cfg.app_id || !cfg.app_secret || !cfg.waba_id) throw new Error('app_id, app_secret and waba_id are required');
  const appToken = await fetchJson(`${graph(cfg)}/oauth/access_token?${new URLSearchParams({ client_id: cfg.app_id, client_secret: cfg.app_secret, grant_type: 'client_credentials' })}`);
  const callback = `${config.publicUrl}/webhooks/whatsapp`;
  await fetchJson(`${graph(cfg)}/${cfg.app_id}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ object: 'whatsapp_business_account', callback_url: callback, verify_token: cfg.verify_token, fields: 'messages,smb_message_echoes', access_token: appToken.access_token }),
  });
  await fetchJson(`${graph(cfg)}/${cfg.waba_id}/subscribed_apps`, { method: 'POST', headers: auth(cfg) });
  return { callback_url: callback };
}

async function syncTemplates({ channel, cfg }) {
  if (!cfg.waba_id) throw new Error('waba_id is required');
  let url = `${graph(cfg)}/${cfg.waba_id}/message_templates?limit=200`;
  const all = [];
  while (url) {
    const page = await fetchJson(url, { headers: auth(cfg) });
    all.push(...(page.data || []));
    url = page.paging?.next || null;
  }
  for (const t of all) {
    await pool.query(
      `INSERT INTO templates (channel_id, external_id, name, language, category, status, components, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (channel_id, name, language) DO UPDATE SET external_id = $2, category = $5, status = $6, components = $7, synced_at = now()`,
      [channel.id, t.id, t.name, t.language, t.category, t.status, JSON.stringify(t.components || [])]);
  }
  await pool.query('DELETE FROM templates WHERE channel_id = $1 AND NOT (name || \':\' || language = ANY($2::text[]))',
    [channel.id, all.map((t) => `${t.name}:${t.language}`)]);
  return all.length;
}

async function createTemplate({ channel, cfg }, { name, language, category, components }) {
  const r = await fetchJson(`${graph(cfg)}/${cfg.waba_id}/message_templates`, {
    method: 'POST', headers: { ...auth(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, language, category, components }),
  });
  await pool.query(
    `INSERT INTO templates (channel_id, external_id, name, language, category, status, components) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (channel_id, name, language) DO UPDATE SET external_id = $2, category = $5, status = $6, components = $7, synced_at = now()`,
    [channel.id, r.id, name, language, r.category || category, r.status || 'PENDING', JSON.stringify(components)]);
  return r;
}

async function deleteTemplate({ channel, cfg }, name) {
  await fetchJson(`${graph(cfg)}/${cfg.waba_id}/message_templates?name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: auth(cfg) });
  await pool.query('DELETE FROM templates WHERE channel_id = $1 AND name = $2', [channel.id, name]);
}

// ------------------------------------------------------------------ webhook

function verifySignature(appSecret, raw, header) {
  if (!appSecret) return true;
  if (!raw || !header?.startsWith('sha256=')) return false;
  return safeEqual(crypto.createHmac('sha256', appSecret).update(raw).digest('hex'), header.slice(7));
}

async function channelsOfType() {
  const { channelConfig } = await registry();
  const rows = (await pool.query(`SELECT * FROM channels WHERE type = 'whatsapp_cloud'`)).rows;
  return rows.map((ch) => ({ channel: ch, cfg: channelConfig(ch) }));
}

function mediaFetcher(cfg, mediaId) {
  return async () => {
    const meta = await fetchJson(`${graph(cfg)}/${mediaId}`, { headers: auth(cfg) });
    const got = await downloadBuffer(meta.url, auth(cfg));
    return { buffer: got.buffer, mime: meta.mime_type || got.mime };
  };
}

// Inbound message -> normalized form for core.ingestInbound.
function normalize(cfg, msg) {
  const out = { externalId: msg.id, sentAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(), raw: msg, replyToExternal: msg.context?.id || null };
  const payload = {};
  if (msg.context?.forwarded || msg.context?.frequently_forwarded) payload.forwarded = true;
  if (msg.referral) payload.referral = msg.referral;
  const t = msg.type;
  if (t === 'text') { out.type = 'text'; out.text = msg.text?.body; }
  else if (['image', 'video', 'audio', 'document', 'sticker'].includes(t)) {
    const m = msg[t] || {};
    out.type = t === 'audio' && m.voice ? 'voice' : t;
    out.text = m.caption || null;
    out.media = { mime: m.mime_type, name: m.filename || null, fetch: mediaFetcher(cfg, m.id) };
    if (t === 'sticker' && m.animated) payload.animated = true;
  } else if (t === 'location') {
    out.type = 'location'; payload.location = msg.location;
    out.text = [msg.location?.name, msg.location?.address].filter(Boolean).join(', ') || null;
  } else if (t === 'contacts') {
    out.type = 'contact';
    payload.contacts = (msg.contacts || []).map((c) => ({ name: c.name?.formatted_name, phones: (c.phones || []).map((p) => p.phone || p.wa_id), emails: (c.emails || []).map((e) => e.email) }));
    out.text = payload.contacts.map((c) => c.name).join(', ');
  } else if (t === 'button') {
    out.type = 'text'; out.text = msg.button?.text; payload.button_reply = msg.button?.payload;
  } else if (t === 'interactive') {
    const i = msg.interactive || {};
    out.type = 'text';
    out.text = i.button_reply?.title || i.list_reply?.title || (i.nfm_reply ? (i.nfm_reply.body || 'Form submitted') : null);
    if (i.list_reply?.description) out.text += `\n${i.list_reply.description}`;
    payload.interactive = i;
  } else if (t === 'order') {
    out.type = 'text'; payload.order = msg.order;
    out.text = `🛒 ${(msg.order?.product_items || []).length} item(s)${msg.order?.text ? `\n${msg.order.text}` : ''}`;
  } else {
    out.type = 'unsupported';
    out.text = msg.errors?.[0]?.title || msg.errors?.[0]?.message || `Unsupported message (${t})`;
  }
  if (Object.keys(payload).length) out.payload = payload;
  return out;
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
  const ids = new Set((req.body?.entry || []).flatMap((e) => (e.changes || []).map((c) => c.value?.metadata?.phone_number_id)));
  const targets = all.filter(({ cfg }) => ids.has(cfg.phone_number_id));
  // Signature is checked against the app secret of the channel(s) addressed.
  const sig = req.headers['x-hub-signature-256'];
  if (targets.length && !targets.some(({ cfg }) => verifySignature(cfg.app_secret, req.rawBody, sig))) {
    log.warn('whatsapp webhook: bad signature');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try { await handlePayload(req.body, all); } catch (err) { log.error({ err: err.message, stack: err.stack }, 'whatsapp webhook failed'); }
});

async function handlePayload(body, all) {
  const inbox = await core();
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const target = all.find(({ cfg }) => cfg.phone_number_id === v.metadata?.phone_number_id);
      if (!target) { log.warn({ pnid: v.metadata?.phone_number_id }, 'whatsapp webhook for unknown number'); continue; }
      const { channel, cfg } = target;
      if (!channel.is_active) continue;

      for (const msg of v.messages || []) {
        if (msg.type === 'reaction') {
          await inbox.setReaction(channel.id, msg.reaction?.message_id, 'in', msg.reaction?.emoji || null);
          continue;
        }
        const profile = (v.contacts || []).find((c) => c.wa_id === msg.from);
        await inbox.ingestInbound(channel, {
          chatId: msg.from,
          contact: { name: profile?.profile?.name || null, phone: msg.from },
          message: { ...normalize(cfg, msg), direction: 'in' },
        });
      }
      // Messages typed in the WhatsApp Business app on the same number (coexistence).
      for (const msg of v.message_echoes || []) {
        await inbox.ingestInbound(channel, {
          chatId: msg.to,
          contact: { phone: msg.to },
          message: { ...normalize(cfg, msg), direction: 'out', senderLabel: 'WhatsApp Business app' },
        });
      }
      for (const st of v.statuses || []) {
        const err = st.errors?.length ? st.errors.map((e) => `${e.code}: ${e.error_data?.details || e.title}`).join('; ') : null;
        await inbox.updateStatus(channel.id, st.id, st.status, err);
      }
    }
  }
}

export default {
  type: 'whatsapp_cloud',
  title: 'WhatsApp Cloud API',
  capabilities: { windowHours: 24, templates: true, reactions: true, reply: true, voice: true, readReceipts: true, deliveryReceipts: true },
  fields: [
    { key: 'access_token', label: 'Access token (System User, permanent)', secret: true, required: true },
    { key: 'phone_number_id', label: 'Phone number ID', required: true },
    { key: 'waba_id', label: 'WhatsApp Business Account ID', required: true },
    { key: 'app_id', label: 'Meta App ID', help: 'Needed for automatic webhook subscription' },
    { key: 'app_secret', label: 'Meta App secret', secret: true, help: 'Verifies webhook signatures (X-Hub-Signature-256)' },
    { key: 'verify_token', label: 'Webhook verify token', default: () => randomToken(16) },
    { key: 'graph_version', label: 'Graph API version', default: () => 'v21.0' },
  ],
  webhookPath: () => '/webhooks/whatsapp',
  router,
  start, send, react, markRead, test, renderTemplate,
  actions: { subscribe_webhooks: subscribeWebhooks, sync_templates: syncTemplates },
  createTemplate, deleteTemplate, syncTemplates,
};
