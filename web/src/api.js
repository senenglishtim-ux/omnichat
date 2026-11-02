// REST client. The token lives in localStorage for the full app; an embed
// (iframe) passes ?token= and keeps it only in memory.
export const BASE = (typeof window !== 'undefined' && window.__OMNICHAT_BASE__) || '';

let memoryToken = null;
export function setEmbedToken(t) { memoryToken = t; }
export function getToken() {
  if (memoryToken) return memoryToken;
  try { return localStorage.getItem('omnichat_token'); } catch { return null; }
}
export function getUser() {
  try { return JSON.parse(localStorage.getItem('omnichat_user') || 'null'); } catch { return null; }
}
export function setSession(token, user) {
  try { localStorage.setItem('omnichat_token', token); localStorage.setItem('omnichat_user', JSON.stringify(user)); } catch { /* private mode */ }
}
export function clearSession() {
  try { localStorage.removeItem('omnichat_token'); localStorage.removeItem('omnichat_user'); } catch { /* ignore */ }
}
export const isEmbed = () => !!memoryToken;

async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (res.status === 401 && !isEmbed() && !path.startsWith('/auth/login')) {
    clearSession();
    window.location.href = `${BASE}/login`;
  }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p) => request('DELETE', p),
};

export const fileUrl = (u) => (u && u.startsWith('/') && BASE && !u.startsWith(BASE) ? BASE + u : u);

// fetch() can't report upload progress - XHR can. Returns { promise, abort }.
export function uploadWithProgress(path, formData, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `${BASE}/api${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data?.message || data?.error || `HTTP ${xhr.status}`), { data, status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { aborted: true }));
    xhr.send(formData);
  });
  return { promise, abort: () => xhr.abort() };
}
