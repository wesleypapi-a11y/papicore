/*
 * whatsappController.js
 *
 * Rotas administrativas do WhatsApp (Configurações > WhatsApp):
 *   - status do modo (MOCK/simulado vs real);
 *   - modelos de mensagens automáticas por evento (listar/editar/restaurar);
 *   - histórico da outbox com reenvio manual;
 *   - conexão por empresa (QR Code) e webhook público.
 *
 * Os controllers NUNCA chamam a Evolution diretamente: todo o fluxo passa
 * pelo whatsappService, que decide o provider ativo (mock | evolution).
 */

const { getDb } = require('../database/tenantDatabase');
const whatsappService = require('../services/whatsappService');
const { AppError } = require('../utils/helpers');

function getStatus(req, res) {
  return res.json(whatsappService.getStatus());
}

function listTemplates(req, res) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM whatsapp_message_templates ORDER BY id ASC').all();
  return res.json(rows);
}

function updateTemplate(req, res) {
  const db = getDb();
  const { eventKey } = req.params;
  const { content, enabled } = req.body || {};

  const existing = db.prepare('SELECT * FROM whatsapp_message_templates WHERE event_key = ?').get(eventKey);
  if (!existing) throw new AppError(404, 'Evento de mensagem automática não encontrado.');

  const validated = whatsappService.validateTemplateContent(content);
  db.prepare(
    `UPDATE whatsapp_message_templates SET content = ?, enabled = ?, updated_at = datetime('now', 'localtime') WHERE event_key = ?`
  ).run(validated, enabled ? 1 : 0, eventKey);

  whatsappService.logWhatsapp(whatsappService.LOG_ACTIONS.TEMPLATE_UPDATED, req.tenant && req.tenant.id,
    { event_key: eventKey, enabled: Boolean(enabled) }, req.user && req.user.id);

  return res.json(db.prepare('SELECT * FROM whatsapp_message_templates WHERE event_key = ?').get(eventKey));
}

function restoreTemplate(req, res) {
  const db = getDb();
  const { eventKey } = req.params;
  const def = whatsappService.DEFAULT_TEMPLATES.find((t) => t.event_key === eventKey);
  if (!def) throw new AppError(404, 'Evento de mensagem automática não encontrado.');

  const validated = whatsappService.validateTemplateContent(def.content);
  db.prepare(
    `UPDATE whatsapp_message_templates SET name = ?, content = ?, enabled = 1, updated_at = datetime('now', 'localtime') WHERE event_key = ?`
  ).run(def.name, validated, eventKey);

  whatsappService.logWhatsapp(whatsappService.LOG_ACTIONS.TEMPLATE_UPDATED, req.tenant && req.tenant.id,
    { event_key: eventKey, action: 'restore' }, req.user && req.user.id);

  return res.json(db.prepare('SELECT * FROM whatsapp_message_templates WHERE event_key = ?').get(eventKey));
}

function listOutbox(req, res) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM whatsapp_outbox ORDER BY id DESC LIMIT 200').all();
  const result = rows.map((r) => {
    let payload = {};
    try {
      payload = JSON.parse(r.payload_json || '{}');
    } catch { /* histórico corrompido não deve quebrar a listagem */ }
    return {
      id: r.id,
      event_key: r.event_key,
      event_label: whatsappService.EVENT_LABELS[r.event_key] || r.event_key,
      recipient: r.recipient,
      recipient_kind: r.recipient_kind,
      customer_name: payload.CLIENTE_NOME || '',
      status: r.status,
      attempts: r.attempts,
      last_error: r.last_error,
      message_text: r.message_text,
      created_at: r.created_at,
      sent_at: r.sent_at,
      processed_at: r.processed_at || ''
    };
  });
  return res.json(result);
}

async function resendOutbox(req, res) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(req.params.id);
  if (!row) throw new AppError(404, 'Mensagem não encontrada no histórico.');
  if (!['FAILED', 'SIMULATED'].includes(row.status)) {
    throw new AppError(400, 'Apenas mensagens com falha ou simuladas podem ser reenviadas.');
  }
  whatsappService.resendOutbox(db, row.id);
  await whatsappService.processOutbox({ db });
  return res.json(db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(row.id));
}

/* ---------- Conexão (via whatsappService → provider ativo) ---------- */

function getConnection(req, res) {
  return res.json(whatsappService.connectionState(req.tenant));
}

async function connectConnection(req, res) {
  const result = await whatsappService.connect(req.tenant);
  if (result.error) {
    console.error(`[whatsapp] connect falhou (tenant ${req.tenant && req.tenant.id}): ${result.code || 'erro'} — ${result.message}`);
    throw new AppError(
      whatsappService.connectErrorHttpStatus(result),
      whatsappService.friendlyErrorMessage(result),
      { code: whatsappService.connectErrorCode(result) }
    );
  }
  return res.json(result);
}

async function reconnectConnection(req, res) {
  const result = await whatsappService.reconnect(req.tenant);
  if (result.error) {
    console.error(`[whatsapp] reconnect falhou (tenant ${req.tenant && req.tenant.id}): ${result.code || 'erro'} — ${result.message}`);
    throw new AppError(
      whatsappService.connectErrorHttpStatus(result),
      whatsappService.friendlyErrorMessage(result),
      { code: whatsappService.connectErrorCode(result) }
    );
  }
  return res.json(result);
}

async function disconnectConnection(req, res) {
  const result = await whatsappService.disconnect(req.tenant);
  return res.json(result);
}

/* ---------- Webhook público (Evolution → PapiCore) ---------- */

async function handleWebhook(req, res) {
  const result = await whatsappService.handleWebhook(req.body || {}, req.headers);
  if (result.status !== 200) {
    return res.status(result.status).json({ error: result.error || 'Rejeitado.' });
  }
  return res.json({ received: true, event: result.event });
}

/* ---------- Histórico imutável de mensagens ---------- */

/* Lista whatsapp_message_history com filtros opcionais (status, event_key,
   data) e paginação por cursor (id < ?) + limit. */
function getHistory(req, res) {
  const db = getDb();
  const { status, event_key: eventKey, date, limit, id } = req.query;
  const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);

  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(String(status)); }
  if (eventKey) { where.push('event_key = ?'); params.push(String(eventKey)); }
  if (date) { where.push("date(created_at) = date(?)"); params.push(String(date)); }
  if (id) { where.push('id < ?'); params.push(Number(id)); }
  const sql = `SELECT * FROM whatsapp_message_history ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  params.push(parsedLimit);

  const rows = db.prepare(sql).all(...params);
  return res.json(rows.map((r) => ({
    id: r.id,
    outbox_id: r.outbox_id,
    event_key: r.event_key,
    event_label: whatsappService.EVENT_LABELS[r.event_key] || r.event_key,
    recipient: r.recipient,
    recipient_kind: r.recipient_kind,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    message_text: r.message_text,
    triggered_at: r.triggered_at,
    sent_at: r.sent_at,
    created_at: r.created_at
  })));
}

module.exports = {
  getStatus,
  listTemplates,
  updateTemplate,
  restoreTemplate,
  listOutbox,
  resendOutbox,
  getHistory,
  getConnection,
  connectConnection,
  reconnectConnection,
  disconnectConnection,
  handleWebhook
};
