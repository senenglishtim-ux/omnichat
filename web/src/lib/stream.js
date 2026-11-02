// One EventSource per tab, shared by every component (live messages,
// statuses, conversation changes, channel QR codes). Reconnects on its own;
// subscribers get a synthetic 'reconnected' event to catch up.
import { BASE, getToken } from '../api';

const listeners = new Set();
let es = null;
let everConnected = false;
const TYPES = ['message.created', 'message.updated', 'conversation.updated', 'channel.updated'];

function connect() {
  const token = getToken();
  if (!token || es) return;
  es = new EventSource(`${BASE}/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener('ready', () => {
    if (everConnected) listeners.forEach((fn) => fn('reconnected', {}));
    everConnected = true;
  });
  for (const t of TYPES) {
    es.addEventListener(t, (e) => {
      let data; try { data = JSON.parse(e.data); } catch { return; }
      listeners.forEach((fn) => fn(t, data));
    });
  }
  es.onerror = () => {
    if (es?.readyState === EventSource.CLOSED) { es = null; setTimeout(connect, 3000); }
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  connect();
  return () => listeners.delete(fn);
}

export function resetStream() { es?.close(); es = null; everConnected = false; }
