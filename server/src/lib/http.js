// fetch() wrapper for the messengers' JSON APIs: throws with the provider's
// own error message so it can be shown to the agent as-is.
export class ProviderError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(options.timeout || 60000) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data?.ok === false) {
    const msg = data?.error?.error_user_msg || data?.error?.message || data?.description || data?.error || `HTTP ${res.status}`;
    throw new ProviderError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status, data);
  }
  return data;
}

export async function downloadBuffer(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new ProviderError(`download failed: HTTP ${res.status}`, res.status);
  return { buffer: Buffer.from(await res.arrayBuffer()), mime: (res.headers.get('content-type') || '').split(';')[0] || null };
}
