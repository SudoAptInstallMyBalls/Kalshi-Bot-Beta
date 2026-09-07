const crypto = require('crypto');

function createAuth(port) {
const CONTROL_TOKEN = process.env.BOT_CONTROL_TOKEN || process.env.DASHBOARD_API_TOKEN || '';
const configuredOrigins = (process.env.DASHBOARD_ORIGINS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const defaultOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
const allowedOrigins = new Set(configuredOrigins.length ? configuredOrigins : defaultOrigins);

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function extractToken(req) {
  const auth = req.get('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return (req.get('x-kalshibot-token') || '').trim();
}

function requireControlAuth(req, res, next) {
  if (!CONTROL_TOKEN) {
    return res.status(503).json({ error: 'Control API disabled: set BOT_CONTROL_TOKEN' });
  }
  if (!safeEqual(extractToken(req), CONTROL_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function isAllowedOrigin(origin) {
  // Non-browser clients may omit Origin; bearer auth still applies.
  return !origin || allowedOrigins.has(origin);
}


return { CONTROL_TOKEN, safeEqual, requireControlAuth, isAllowedOrigin };
}
module.exports = { createAuth };
