// Outgoing webhooks: lets the host project react to new messages, status
// changes, assignments... Body: { event, data, at }. Signature header:
// X-Omnichat-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>.
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { hub } from './events.js';
import { log } from './log.js';

let cache = { at: 0, rows: [] };
export const invalidateWebhooks = () => { cache.at = 0; };

async function active() {
  if (Date.now() - cache.at > 30000) cache = { at: Date.now(), rows: (await pool.query('SELECT * FROM webhooks WHERE is_active')).rows };
  return cache.rows;
}

export async function deliverWebhook(hook, body) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', hook.secret).update(raw).digest('hex');
  let status = null; let error = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(hook.url, {
        method: 'POST', body: raw, signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-Omnichat-Event': body.event, 'X-Omnichat-Signature': `sha256=${sig}` },
      });
      status = r.status; error = r.ok ? null : `HTTP ${r.status}`;
      if (r.ok || r.status < 500) break;
    } catch (err) { error = err.message; }
    await new Promise((res) => setTimeout(res, 1000 * 3 ** attempt));
  }
  await pool.query('UPDATE webhooks SET last_status = $2, last_error = $3, last_at = now() WHERE id = $1', [hook.id, status, error]).catch(() => {});
  return { status, error };
}

export function startWebhookFanout() {
  hub.on('event', async (ev) => {
    try {
      for (const hook of await active()) {
        if (!hook.events.includes('*') && !hook.events.includes(ev.type)) continue;
        deliverWebhook(hook, { event: ev.type, data: ev.data, at: ev.at }).catch((err) => log.warn({ err: err.message }, 'webhook delivery failed'));
      }
    } catch (err) { log.error({ err: err.message }, 'webhook fanout failed'); }
  });
}
