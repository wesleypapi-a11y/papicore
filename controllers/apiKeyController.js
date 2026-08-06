/*
 * apiKeyController.js
 *
 * Handlers da aba "API" do Painel do Desenvolvedor
 * (rotas /api/developer/api/*, protegidas por requireDeveloper).
 *
 * Regras de segurança:
 *   - A chave pura (pk_live_...) é mostrada UMA ÚNICA VEZ, na criação ou
 *     rotação. Só o hash SHA-256 fica no banco.
 *   - O secret do webhook segue a mesma regra (mostrado uma única vez).
 *   - Listagens nunca retornam chave/secret — apenas prefixos mascarados.
 *   - A chave pertence a um tenant; o tenant nunca vem do frontend para
 *     autenticar, só para atribuir a chave (operação do painel).
 */

'use strict';

const crypto = require('crypto');
const {
  generateApiKey,
  createApiKey,
  getApiKeyById,
  listApiKeysAll,
  listApiKeys,
  updateApiKey,
  deleteApiKey,
  countApiKeysByTenant,
  generateWebhookSecret,
  createApiWebhook,
  getApiWebhookById,
  listApiWebhooks,
  updateApiWebhook,
  deleteApiWebhook,
  listWebhookOutbox,
  countWebhookOutboxPending,
  listApiRequestLogs,
  listApiRequestLogsAll,
  getTenantById,
  listTenants
} = require('../database/coreDatabase');
const webhookService = require('../services/webhookService');
const { ALL_SCOPES } = require('../middlewares/apiKeyMiddleware');
const { AppError } = require('../utils/helpers');

/* Valida um array de scopes contra a lista fechada. */
function validateScopes(scopes) {
  if (!Array.isArray(scopes)) throw new AppError(400, 'Informe ao menos um escopo.');
  const allowed = new Set(ALL_SCOPES);
  for (const s of scopes) {
    if (typeof s !== 'string' || !allowed.has(s)) {
      throw new AppError(400, `Escopo inválido: "${s}". Use um dos escopos disponíveis.`);
    }
  }
  return [...new Set(scopes)];
}

function validateWebhookEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    throw new AppError(400, 'Selecione ao menos um evento de webhook.');
  }
  const allowed = new Set(webhookService.WEBHOOK_EVENT_LIST);
  for (const e of events) {
    if (typeof e !== 'string' || !allowed.has(e)) {
      throw new AppError(400, `Evento inválido: "${e}".`);
    }
  }
  return [...new Set(events)];
}

function validateWebhookUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\/.+/i.test(url.trim())) {
    throw new AppError(400, 'URL do webhook inválida. Use http(s)://...');
  }
  return url.trim();
}

function requireTenant(id) {
  const tenant = getTenantById(Number(id));
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  return tenant;
}

/* ----------------------------------------------------- Visão geral */

function apiOverviewHandler(req, res) {
  const allKeys = listApiKeysAll({ limit: 100000 });
  const allWebhooks = listApiWebhooks({});
  const tenants = listTenants();
  return res.json({
    keys_count: allKeys.length,
    webhooks_count: allWebhooks.length,
    pending_webhooks: countWebhookOutboxPending(),
    tenants_with_keys: new Set(allKeys.map((k) => k.tenant_id)).size,
    recent_requests: listApiRequestLogsAll({ limit: 10 }),
    recent_webhooks: listWebhookOutbox({ limit: 10 }),
    scopes: ALL_SCOPES,
    webhook_events: webhookService.WEBHOOK_EVENT_LIST,
    tenant_count: tenants.length
  });
}

/* ---------------------------------------------------------- Chaves */

function listKeysHandler(req, res) {
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
  if (tenantId) {
    requireTenant(tenantId);
    return res.json(listApiKeys({ tenantId }));
  }
  return res.json(listApiKeysAll({ limit: 500 }));
}

function createKeyHandler(req, res) {
  const { tenant_id, name, scopes, expires_at } = req.body || {};
  const tenant = requireTenant(tenant_id);
  const keyName = String(name || '').trim();
  if (keyName.length < 3) throw new AppError(400, 'Informe um nome para a chave (mínimo de 3 caracteres).');
  const validScopes = validateScopes(scopes);

  let expires = null;
  if (expires_at) {
    if (typeof expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expires_at)) {
      throw new AppError(400, 'Data de expiração inválida. Use o formato AAAA-MM-DD.');
    }
    expires = expires_at;
  }

  const generated = generateApiKey();
  const key = createApiKey({
    id: crypto.randomUUID(),
    tenant_id: tenant.id,
    name: keyName,
    key_hash: generated.keyHash,
    key_prefix: generated.keyPrefix,
    scopes: validScopes,
    expires_at: expires,
    created_by_user_id: req.user.id
  });

  logApiActivity(req.user, tenant.id, 'API_KEY_CREATED', `Chave de API "${keyName}" criada (${tenant.name}).`);
  return res.status(201).json({ api_key: generated.apiKey, key: sanitizeKey(key) });
}

function rotateKeyHandler(req, res) {
  const key = getApiKeyById(req.params.id);
  if (!key) throw new AppError(404, 'Chave de API não encontrada.');

  const generated = generateApiKey();
  const updated = updateApiKey(key.id, { key_hash: generated.keyHash, key_prefix: generated.keyPrefix });
  logApiActivity(req.user, key.tenant_id, 'API_KEY_ROTATED', `Chave de API "${key.name}" rotacionada.`);
  return res.json({ api_key: generated.apiKey, key: sanitizeKey(updated) });
}

