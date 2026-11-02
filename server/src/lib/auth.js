import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { sha256 } from './crypto.js';

export function signToken(user, opts = {}) {
  return jwt.sign({ sub: user.id, role: user.role, name: user.name, ...(opts.scope ? { scope: opts.scope } : {}) },
    config.jwtSecret, { expiresIn: opts.expiresIn || '30d' });
}

const userCache = new Map(); // id -> { user, at }
async function loadUser(id) {
  const c = userCache.get(id);
  if (c && Date.now() - c.at < 30000) return c.user;
  const u = (await pool.query('SELECT id, email, name, role, is_active FROM users WHERE id = $1', [id])).rows[0];
  userCache.set(id, { user: u, at: Date.now() });
  return u;
}
export const forgetUser = (id) => userCache.delete(id);

// Who is calling: a logged-in agent (JWT, header or ?token= for EventSource /
// iframe embeds), or a host-project server using an API key (X-Api-Key or
// "Bearer ock_..."). API keys act with admin rights, labelled "API".
export async function resolveAuth(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const apiKey = req.headers['x-api-key'] || (bearer?.startsWith('ock_') ? bearer : null);
  if (apiKey) {
    const row = (await pool.query('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 RETURNING id, name', [sha256(apiKey)])).rows[0];
    if (!row) return null;
    return { id: null, role: 'admin', name: `API: ${row.name}`, apiKeyId: row.id, isApi: true };
  }
  const token = bearer || req.query.token;
  if (!token) return null;
  try {
    const p = jwt.verify(token, config.jwtSecret);
    const u = await loadUser(p.sub);
    if (!u || !u.is_active) return null;
    return { ...u, scope: p.scope || null };
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  resolveAuth(req).then((u) => {
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    req.user = u;
    next();
  }).catch(next);
}

// Embed tokens (scoped to one contact) never get admin powers, whatever
// the role of the agent they were issued for.
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin' || req.user?.scope) return res.status(403).json({ error: 'forbidden' });
  next();
}

// Embed tokens are limited to one contact's conversations (scope.contact_id).
export function scopeAllows(user, contactId) {
  if (!user?.scope?.contact_id) return true;
  return Number(user.scope.contact_id) === Number(contactId);
}

export function requireUnscoped(req, res, next) {
  if (req.user?.scope) return res.status(403).json({ error: 'forbidden' });
  next();
}
