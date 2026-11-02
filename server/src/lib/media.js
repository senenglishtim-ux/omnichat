// Media files: local storage, signed links, and ffmpeg conversions each
// messenger needs (voice notes, video size limits, image formats).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { hmac } from './crypto.js';

const run = promisify(execFile);

const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'audio/amr': '.amr', 'audio/webm': '.weba', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'application/pdf': '.pdf', 'application/zip': '.zip', 'text/plain': '.txt',
  'application/x-tgsticker': '.tgs',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
Object.assign(MIME_BY_EXT, { '.jpeg': 'image/jpeg', '.oga': 'audio/ogg', '.mkv': 'video/x-matroska', '.csv': 'text/csv' });

export const baseMime = (m) => (m || '').split(';')[0].trim().toLowerCase();
export const extFor = (mime, name) => EXT[baseMime(mime)] || (name && path.extname(name).toLowerCase().slice(0, 10)) || '';
export const mimeFromName = (name) => MIME_BY_EXT[path.extname(name || '').toLowerCase()] || 'application/octet-stream';

export function kindFromMime(mime) {
  const m = baseMime(mime);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

// Stored as <mediaDir>/<channelId>/<yyyy-mm>/<random><ext>; DB keeps the
// path relative to mediaDir.
export function newMediaPath(channelId, ext) {
  const month = new Date().toISOString().slice(0, 7);
  const rel = path.join(String(channelId), month, `${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}${ext || ''}`);
  fs.mkdirSync(path.dirname(path.join(config.mediaDir, rel)), { recursive: true });
  return rel;
}
export const absMedia = (rel) => path.join(config.mediaDir, rel);

export function saveBuffer(channelId, buffer, mime, name) {
  const rel = newMediaPath(channelId, extFor(mime, name));
  fs.writeFileSync(absMedia(rel), buffer);
  return { path: rel, size: buffer.length };
}

export function moveIntoStorage(channelId, tmpPath, mime, name) {
  const rel = newMediaPath(channelId, extFor(mime, name));
  try { fs.renameSync(tmpPath, absMedia(rel)); } catch { fs.copyFileSync(tmpPath, absMedia(rel)); fs.unlinkSync(tmpPath); }
  return { path: rel, size: fs.statSync(absMedia(rel)).size };
}

// Signed, expiring links: <img>/<video> tags can load media without an auth
// header (and with Range support), and Instagram/Telegram can fetch files we
// send by URL. kind = 'm' (message media) | 'a' (contact avatar).
export function signedPath(kind, id, ttlSec = 6 * 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  // Round expiry to the hour so URLs stay stable between refreshes (cache hits).
  const e = Math.ceil(exp / 3600) * 3600;
  return `${config.basePath}/files/${kind}/${id}?e=${e}&s=${hmac(`${kind}:${id}:${e}`)}`;
}
export const publicUrl = (kind, id, ttlSec) => `${config.publicUrl}${signedPath(kind, id, ttlSec).slice(config.basePath.length)}`;
export function verifySigned(kind, id, e, s) {
  if (!e || !s || Number(e) < Date.now() / 1000) return false;
  return hmac(`${kind}:${id}:${e}`) === s;
}

// ---------- ffmpeg ----------
async function ffmpeg(args, timeout = 10 * 60 * 1000) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
}

export async function probeDuration(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const d = parseFloat(stdout);
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}

const tmpSibling = (file, ext) => `${file}.${crypto.randomBytes(3).toString('hex')}${ext}`;

// Voice note: mono Opus in OGG - what WhatsApp and Telegram render as a voice bubble.
export async function toOggOpus(file) {
  const out = tmpSibling(file, '.ogg');
  await ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', out]);
  return { path: out, mime: 'audio/ogg; codecs=opus' };
}

export async function toM4a(file) {
  const out = tmpSibling(file, '.m4a');
  await ffmpeg(['-i', file, '-vn', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
  return { path: out, mime: 'audio/mp4' };
}

export async function toMp3(file) {
  const out = tmpSibling(file, '.mp3');
  await ffmpeg(['-i', file, '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', out]);
  return { path: out, mime: 'audio/mpeg' };
}

export async function toJpeg(file) {
  const out = tmpSibling(file, '.jpg');
  await ffmpeg(['-i', file, '-frames:v', '1', '-q:v', '3', out]);
  return { path: out, mime: 'image/jpeg' };
}

// H.264/AAC MP4 under maxBytes - re-encoded only when needed (wrong codec /
// container, or too big). Returns null if it still doesn't fit.
export async function toMp4Under(file, mime, maxBytes) {
  const size = fs.statSync(file).size;
  if (baseMime(mime) === 'video/mp4' && size <= maxBytes) return { path: file, mime: 'video/mp4', same: true };
  const dur = Math.max(1, (await probeDuration(file)) || 60);
  const budgetKbit = Math.floor((maxBytes * 0.92 * 8) / 1024 / dur);
  const vk = Math.max(150, budgetKbit - 96);
  const out = tmpSibling(file, '.mp4');
  await ffmpeg(['-i', file, '-vf', vk < 600 ? "scale='min(854,iw)':-2" : "scale='min(1280,iw)':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', `${vk}k`, '-maxrate', `${vk}k`, '-bufsize', `${vk * 2}k`,
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out]);
  if (fs.statSync(out).size > maxBytes) { fs.unlink(out, () => {}); return null; }
  return { path: out, mime: 'video/mp4' };
}

export function cleanup(...files) {
  for (const f of files) if (f) fs.unlink(f, () => {});
}
