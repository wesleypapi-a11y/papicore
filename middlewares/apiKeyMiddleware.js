/*
 * apiKeyMiddleware.js
 *
 * Autenticação da API pública (/api/v1) por chave de API.
 *
 * A chave chega em "Authorization: Bearer pk_live_...". O middleware:
 *   - gera o SHA-256 da chave e procura em api_keys (a chave pura nunca é
 *     armazenada — apenas o hash);
 *   - valida status (ACTIVE/REVOKED/EXPIRED/SUSPENDED) e expiração;
 *   - valida o scope exigido pela rota (ex.: appointments:write);
 *   - aplica rate limit em memória por chave (janela deslizante);
 *   - carrega o tenant da chave e abre o banco dele, rodando toda a cadeia
 *     dentro de runWithTenant — o isolamento multi-tenant é idêntico ao do
 *     painel admin (o tenant NUNCA vem do frontend, só da chave);
 *   - registra a requisição em api_request_logs (método, path, status,
 *     duração, IP) e atualiza last_used_at.
 *
 * A resposta de erro nunca expõe a chave nem detalhes internos.
 */

'use strict';

const crypto = require('crypto');
const {
  getApiKeyByHash,
  getTenantById,
  isTenantInMaintenance,
  insertApiRequestLog,
  touchApiKey,
  API_KEY_STATUSES
} = require('../database/coreDatabase');
const { openTenantDatabase, runWithTenant } = require('../database/tenantDatabase');
const { AppError, todayStr } = require('../utils/helpers');

/* Rate limit em memória (janela deslizante). Suficiente para esta camada:
   o painel admin também usa rate limit em memória para login/reset. */
const rateBuckets = new Map();
const API_RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.API_RATE_LIMIT_PER_MIN) || 60);
const API_RATE_WINDOW_MS = 60 * 1000;

function checkRateLimit(apiKeyId) {
  const now = Date.now();
  const bucket = (rateBuckets.get(apiKeyId) || []).filter((t) => now - t < API_RATE_WINDOW_MS);
  if (bucket.length >= API_RATE_LIMIT_PER_MIN) {
    return false;
  }
  bucket.push(now);
  rateBuckets.set(apiKeyId, bucket);
  return true;
}

/* Limpa buckets parados (evita crescimento ilimitado da memória). */
function cleanRateBuckets() {
  const now = Date.now();
  for (const [key, timestamps] of rateBuckets) {
    const fresh = timestamps.filter((t) => now - t < API_RATE_WINDOW_MS);
    if (!fresh.length) rateBuckets.delete(key);
    else rateBuckets.set(key, fresh);
  }
}
setInterval(cleanRateBuckets, 5 * 60 * 1000).unref();

/* Expurga buckets em testes (janela configurável). */
function resetApiRateLimits() {
  rateBuckets.clear();
}

const SCOPES = [
  'settings:read',
  'catalog:read',
  'availability:read',
  'appointments:read',
  'appointments:write',
  'customers:read',
  'packages:read'
];

const ALL_SCOPES = [...SCOPES];

function hasScope(key, scope) {
  const scopes = JSON.parse(key.scopes || '[]');
  return scopes.includes(scope);
}

function reject(req, res, status, message) {
  return res.status(status).json({ error: message });
}

/*
 * Middleware de autenticação por chave de API + abertura do banco do tenant.
 * Uso: app.use(requireApiKey) em um router cujas rotas precisam de chave.
 */
