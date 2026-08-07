/*
 * whatsappRateLimit.js
 *
 * Rate limit das ações do WhatsApp (conectar/reconectar, sincronizar status,
 * testar conexão) e da reconciliação de instâncias. Mesmo padrão em memória
 * (Map + janela deslizante) já usado no login do desenvolvedor e na
 * recuperação de senha — suficiente para um único processo Node.
 *
 * Chave: <ação>:<tenantId>:<IP>. Protege contra loops acidentais de QR Code
 * (gerar QR repetidamente reseta a sessão) e varredura de instâncias.
 */
'use strict';

const { logActivity } = require('../database/coreDatabase');

const WINDOW_MS = 60 * 1000;
const DEFAULT_LIMITS = {
  connect: 5,
  refresh: 20,
  testConnection: 10,
  reconcile: 5
};

const RATE_LIMIT_MESSAGE = 'Muitas solicitações. Aguarde alguns instantes.';

const attempts = new Map();

function pruneAndCount(key, windowMs) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length;
}

function tenantIdOf(req) {
  if (req.tenant && req.tenant.id) return req.tenant.id;
  if (req.tenantFromDomain && req.tenantFromDomain.id) return req.tenantFromDomain.id;
  const param = req.params && req.params.tenantId;
  return param || 'dev';
}

function whatsappRateLimit(action, opts = {}) {
  const max = opts.max || DEFAULT_LIMITS[action] || 10;
  const windowMs = opts.windowMs || WINDOW_MS;
  return (req, res, next) => {
    const key = `${action}:${tenantIdOf(req)}:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
    const count = pruneAndCount(key, windowMs);
    if (count > max) {
      try {
        logActivity(null, tenantIdOf(req), 'WHATSAPP_RATE_LIMITED', JSON.stringify({ action, ip: req.ip || null }));
      } catch (err) {
        console.error('[whatsapp-rate-limit] Falha ao registrar log:', err.message);
      }
      return res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    }
    next();
  };
}

module.exports = { whatsappRateLimit, DEFAULT_LIMITS };
