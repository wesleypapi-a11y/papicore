/*
 * webhookService.js
 *
 * Webhooks de saída da API pública (aba "API" do Painel do Desenvolvedor).
 *
 * Arquitetura (outbox — mesmo padrão do WhatsApp):
 *   1. A operação de negócio é SEMPRE concluída primeiro;
 *   2. Só depois enqueueEvent grava o evento na api_webhook_outbox (banco
 *      central) para TODOS os webhooks do tenant que assinaram o evento;
 *   3. Um dispatcher em segundo plano entrega os eventos com assinatura
 *      HMAC-SHA256 (cabeçalho X-PapiCore-Signature) e política de retry
 *      com backoff exponencial. Falha de webhook NUNCA desfaz a operação.
 *
 * Assinatura: HMAC-SHA256(secret, payload). O cliente integrador valida
 * recalculando o HMAC com o secret informado na criação do webhook.
 *
 * O dispatcher roda sob setImmediate (não bloqueia a resposta da API).
 */

'use strict';

const crypto = require('crypto');
const { getDb } = require('../database/tenantDatabase');
const { getAppointmentServicesForBusinessRules } = require('./appointmentService');
const {
  getApiWebhookById,
  apiWebhookMatches,
  insertWebhookOutbox,
  listWebhookOutboxDue,
  claimWebhookOutbox,
  markWebhookOutboxResult,
  getWebhookOutboxById
} = require('../database/coreDatabase');

const WEBHOOK_EVENTS = {
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_UPDATED: 'appointment.updated',
  APPOINTMENT_COMPLETED: 'appointment.completed',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  PACKAGE_SOLD: 'package.sold'
};

const WEBHOOK_EVENT_LIST = Object.values(WEBHOOK_EVENTS);

const MAX_RETRIES = Math.max(1, Number(process.env.API_WEBHOOK_MAX_RETRIES) || 5);
const BASE_DELAY_MS = Math.max(100, Number(process.env.API_WEBHOOK_BASE_DELAY_MS) || 5000);
const TIMEOUT_MS = Math.max(500, Number(process.env.API_WEBHOOK_TIMEOUT_MS) || 10000);

function signPayload(secret, payloadString) {
  return crypto.createHmac('sha256', String(secret)).update(String(payloadString)).digest('hex');
}

function buildAppointmentPayload(appointment) {
  const services = getAppointmentServicesForBusinessRules(getDb(), appointment).map((service) => ({
    id: service.service_id,
    name: service.name,
    quantity: service.quantity,
    price: service.price,
    duration_minutes: service.duration_minutes
  }));
  return {
    type: 'appointment',
    id: appointment.id,
    appointment_code: appointment.appointment_code,
    status: appointment.status,
    customer_name: appointment.customer_name,
    customer_phone: appointment.customer_phone,
    customer_email: appointment.customer_email || null,
    vehicle_plate: appointment.vehicle_plate,
    vehicle_model: appointment.vehicle_model,
    vehicle_category: appointment.vehicle_category,
    modality: appointment.modality_name || appointment.modality_slug || null,
    unit: appointment.unit_name || null,
    services,
    appointment_date: appointment.appointment_date,
    start_time: appointment.start_time,
    end_date: appointment.end_date,
    end_time: appointment.end_time,
    service_price: Number(appointment.service_price) || 0,
    modality_fee: Number(appointment.modality_fee) || 0,
    total_price: Number(appointment.total_price) || 0,
    price_is_estimate: Boolean(appointment.price_is_estimate),
    payment_method: appointment.payment_method || null,
    payment_source: appointment.payment_source || null,
    customer_notes: appointment.customer_notes || null,
    created_at: appointment.created_at
  };
}

function buildPackageSoldPayload(cp) {
  return {
    type: 'package',
    id: cp.id,
    customer_package_id: cp.id,
    customer_id: cp.customer_id,
    customer_name: cp.customer_name || (cp.customer && cp.customer.name) || null,
    package_name: cp.package_name_snapshot,
    package_id: cp.package_id,
    purchase_price_cents: Number(cp.purchase_price_cents) || 0,
    discount_cents: Number(cp.discount_cents) || 0,
    payment_method: cp.payment_method || null,
    purchased_at: cp.purchased_at,
    expires_at: cp.expires_at,
    status: cp.status
  };
}

/* Tenant da requisição atual, em qualquer fluxo (admin, site público, API). */
function tenantIdOf(req) {
  if (req.tenantId) return req.tenantId;
  if (req.tenant && req.tenant.id) return req.tenant.id;
  if (req.tenantFromDomain && req.tenantFromDomain.id) return req.tenantFromDomain.id;
  return null;
}

/*
 * Dispara um evento de webhook a partir de um controller (admin/site/API).
 * Nunca lança: falha aqui é apenas logada — não derruba a operação.
 */
function fire(req, event, payload) {
  const tid = tenantIdOf(req);
  if (!tid) return { skipped: true, reason: 'no_tenant' };
  return enqueueEvent(tid, event, payload);
}

/*
 * Grava o evento na outbox para todos os webhooks do tenant que assinaram o
 * evento. Nunca lança: falha aqui é apenas logada.
 */
