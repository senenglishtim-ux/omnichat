// Rows -> JSON the UI/API consumes (signed media links, sender names, the
// quoted message for replies, conversation previews).
import { pool } from '../db/pool.js';
import { signedPath } from '../lib/media.js';
import { getAdapterSafe, windowInfo } from '../channels/index.js';

export const MESSAGE_SELECT = `
  SELECT m.*, u.name AS sender_name, c.channel_id, c.contact_id,
         r.id AS r_id, r.type AS r_type, r.text AS r_text, r.direction AS r_direction, r.media_name AS r_media_name
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN users u ON u.id = m.sender_user_id
  LEFT JOIN messages r ON r.id = m.reply_to_id`;

export function serializeMessage(row) {
  if (!row) return null;
  const { r_id, r_type, r_text, r_direction, r_media_name, raw, client_ref, ...m } = row;
  return {
    ...m,
    client_ref,
    media_url: m.media_path && m.media_status === 'ready' ? signedPath('m', m.id) : null,
    reply_to: r_id ? { id: r_id, type: r_type, text: r_text, direction: r_direction, media_name: r_media_name } : null,
  };
}

export async function loadMessage(id, db = pool) {
  const r = await db.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
  return serializeMessage(r.rows[0]);
}

export const CONVERSATION_SELECT = `
  SELECT c.*, ct.name AS contact_name, ct.phone AS contact_phone, ct.username AS contact_username,
         ct.avatar_path AS contact_avatar, ct.external_ref AS contact_external_ref,
         ch.type AS channel_type, ch.name AS channel_name, ch.account_label AS channel_label, ch.config AS channel_config,
         au.name AS assigned_user_name,
         lm.text AS last_text, lm.type AS last_type, lm.direction AS last_direction, lm.status AS last_status,
         lm.media_name AS last_media_name, lm.deleted_at AS last_deleted_at,
         (SELECT max(created_at) FROM messages x WHERE x.conversation_id = c.id AND x.direction = 'in') AS last_in_at,
         (SELECT max(created_at) FROM messages x WHERE x.conversation_id = c.id AND x.direction = 'out') AS last_out_at
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN channels ch ON ch.id = c.channel_id
  LEFT JOIN users au ON au.id = c.assigned_user_id
  LEFT JOIN messages lm ON lm.id = c.last_message_id`;

export function serializeConversation(row) {
  if (!row) return null;
  const { channel_config, contact_avatar, ...c } = row;
  const adapter = getAdapterSafe(c.channel_type);
  return {
    ...c,
    contact_avatar_url: contact_avatar ? signedPath('a', c.contact_id, 24 * 3600) : null,
    awaiting_reply: !!c.last_in_at && (!c.last_out_at || new Date(c.last_in_at) > new Date(c.last_out_at)),
    capabilities: adapter?.capabilities || {},
    window: windowInfo(c.channel_type, channel_config, c.last_inbound_at),
  };
}

export async function loadConversation(id, db = pool) {
  const r = await db.query(`${CONVERSATION_SELECT} WHERE c.id = $1`, [id]);
  return serializeConversation(r.rows[0]);
}
