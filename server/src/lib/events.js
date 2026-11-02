// In-process event hub: every change to a conversation/message is emitted
// here once, then fanned out to open browser tabs (SSE) and to the host
// project's outgoing webhooks.
import { EventEmitter } from 'node:events';

export const hub = new EventEmitter();
hub.setMaxListeners(0);

export function emit(type, data) {
  hub.emit('event', { type, data, at: new Date().toISOString() });
}

// SSE endpoint handler.
export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: {}\n\n`);
  const scopeContact = req.user?.scope?.contact_id ? Number(req.user.scope.contact_id) : null;
  const onEvent = (ev) => {
    if (scopeContact) {
      const cid = ev.data?.contact_id ?? ev.data?.conversation?.contact_id;
      if (cid != null && Number(cid) !== scopeContact) return;
      if (ev.type.startsWith('channel.')) return;
    }
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  };
  hub.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); hub.off('event', onEvent); });
}
