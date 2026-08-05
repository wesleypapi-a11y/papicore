/*
 * passwordResetRateLimit.js
 *
 * Rate limit da recuperação de senha (POST /api/auth/forgot-password).
 * Mesmo padrão em memória (Map + janela deslizante) já usado no login do
 * desenvolvedor (routes/developerRoutes.js) — suficiente para um único
 * processo Node, sem dependência externa.
 *
 * Dois limites independentes:
 *   - por IP: evita varredura de e-mails a partir de uma única origem;
 *   - por e-mail + tenant: evita spamar de recuperação um usuário
 *     específico mesmo variando o IP.
 * Ambos respondem 429 com mensagem genérica (nunca menciona se o e-mail
 * existe) e deixam o controller registrar PASSWORD_RESET_RATE_LIMITED.
 */

const { normalizeDomain, logActivity } = require('../database/coreDatabase');

const IP_WINDOW_MS = (Number(process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MINUTES) || 15) * 60 * 1000;
const IP_MAX = Number(process.env.PASSWORD_RESET_RATE_LIMIT_MAX) || 5;
const EMAIL_WINDOW_MS = 30 * 60 * 1000;
const EMAIL_MAX = 3;

const GENERIC_RATE_LIMIT_MESSAGE = 'Muitas solicitações. Tente novamente mais tarde.';

const ipAttempts = new Map();
const emailAttempts = new Map();

function pruneAndCount(map, key, windowMs) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  map.set(key, recent);
  return recent.length;
}

function logRateLimited(req, reason) {
  try {
    const tenantId = req.tenantFromDomain ? req.tenantFromDomain.id : null;
    logActivity(null, tenantId, 'PASSWORD_RESET_RATE_LIMITED', JSON.stringify({ reason, ip: req.ip || null }));
  } catch (err) {
    console.error('[password-reset] Falha ao registrar log de rate limit:', err.message);
  }
}

function passwordResetIpRateLimit(req, res, next) {
  const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const count = pruneAndCount(ipAttempts, key, IP_WINDOW_MS);
  if (count > IP_MAX) {
    logRateLimited(req, 'ip');
    return res.status(429).json({ error: GENERIC_RATE_LIMIT_MESSAGE });
  }
  next();
}

function passwordResetEmailRateLimit(req, res, next) {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const domain = normalizeDomain(req.headers.host || req.hostname || '');
  if (!email) return next();
  const key = `${domain}:${email}`;
  const count = pruneAndCount(emailAttempts, key, EMAIL_WINDOW_MS);
  if (count > EMAIL_MAX) {
    logRateLimited(req, 'email');
    return res.status(429).json({ error: GENERIC_RATE_LIMIT_MESSAGE });
  }
  next();
}

module.exports = { passwordResetIpRateLimit, passwordResetEmailRateLimit };
