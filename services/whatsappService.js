/*
 * whatsappService.js
 *
 * Mensagens automáticas de WhatsApp (MOCK por padrão).
 *
 * Fluxo: a operação de negócio (criar/confirmar/concluir agendamento) é SEMPRE
 * concluída primeiro; só depois a mensagem é gravada na outbox
 * (whatsapp_outbox) e processada em segundo plano. Falha no WhatsApp NUNCA
 * desfaz agendamento, confirmação, conclusão ou consumo de crédito.
 *
 * Modo MOCK: enquanto WHATSAPP_ENABLED não for "true", as mensagens são
 * registradas na outbox e processadas como "Simulada" (status SIMULATED),
 * sem chamar nenhuma API externa e sem gerar erro ao usuário.
 *
 * Idempotência: cada evento é único por agendamento (ex.: APPOINTMENT_COMPLETED:105).
 * Se a mesma mensagem já existe (PENDING/PROCESSING/SENT/SIMULATED), não é
 * gravada de novo — evita duplo clique e loops.
 */

const { getDb } = require('../database/tenantDatabase');
const { WHATSAPP_DEFAULT_TEMPLATES } = require('../database/tenantSchema');
const { LONG_SERVICE_THRESHOLD_MINUTES } = require('./durationService');
const packageService = require('./packageService');
const evolutionService = require('./evolutionService');
const {
  formatMoney,
  formatPhone,
  normalizePhone
} = require('../utils/helpers');

/* ---------- Eventos ---------- */

const EVENTS = {
  REQUESTED_CUSTOMER: 'APPOINTMENT_REQUESTED_CUSTOMER',
  REQUESTED_STORE: 'APPOINTMENT_REQUESTED_STORE',
  CONFIRMED: 'APPOINTMENT_CONFIRMED',
  CANCELLED: 'APPOINTMENT_CANCELLED',
  RESCHEDULED: 'APPOINTMENT_RESCHEDULED',
  COMPLETED: 'APPOINTMENT_COMPLETED',
  COMPLETED_PACKAGE: 'APPOINTMENT_COMPLETED_PACKAGE'
};

const EVENT_LABELS = {
  [EVENTS.REQUESTED_CUSTOMER]: 'Novo agendamento (cliente)',
  [EVENTS.REQUESTED_STORE]: 'Novo agendamento (loja)',
  [EVENTS.CONFIRMED]: 'Confirmação',
  [EVENTS.CANCELLED]: 'Cancelamento',
  [EVENTS.RESCHEDULED]: 'Reagendamento',
  [EVENTS.COMPLETED]: 'Conclusão',
  [EVENTS.COMPLETED_PACKAGE]: 'Conclusão — pacote'
};

/* Lista fechada de placeholders permitidos nos modelos. Qualquer outro
   token {{...}} é rejeitado na validação. */
const ALLOWED_PLACEHOLDERS = new Set([
  'EMPRESA_NOME',
  'CLIENTE_NOME',
  'CODIGO_AGENDAMENTO',
  'DATA_AGENDAMENTO',
  'HORARIO_AGENDAMENTO',
  'DURACAO',
  'SERVICO',
  'VEICULO',
  'UNIDADE',
  'MODALIDADE',
  'VALOR',
  'SALDO_PACOTE',
  'LINK_ADMIN'
]);

const OUTBOX_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED', 'CANCELLED'];

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/* ---------- Configuração (lida dinamicamente para permitir testes) ---------- */

function isWhatsappEnabled() {
  return String(process.env.WHATSAPP_ENABLED || '').toLowerCase() === 'true';
}

function isConfigured() {
  const token = String(process.env.WHATSAPP_TOKEN || '').trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  return Boolean(token && phoneNumberId);
}