function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const apiKey = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  const start = Date.now();

  /* Resposta final registra o log da requisição (status real + duração). */
  res.on('finish', () => {
    try {
      insertApiRequestLog({
        tenant_id: req.tenantId || null,
        api_key_id: req.apiKeyId || null,
        key_prefix: req.apiKeyPrefix || null,
        method: req.method,
        path: req.originalUrl || req.url,
        status_code: res.statusCode,
        duration_ms: Date.now() - start,
        ip: req.ip,
        user_agent: req.get && req.get('user-agent') ? req.get('user-agent') : null
      });
    } catch (err) {
      console.error('[api] Erro ao registrar log de requisição:', err.message);
    }
  });

  if (!apiKey) {
    return reject(req, res, 401, 'Autenticação obrigatória. Envie a chave em Authorization: Bearer <chave>.');
  }

  let keyRow;
  try {
    keyRow = getApiKeyByHash(sha256hex(apiKey));
  } catch (err) {
    console.error('[api] Erro ao validar chave:', err.message);
    return reject(req, res, 500, 'Erro interno ao autenticar a chave.');
  }

  if (!keyRow) {
    return reject(req, res, 401, 'Chave de API inválida ou revogada.');
  }

  /* Status da chave. */
  if (!API_KEY_STATUSES.includes(keyRow.status)) {
    return reject(req, res, 403, 'Chave de API com status inválido.');
  }
  if (keyRow.status === 'REVOKED') {
    return reject(req, res, 401, 'Chave de API inválida ou revogada.');
  }
  if (keyRow.status === 'SUSPENDED') {
    return reject(req, res, 403, 'A chave de API está suspensa.');
  }
  if (keyRow.expires_at && keyRow.expires_at < todayStr()) {
    return reject(req, res, 403, 'A chave de API expirou.');
  }
  if (keyRow.status === 'EXPIRED') {
    return reject(req, res, 403, 'A chave de API expirou.');
  }

  /* Rate limit por chave. */
  if (!checkRateLimit(keyRow.id)) {
    return reject(req, res, 429, `Limite de requisições excedido (${API_RATE_LIMIT_PER_MIN}/min). Aguarde e tente novamente.`);
  }

  /* Tenant da chave — nunca do frontend. */
  const tenant = getTenantById(keyRow.tenant_id);
  if (!tenant) {
    return reject(req, res, 403, 'Empresa vinculada à chave não encontrada.');
  }
  if (tenant.status !== 'ACTIVE') {
    return reject(req, res, 403, 'A empresa vinculada a esta chave está suspensa.');
  }
  if (tenant.expires_at && tenant.expires_at < todayStr()) {
    return reject(req, res, 403, 'A assinatura da empresa vinculada a esta chave expirou.');
  }
  if (isTenantInMaintenance(tenant.id)) {
    return reject(req, res, 503, 'Sistema temporariamente em manutenção. Tente novamente em instantes.');
  }

  let db;
  try {
    db = openTenantDatabase(tenant.database_name);
  } catch (err) {
    console.error('[api] Falha ao abrir banco do tenant', tenant.database_name, err.message);
    return reject(req, res, 500, 'Erro ao acessar o banco da empresa.');
  }

  req.apiKey = keyRow;
  req.apiKeyId = keyRow.id;
  req.apiKeyPrefix = keyRow.key_prefix;
  req.apiKeyScopes = JSON.parse(keyRow.scopes || '[]');
  req.tenant = tenant;
  req.tenantId = tenant.id;
  req.tenantDb = db;

  try {
    touchApiKey(keyRow.id);
  } catch (err) {
    console.error('[api] Erro ao atualizar last_used_at:', err.message);
  }

  return runWithTenant(db, () => next());
}

/*
 * Valida o scope exigido por uma rota. Deve ser usado DEPOIS de requireApiKey.
 * Ex.: router.get('/appointments', requireApiKey, requireScope('appointments:read'), handler).
 */
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiKeyScopes || !req.apiKeyScopes.includes(scope)) {
      return reject(req, res, 403, `Sua chave não tem a permissão "${scope}". Solicite um escopo maior.`);
    }
    return next();
  };
}

function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  requireApiKey,
  requireScope,
  hasScope,
  SCOPES,
  ALL_SCOPES,
  resetApiRateLimits,
  sha256hex,
  AppError
};
