// AES-256-GCM for channel secrets at rest + HMAC signing for media links.
import crypto from 'node:crypto';
import { config } from '../config.js';

const key = crypto.createHash('sha256').update(String(config.encryptionKey)).digest();
const PREFIX = 'enc:v1:';

export function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}

export function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

export function hmac(data) {
  return crypto.createHmac('sha256', key).update(data).digest('base64url').slice(0, 32);
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