function graphUrl() {
  return String(process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v21.0').replace(/\/+$/, '');
}

/* ---------- Formatação ---------- */

function fmtDateBR(dateStr) {
  const d = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function fmtDuration(minutes) {
  const m = Number(minutes || 0);
  if (!m) return '';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h && rest) return `${h}h${String(rest).padStart(2, '0')}`;
  if (h) return `${h}h`;
  return `${m} min`;
}

function isLongAppointment(a) {
  return Number(a && a.booked_duration_minutes || 0) > LONG_SERVICE_THRESHOLD_MINUTES;
}

/* Horário exibido nas mensagens: para longa duração o horário ainda será confirmado. */
function timeLabel(a) {
  return isLongAppointment(a) ? 'A confirmar' : `${a.start_time} às ${a.end_time}`;
}

function vehicleDescription(a) {
  let text = `${a.vehicle_brand || ''} ${a.vehicle_model || ''}`.trim();
  if (a.vehicle_year) text += ` (${a.vehicle_year})`;
  return text;
}

function getCompanyName() {
  const db = getDb();
  const s = db.prepare('SELECT company_name FROM company_settings WHERE id = 1').get();
  return (s && s.company_name) || 'PapiCore';
}

function getStorePhone() {
  const db = getDb();
  const s = db.prepare('SELECT whatsapp, phone FROM company_settings WHERE id = 1').get() || {};
  return s.whatsapp || s.phone || null;
}

/*
 * Resumo de saldo do pacote PÓS-consumo, usado no evento
 * APPOINTMENT_COMPLETED_PACKAGE. Deve ser chamado depois de
 * consumeForAppointment para refletir o estado já atualizado.
 */
function packageBalanceBlock(a) {
  if (!a || !a.customer_package_id) return '';
  const db = getDb();
  const cp = packageService.getCustomerPackage(db, a.customer_package_id);
  if (!cp || !Array.isArray(cp.balances) || !cp.balances.length) return '';
  const lines = cp.balances
    .filter((b) => Number(b.available) > 0)
    .map((b) => `${b.service_name}: ${b.available} disponíve${b.available === 1 ? 'l' : 'is'}`);
  if (!lines.length) return 'Pacote esgotado.';
  return lines.join('\n');
}

/* ---------- Placeholders ---------- */

function validateTemplateContent(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('O texto da mensagem não pode ficar vazio.');

  /* Rejeita HTML, JavaScript e conteúdo perigoso. */
  const dangerous = /<\s*script|<\/\w|javascript:|data:\s*\w|on\w+\s*=|on\w+\s*\(|\bstyle\s*=/i;
  if (dangerous.test(text)) {
    throw new Error('O texto contém HTML, JavaScript ou conteúdo inseguro.');
  }

  /* Placeholders só podem ser da lista fechada. */
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    const name = m[1].toUpperCase();
    if (!ALLOWED_PLACEHOLDERS.has(name)) {
      throw new Error(`Placeholder desconhecido: {{${name}}}.`);
    }
  }

  /* Chaves sem token válido (não balanceadas) são rejeitadas. */
  const stripped = text.replace(PLACEHOLDER_RE, '');
  if (stripped.includes('{{') || stripped.includes('}}')) {
    throw new Error('Use os placeholders no formato {{NOME}} e não deixe chaves soltas.');
  }
  return text;
}

/*
 * Resolve os valores de todos os placeholders para um evento/agendamento.
 * Para APPOINTMENT_COMPLETED_PACKAGE, inclui o saldo do pacote já consumido.
 */
function resolvePlaceholders(eventKey, appointment, opts = {}) {
  const a = appointment || {};
  const company = opts.companyName || getCompanyName();
  const values = {
    EMPRESA_NOME: company,
    CLIENTE_NOME: a.customer_name || '',
    CODIGO_AGENDAMENTO: a.appointment_code || '',
    DATA_AGENDAMENTO: fmtDateBR(a.appointment_date),
    HORARIO_AGENDAMENTO: timeLabel(a),
    DURACAO: a.booked_duration_minutes ? fmtDuration(a.booked_duration_minutes) : '',
    SERVICO: a.service_name || '',
    VEICULO: vehicleDescription(a),
    UNIDADE: a.unit_name || '—',
    MODALIDADE: a.modality_name || '—',
    VALOR: formatMoney(Number(a.total_price)),
    SALDO_PACOTE: '',
    LINK_ADMIN: opts.linkAdmin || '/admin'
  };
  if (eventKey === EVENTS.COMPLETED_PACKAGE) {
    values.SALDO_PACOTE = packageBalanceBlock(a);
  }
  return values;
}

function renderTemplate(content, values) {
  return String(content || '').replace(PLACEHOLDER_RE, (match, name) => {
    const key = name.toUpperCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : '';
  });
}

/* ---------- Outbox ---------- */

function idempotencyKey(eventKey, appointmentId) {
  return `${eventKey}:${appointmentId}`;
}

/*
 * Grava a mensagem na outbox (status PENDING) e agenda o processamento em
 * segundo plano — depois da operação de negócio e antes da resposta da API.
 * NÃO lança erro em falha de WhatsApp: retorna { skipped, reason }.
 */
function enqueueEvent(eventKey, appointment, opts = {}) {
  const db = getDb();
  if (!appointment || !appointment.id) {
    return { skipped: true, reason: 'invalid_appointment' };
  }

  const template = db.prepare('SELECT * FROM whatsapp_message_templates WHERE event_key = ?').get(eventKey);
  if (!template) return { skipped: true, reason: 'no_template' };
  if (!template.enabled) return { skipped: true, reason: 'disabled' };

  const recipientKind = eventKey === EVENTS.REQUESTED_STORE ? 'store' : 'customer';
  let recipient;
  if (recipientKind === 'store') {
    recipient = opts.recipient || getStorePhone();
    if (!recipient) return { skipped: true, reason: 'no_store_phone' };
  } else {
    recipient = appointment.customer_phone;
    if (!recipient) return { skipped: true, reason: 'no_recipient' };
  }
  recipient = normalizePhone(recipient);

  const key = idempotencyKey(eventKey, appointment.id);
  const existing = db.prepare('SELECT * FROM whatsapp_outbox WHERE idempotency_key = ?').get(key);

  /* Reenvio de um item que falhou: reaproveita a mesma linha. */
  if (existing) {
    if (existing.status !== 'FAILED') {
      return { skipped: true, reason: 'idempotent', id: existing.id };
    }
    const values = resolvePlaceholders(eventKey, appointment, opts);
    const text = renderTemplate(template.content, values);
    db.prepare(
      `UPDATE whatsapp_outbox SET recipient = ?, recipient_kind = ?, payload_json = ?,
         message_text = ?, status = 'PENDING', attempts = 0, last_error = NULL,
         scheduled_at = datetime('now', 'localtime'), sent_at = NULL
       WHERE id = ?`
    ).run(recipient, recipientKind, JSON.stringify(values), text, existing.id);
    scheduleProcessing(db);
    return { id: existing.id, skipped: false, reenqueued: true };
  }

  const values = resolvePlaceholders(eventKey, appointment, opts);
  const text = renderTemplate(template.content, values);
  const info = db.prepare(
    `INSERT INTO whatsapp_outbox
       (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`
  ).run(eventKey, recipient, recipientKind, JSON.stringify(values), text, key);
  scheduleProcessing(db);
  return { id: Number(info.lastInsertRowid), skipped: false };
}

/* Processamento em segundo plano, fora do contexto da requisição. O banco é
   capturado aqui porque o callback roda fora do AsyncLocalStorage da rota. */
function scheduleProcessing(db) {
  setImmediate(() => {
    processOutbox({ db }).catch((err) => {
      console.error('[whatsapp] Erro ao processar fila:', err && err.message);
    });
  });
}

/*
 * Processa mensagens PENDING da outbox.
 *   - Modo MOCK (WHATSAPP_ENABLED != true): marca como SIMULATED, sem chamar
 *     API externa e sem erro.
 *   - Habilitado + configurado: chama a API real; ok vira SENT, falha vira
 *     FAILED (a operação de negócio continua valendo).
 * Cada linha só é processada uma vez por rodada (reivindicação atômica).
 */
async function processOutbox({ db = getDb(), limit = 50 } = {}) {
  const rows = db.prepare('SELECT * FROM whatsapp_outbox WHERE status = ? ORDER BY id ASC LIMIT ?').all('PENDING', limit);
  const stats = { processed: 0, sent: 0, simulated: 0, failed: 0 };
  for (const row of rows) {
    const claimed = db.prepare(
      "UPDATE whatsapp_outbox SET status = 'PROCESSING', attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'"
    ).run(row.id);
    if (claimed.changes === 0) continue;
    stats.processed += 1;

    const outcome = await processOne(db, row);
    if (outcome === 'SENT') stats.sent += 1;
    else if (outcome === 'SIMULATED') stats.simulated += 1;
    else if (outcome === 'FAILED') stats.failed += 1;
  }
  return stats;
}

async function processOne(db, row) {
  /* Evolution API habilitada e configurada: envio real passa por ela. */
  if (evolutionService.getStatus().configured) {
    const instanceName = evolutionService.instanceNameFromDb(db);
    const result = await evolutionService.sendTextMessage(row.recipient, row.message_text, instanceName);
    if (result.error) {
      db.prepare("UPDATE whatsapp_outbox SET status = 'FAILED', last_error = ? WHERE id = ?")
        .run(result.message || `Falha de envio (HTTP ${result.status}).`, row.id);
      return 'FAILED';
    }
    db.prepare("UPDATE whatsapp_outbox SET status = 'SENT', sent_at = datetime('now', 'localtime') WHERE id = ?").run(row.id);
    return 'SENT';
  }
  if (!isWhatsappEnabled()) {
    db.prepare("UPDATE whatsapp_outbox SET status = 'SIMULATED', sent_at = datetime('now', 'localtime') WHERE id = ?").run(row.id);
    return 'SIMULATED';
  }
  if (!isConfigured()) {
    db.prepare(
      "UPDATE whatsapp_outbox SET status = 'FAILED', last_error = ? WHERE id = ?"
    ).run('WhatsApp não configurado (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID ausentes).', row.id);
    return 'FAILED';
  }
  const result = await sendTextMessage(row.recipient, row.message_text);
  if (result.error) {
    db.prepare("UPDATE whatsapp_outbox SET status = 'FAILED', last_error = ? WHERE id = ?")
      .run(result.message || `Falha de envio (HTTP ${result.status}).`, row.id);
    return 'FAILED';
  }
  db.prepare("UPDATE whatsapp_outbox SET status = 'SENT', sent_at = datetime('now', 'localtime') WHERE id = ?").run(row.id);
  return 'SENT';
}

/*
 * Reenvio manual (admin): reseta a linha para PENDING e reprocessa. Só faz
 * sentido para mensagens que falharam ou foram simuladas.
 */
function resendOutbox(db, id) {
  const row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(id);
  if (!row) return null;
  if (!['FAILED', 'SIMULATED'].includes(row.status)) return row;
  db.prepare(
    "UPDATE whatsapp_outbox SET status = 'PENDING', attempts = 0, last_error = NULL, sent_at = NULL, scheduled_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(id);
  return { ...row, status: 'PENDING', attempts: 0, last_error: null, sent_at: null };
}

/* ---------- Envio direto à API (usado quando habilitado) ---------- */

async function sendTextMessage(to, text) {
  if (!isConfigured()) {
    return { skipped: true, reason: 'not_configured' };
  }
  const phone = normalizePhone(to);
  if (!phone) {
    return { skipped: true, reason: 'invalid_recipient' };
  }
  try {
    const response = await fetch(`${graphUrl()}/${phoneNumberId()}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${String(process.env.WHATSAPP_TOKEN || '').trim()}`
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: text }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (data.error && data.error.message) || `HTTP ${response.status}`;
      console.error(`[whatsapp] Falha no envio para ${phone}: ${message}`);
      return { error: true, status: response.status, message };
    }
    return { ok: true, id: data.messages && data.messages[0] && data.messages[0].id };
  } catch (err) {
    console.error(`[whatsapp] Erro de rede ao enviar para ${phone}:`, err.message);
    return { error: true, status: 0, message: err.message };
  }
}

function phoneNumberId() {
  return String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
}

/* ---------- Compatibilidade (chamadas antigas continuam valendo) ---------- */

async function notifyAppointmentConfirmed(appointment) {
  return enqueueEvent(EVENTS.CONFIRMED, appointment);
}

async function notifyStoreNewAppointment(appointment) {
  return enqueueEvent(EVENTS.REQUESTED_STORE, appointment);
}

function buildConfirmationMessage(a) {
  const db = getDb();
  const tpl = db.prepare('SELECT content FROM whatsapp_message_templates WHERE event_key = ?').get(EVENTS.CONFIRMED);
  const values = resolvePlaceholders(EVENTS.CONFIRMED, a);
  return renderTemplate(tpl ? tpl.content : '', values);
}

function buildStoreNotificationMessage(a) {
  const db = getDb();
  const tpl = db.prepare('SELECT content FROM whatsapp_message_templates WHERE event_key = ?').get(EVENTS.REQUESTED_STORE);
  const values = resolvePlaceholders(EVENTS.REQUESTED_STORE, a);
  return renderTemplate(tpl ? tpl.content : '', values);
}

/* ---------- Status ---------- */

function getStatus() {
  const evolution = evolutionService.getStatus();
  return {
    provider: evolution.enabled ? 'evolution' : 'graph',
    enabled: evolution.enabled || isWhatsappEnabled(),
    configured: evolution.enabled ? evolution.configured : isConfigured(),
    mock: !(evolution.enabled || isWhatsappEnabled()),
    evolution: {
      enabled: evolution.enabled,
      configured: evolution.configured,
      server_url: evolution.server_url
    },
    graph: {
      enabled: !evolution.enabled && isWhatsappEnabled(),
      configured: isConfigured()
    }
  };
}

module.exports = {
  EVENTS,
  EVENT_LABELS,
  ALLOWED_PLACEHOLDERS,
  OUTBOX_STATUSES,
  DEFAULT_TEMPLATES: WHATSAPP_DEFAULT_TEMPLATES,
  isWhatsappEnabled,
  isConfigured,
  sendTextMessage,
  enqueueEvent,
  processOutbox,
  resendOutbox,
  validateTemplateContent,
  resolvePlaceholders,
  renderTemplate,
  notifyAppointmentConfirmed,
  notifyStoreNewAppointment,
  buildConfirmationMessage,
  buildStoreNotificationMessage,
  getStatus,
  formatPhone
};