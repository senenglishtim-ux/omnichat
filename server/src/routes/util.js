import { InboxError } from '../core/inbox.js';
import { ProviderError } from '../lib/http.js';

// Wraps async handlers; maps known errors to JSON responses.
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  if (err instanceof InboxError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err instanceof ProviderError) return res.status(502).json({ error: 'provider_error', message: err.message });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.code || 'bad_request', message: err.message });
  next(err);
});

export const bad = (message, code = 'bad_request') => Object.assign(new Error(message), { status: 400, code });
export const notFound = (message = 'Not found') => Object.assign(new Error(message), { status: 404, code: 'not_found' });