function updateKeyHandler(req, res) {
  const key = getApiKeyById(req.params.id);
  if (!key) throw new AppError(404, 'Chave de API não encontrada.');

  const fields = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (name.length < 3) throw new AppError(400, 'Nome muito curto.');
    fields.name = name;
  }
  if (req.body.scopes !== undefined) fields.scopes = validateScopes(req.body.scopes);
  if (req.body.status !== undefined) {
    if (!['ACTIVE', 'REVOKED', 'EXPIRED', 'SUSPENDED'].includes(req.body.status)) {
      throw new AppError(400, 'Status inválido.');
    }
    fields.status = req.body.status;
  }
  if (req.body.expires_at !== undefined) {
    const value = req.body.expires_at === null || req.body.expires_at === '' ? null : String(req.body.expires_at);
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AppError(400, 'Data de expiração inválida. Use o formato AAAA-MM-DD.');
    }
    fields.expires_at = value;
  }

  const updated = updateApiKey(key.id, fields);
  logApiActivity(req.user, key.tenant_id, 'API_KEY_UPDATED', `Chave de API "${key.name}" atualizada.`);
  return res.json({ key: sanitizeKey(updated) });
}

function deleteKeyHandler(req, res) {
  const key = getApiKeyById(req.params.id);
  if (!key) throw new AppError(404, 'Chave de API não encontrada.');
  deleteApiKey(key.id);
  logApiActivity(req.user, key.tenant_id, 'API_KEY_DELETED', `Chave de API "${key.name}" removida.`);
  return res.json({ success: true });
}

function sanitizeKey(key) {
  if (!key) return null;
  const { key_hash, ...rest } = key;
  return rest;
}

/* -------------------------------------------------------- Webhooks */

function listWebhooksHandler(req, res) {
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
  const rows = tenantId
    ? listApiWebhooks({ tenantId }).map(sanitizeWebhook)
    : listApiWebhooks({}).map(sanitizeWebhook);
  return res.json(rows);
}

function sanitizeWebhook(webhook) {
  return {
    ...webhook,
    secret: undefined,
    has_secret: true,
    secret_hint: '••••••••••••••••••••••••••••••••••••'
  };
}

function createWebhookHandler(req, res) {
  const { tenant_id, name, url, events, active } = req.body || {};
  const tenant = requireTenant(tenant_id);
  const webhookName = String(name || '').trim();
  if (webhookName.length < 3) throw new AppError(400, 'Informe um nome para o webhook.');
  const webhookUrl = validateWebhookUrl(url);
  const validEvents = validateWebhookEvents(events);

  const secret = generateWebhookSecret();
  const webhook = createApiWebhook({
    id: crypto.randomUUID(),
    tenant_id: tenant.id,
    name: webhookName,
    url: webhookUrl,
    secret,
    events: validEvents,
    active: active === undefined ? 1 : active ? 1 : 0,
    created_by_user_id: req.user.id
  });

  logApiActivity(req.user, tenant.id, 'API_WEBHOOK_CREATED', `Webhook "${webhookName}" criado (${tenant.name}).`);
  return res.status(201).json({ webhook: sanitizeWebhook(webhook), secret });
}

function updateWebhookHandler(req, res) {
  const webhook = getApiWebhookById(req.params.id);
  if (!webhook) throw new AppError(404, 'Webhook não encontrado.');

  const fields = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (name.length < 3) throw new AppError(400, 'Nome muito curto.');
    fields.name = name;
  }
  if (req.body.url !== undefined) fields.url = validateWebhookUrl(req.body.url);
  if (req.body.events !== undefined) fields.events = validateWebhookEvents(req.body.events);
  if (req.body.active !== undefined) fields.active = req.body.active ? 1 : 0;

  const updated = updateApiWebhook(webhook.id, fields);
  logApiActivity(req.user, webhook.tenant_id, 'API_WEBHOOK_UPDATED', `Webhook "${webhook.name}" atualizado.`);
  return res.json({ webhook: sanitizeWebhook(updated) });
}

function deleteWebhookHandler(req, res) {
  const webhook = getApiWebhookById(req.params.id);
  if (!webhook) throw new AppError(404, 'Webhook não encontrado.');
  deleteApiWebhook(webhook.id);
  logApiActivity(req.user, webhook.tenant_id, 'API_WEBHOOK_DELETED', `Webhook "${webhook.name}" removido.`);
  return res.json({ success: true });
}

async function testWebhookHandler(req, res) {
  const webhook = getApiWebhookById(req.params.id);
  if (!webhook) throw new AppError(404, 'Webhook não encontrado.');
  const result = await webhookService.sendTestDelivery(webhook);
  return res.json(result);
}

async function redeliverWebhookHandler(req, res) {
  const result = await webhookService.redeliver(req.params.outboxId);
  return res.json(result);
}

/* ---------------------------------------------------- Logs de API */

function listWebhookLogsHandler(req, res) {
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const rows = listWebhookOutbox({ tenantId, limit });
  return res.json(rows);
}

function listRequestLogsHandler(req, res) {
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const rows = tenantId ? listApiRequestLogs({ tenantId, limit }) : listApiRequestLogsAll({ limit });
  return res.json(rows);
}

/* -------------------------------------------------------- Auxiliar */

function logApiActivity(user, tenantId, action, details) {
  const { logActivity } = require('../database/coreDatabase');
  try {
    logActivity(user ? user.id : null, tenantId, action, details);
  } catch (err) {
    console.error('[api] Erro ao registrar atividade:', err.message);
  }
}

module.exports = {
  apiOverviewHandler,
  listKeysHandler,
  createKeyHandler,
  rotateKeyHandler,
  updateKeyHandler,
  deleteKeyHandler,
  listWebhooksHandler,
  createWebhookHandler,
  updateWebhookHandler,
  deleteWebhookHandler,
  testWebhookHandler,
  redeliverWebhookHandler,
  listWebhookLogsHandler,
  listRequestLogsHandler
};
