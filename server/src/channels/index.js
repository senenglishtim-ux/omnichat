// Channel registry + runtime: which adapters exist, decrypted config,
// messaging-window rules, and starting/stopping long-lived connections
// (WhatsApp Web sockets, Telegram polling).
import { pool } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';
import { emit } from '../lib/events.js';
import { log } from '../lib/log.js';
import whatsappCloud from './whatsappCloud.js';
import whatsappWeb from './whatsappWeb.js';
import instagram from './instagram.js';
import telegram from './telegram.js';

export const adapters = {
  whatsapp_cloud: whatsappCloud,
  whatsapp_web: whatsappWeb,
  instagram,
  telegram,
};

export function getAdapter(type) {
  const a = adapters[type];
  if (!a) throw new Error(`unknown channel type ${type}`);
  return a;
}
export const getAdapterSafe = (type) => adapters[type] || null;

export function channelConfig(channel) {
  const out = {};
  for (const [k, v] of Object.entries(channel.config || {})) out[k] = decrypt(v);
  return out;
}

// Customer-service window (WhatsApp Cloud / Instagram: 24 h since the
// contact's last message; Instagram's HUMAN_AGENT tag stretches it to 7 days).
export function windowInfo(type, rawConfig, lastInboundAt) {
  const a = adapters[type];
  let hours = a?.capabilities?.windowHours;
  if (!hours) return null;
  if (type === 'instagram' && (rawConfig?.human_agent_tag === true || rawConfig?.human_agent_tag === 'true')) hours = 24 * 7;
  if (!lastInboundAt) return { hours, open: false, expires_at: null };
  const expires = new Date(new Date(lastInboundAt).getTime() + hours * 3600e3);
  return { hours, open: expires > new Date(), expires_at: expires.toISOString() };
}

export async function setChannelState(id, fields) {
  const sets = []; const vals = [id];
  for (const [k, v] of Object.entries(fields)) {
    if (!['status', 'status_detail', 'account_id', 'account_label'].includes(k)) continue;
    vals.push(v); sets.push(`${k} = $${vals.length}`);
  }
  if (!sets.length) return;
  const row = (await pool.query(`UPDATE channels SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id, status, status_detail, account_id, account_label`, vals)).rows[0];
  if (row) emit('channel.updated', { channel_id: id, ...row, ...('qr' in fields ? { qr: fields.qr } : {}), ...('pairing_code' in fields ? { pairing_code: fields.pairing_code } : {}) });
}

export async function loadChannel(id) {
  return (await pool.query('SELECT * FROM channels WHERE id = $1', [id])).rows[0] || null;
}

export async function startChannel(channel) {
  const a = getAdapter(channel.type);
  if (!channel.is_active || !a.start) return;
  try {
    await a.start({ channel, cfg: channelConfig(channel) });
  } catch (err) {
    log.error({ channel: channel.id, err: err.message }, 'channel start failed');
    await setChannelState(channel.id, { status: 'error', status_detail: err.message });
  }
}

export async function stopChannel(channel) {
  const a = getAdapter(channel.type);
  if (a.stop) await a.stop({ channel }).catch((err) => log.warn({ err: err.message }, 'channel stop failed'));
}

export async function startAll() {
  const rows = (await pool.query('SELECT * FROM channels WHERE is_active ORDER BY id')).rows;
  for (const ch of rows) await startChannel(ch);
}
