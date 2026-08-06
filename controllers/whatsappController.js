/*
 * whatsappController.js
 *
 * Rotas administrativas do WhatsApp (Configurações > WhatsApp):
 *   - status do modo (MOCK/simulado vs real);
 *   - modelos de mensagens automáticas por evento (listar/editar/restaurar);
 *   - histórico da outbox com reenvio manual.
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
      sent_at: r.sent_at
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

module.exports = {
  getStatus,
  listTemplates,
  updateTemplate,
  restoreTemplate,
  listOutbox,
  resendOutbox
};