function enqueueEvent(tenantId, event, payload) {
  try {
    const { listApiWebhooks } = require('../database/coreDatabase');
    const webhooks = listApiWebhooks({ tenantId }).filter((w) => apiWebhookMatches(w, event));
    if (!webhooks.length) return { enqueued: 0 };

    const payloadString = JSON.stringify(payload);
    let enqueued = 0;
    for (const webhook of webhooks) {
      const signature = signPayload(webhook.secret, payloadString);
      insertWebhookOutbox({
        id: crypto.randomUUID(),
        webhook_id: webhook.id,
        tenant_id: tenantId,
        event,
        payload: payloadString,
        signature,
        next_attempt_at: new Date().toISOString()
      });
      enqueued += 1;
    }
    scheduleDispatch();
    return { enqueued };
  } catch (err) {
    console.error('[webhook] Erro ao enfileirar evento', event, 'do tenant', tenantId, ':', err.message);
    return { enqueued: 0, error: err.message };
  }
}

/* Processa a fila em segundo plano, fora do contexto da requisição. */
function scheduleDispatch() {
  setImmediate(() => {
    dispatchDue().catch((err) => {
      console.error('[webhook] Erro ao processar fila:', err && err.message);
    });
  });
}

/*
 * Entrega os eventos PENDING cuja próxima tentativa venceu.
 * Retry: backoff exponencial (base * 2^tentativas) até MAX_RETRIES.
 * Usa global.fetch para poder ser mockado nos testes.
 */
async function dispatchDue({ limit = 25 } = {}) {
  const due = listWebhookOutboxDue(new Date().toISOString(), limit);
  const stats = { delivered: 0, failed: 0, retrying: 0 };

  for (const row of due) {
    if (!claimWebhookOutbox(row.id)) continue;

    const webhook = getApiWebhookById(row.webhook_id);
    if (!webhook || webhook.active !== 1) {
      markWebhookOutboxResult(row.id, { status: 'CANCELED', last_error: 'Webhook removido ou desativado.' });
      continue;
    }

    const outcome = await deliver(row, webhook);
    if (outcome === 'DELIVERED') stats.delivered += 1;
    else if (outcome === 'FAILED') stats.failed += 1;
    else stats.retrying += 1;
  }
  return stats;
}

async function deliver(row, webhook) {
  const payloadString = row.payload;
  const signature = row.signature;

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PapiCore-Webhooks/1.0',
        'X-PapiCore-Event': row.event,
        'X-PapiCore-Delivery': row.id,
        'X-PapiCore-Signature': `sha256=${signature}`
      },
      body: payloadString,
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (err) {
    return handleDeliveryFailure(row, webhook, null, err.message);
  }

  if (response && response.ok) {
    markWebhookOutboxResult(row.id, {
      status: 'DELIVERED',
      last_http_status: response.status,
      last_error: null,
      delivered_at: new Date().toISOString(),
      next_attempt_at: null
    });
    return 'DELIVERED';
  }

  const statusText = response ? `HTTP ${response.status}` : 'sem resposta';
  return handleDeliveryFailure(row, webhook, response ? response.status : null, statusText);
}

function handleDeliveryFailure(row, webhook, httpStatus, errorText) {
  const attempts = Number(row.attempts) || 0;
  if (attempts >= MAX_RETRIES) {
    markWebhookOutboxResult(row.id, {
      status: 'FAILED',
      last_http_status: httpStatus,
      last_error: String(errorText).slice(0, 500),
      next_attempt_at: null
    });
    return 'FAILED';
  }
  const nextAttemptAt = new Date(Date.now() + BASE_DELAY_MS * Math.pow(2, attempts)).toISOString();
  markWebhookOutboxResult(row.id, {
    status: 'PENDING',
    last_http_status: httpStatus,
    last_error: String(errorText).slice(0, 500),
    next_attempt_at: nextAttemptAt
  });
  return 'RETRYING';
}

/* Envio imediato de um ping de teste (botão no painel do desenvolvedor).
   NÃO vai para a outbox: só confirma se a URL responde e valida a assinatura
   que o integrador receberia. */
async function sendTestDelivery(webhook) {
  const payload = {
    type: 'ping',
    event: 'webhook.test',
    timestamp: new Date().toISOString(),
    message: 'Teste de webhook do PapiCore.'
  };
  const payloadString = JSON.stringify(payload);
  const signature = signPayload(webhook.secret, payloadString);

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PapiCore-Webhooks/1.0',
        'X-PapiCore-Event': 'webhook.test',
        'X-PapiCore-Delivery': `test-${Date.now()}`,
        'X-PapiCore-Signature': `sha256=${signature}`
      },
      body: payloadString,
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (err) {
    return { ok: false, http_status: null, error: err.message };
  }

  if (!response) return { ok: false, http_status: null, error: 'Sem resposta da URL.' };
  if (response.ok) return { ok: true, http_status: response.status };
  return { ok: false, http_status: response.status, error: `A URL respondeu com HTTP ${response.status}.` };
}

/* Reenvia um item específico da outbox imediatamente (com a mesma assinatura). */
async function redeliver(outboxId) {
  const row = getWebhookOutboxById(outboxId);
  if (!row) return { ok: false, error: 'Registro não encontrado.' };
  const webhook = getApiWebhookById(row.webhook_id);
  if (!webhook) return { ok: false, error: 'Webhook não encontrado.' };
  const outcome = await deliver(row, webhook);
  return { ok: outcome === 'DELIVERED', outcome };
}

module.exports = {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_LIST,
  signPayload,
  buildAppointmentPayload,
  buildPackageSoldPayload,
  enqueueEvent,
  tenantIdOf,
  fire,
  dispatchDue,
  scheduleDispatch,
  sendTestDelivery,
  redeliver,
  MAX_RETRIES,
  BASE_DELAY_MS,
  TIMEOUT_MS
};
