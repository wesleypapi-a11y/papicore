/*
 * whatsappService.js (novo núcleo, sob services/whatsapp/)
 *
 * Mensagens automáticas de WhatsApp + conexão (QR Code) por empresa.
 *
 * Arquitetura (fluxo obrigatório):
 *   Controller → whatsappService → provider ativo (mock | evolution)
 *
 * O provider ativo NUNCA é decidido pelo controller:
 *   - WHATSAPP_PROVIDER=mock  (padrão) → sempre MOCK;
 *   - WHATSAPP_ENABLED=true + Evolution habilitada/configurada → evolution;
 *   - Qualquer outro caso → MOCK. A Evolution JAMAIS executa sem
 *     WHATSAPP_ENABLED=true.
 *
 * Fluxo de negócio: a operação (criar/confirmar/concluir agendamento) é SEMPRE
 * concluída primeiro; só depois a mensagem é gravada na outbox
 * (whatsapp_outbox) e processada em segundo plano. Falha no WhatsApp NUNCA
 * desfaz agendamento, confirmação, conclusão ou consumo de crédito.
 *
 * MOCK: mensagens são processadas como "Simulada" (status SIMULATED), sem
 * chamar nenhuma API externa e sem gerar erro ao usuário.
 *
 * Idempotência: cada evento é único por agendamento (ex.:
 * APPOINTMENT_COMPLETED:105). Se a mesma mensagem já existe
 * (PENDING/PROCESSING/SENT/SIMULATED), não é gravada de novo.
 */

'use strict';

const {
  getDb,
  openTenantDatabase,
  closeTenantDatabase,
  isOpenTenantDatabase
} = require('../../database/tenantDatabase');
const { WHATSAPP_DEFAULT_TEMPLATES } = require('../../database/tenantSchema');
const {
  getEvolutionSettings: coreGetEvolutionSettings,
  upsertEvolutionSettings,
  getEvolutionInstance,
  getEvolutionInstanceByDatabaseName,
  getEvolutionInstanceByInstanceName,
  upsertEvolutionInstance,
  deleteEvolutionInstance,
  getTenantById,
  listTenants,
  logActivity
} = require('../../database/coreDatabase');
const { LONG_SERVICE_THRESHOLD_MINUTES } = require('../durationService');
const packageService = require('../packageService');
const { formatMoney, formatPhone, normalizePhone } = require('../../utils/helpers');
const mockProvider = require('./providers/mockProvider');
const evolutionProvider = require('./providers/evolutionProvider');

const PROVIDER_MOCK = 'mock';
const PROVIDER_EVOLUTION = 'evolution';

/* ---------- Eventos ---------- */

const EVENTS = {
  REQUESTED_CLIENT: 'APPOINTMENT_REQUESTED_CLIENT',
  REQUESTED_CUSTOMER: 'APPOINTMENT_REQUESTED_CUSTOMER',
  REQUESTED_STORE: 'APPOINTMENT_REQUESTED_STORE',
  CONFIRMED: 'APPOINTMENT_CONFIRMED',
  CANCELLED: 'APPOINTMENT_CANCELLED',
  RESCHEDULED: 'APPOINTMENT_RESCHEDULED',
  COMPLETED: 'APPOINTMENT_COMPLETED',
  COMPLETED_PACKAGE: 'APPOINTMENT_COMPLETED_PACKAGE'
};

/* APPOINTMENT_REQUESTED_CLIENT é o nome exigido pela plataforma; o banco
   (e os templates seedados) usam APPOINTMENT_REQUESTED_CUSTOMER. Ambos são
   aceitos e resolvidos para o mesmo modelo. */
const EVENT_ALIASES = {
  [EVENTS.REQUESTED_CLIENT]: EVENTS.REQUESTED_CUSTOMER
};

function canonicalEventKey(eventKey) {
  return EVENT_ALIASES[eventKey] || eventKey;
}

const EVENT_LABELS = {
  [EVENTS.REQUESTED_CLIENT]: 'Novo agendamento (cliente)',
  [EVENTS.REQUESTED_CUSTOMER]: 'Novo agendamento (cliente)',
  [EVENTS.REQUESTED_STORE]: 'Novo agendamento (loja)',
  [EVENTS.CONFIRMED]: 'Confirmação',
  [EVENTS.CANCELLED]: 'Cancelamento',
  [EVENTS.RESCHEDULED]: 'Reagendamento',
  [EVENTS.COMPLETED]: 'Conclusão',
  [EVENTS.COMPLETED_PACKAGE]: 'Conclusão — pacote'
};

/* Lista fechada de placeholders permitidos nos modelos. Qualquer outro token
   {{...}} é rejeitado na validação. Alguns nomes são aliases (DATA ↔
   DATA_AGENDAMENTO, HORARIO ↔ HORARIO_AGENDAMENTO, SERVICOS ↔ lista,
   UNIDADE_NOME ↔ UNIDADE) aceitos para compatibilidade. */
const ALLOWED_PLACEHOLDERS = new Set([
  'EMPRESA_NOME',
  'CLIENTE_NOME',
  'CLIENTE_TELEFONE',
  'CODIGO_AGENDAMENTO',
  'DATA_AGENDAMENTO',
  'DATA',
  'HORARIO_AGENDAMENTO',
  'HORARIO',
  'DURACAO',
  'SERVICO',
  'SERVICOS',
  'VEICULO',
  'UNIDADE',
  'UNIDADE_NOME',
  'UNIDADE_ENDERECO',
  'MODALIDADE',
  'VALOR',
  'SALDO_PACOTE',
  'DATA_CONCLUSAO',
  'HORA_CONCLUSAO',
  'LINK_ADMIN'
]);

const OUTBOX_STATUSES = ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED', 'CANCELLED'];

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/* Ações de auditoria registradas no activity_logs do core. */
const LOG_ACTIONS = {
  SETTINGS_UPDATED: 'WHATSAPP_SETTINGS_UPDATED',
  INSTANCE_CREATED: 'WHATSAPP_INSTANCE_CREATED',
  CONNECTED: 'WHATSAPP_CONNECTED',
  DISCONNECTED: 'WHATSAPP_DISCONNECTED',
  QR_GENERATED: 'WHATSAPP_QR_GENERATED',
  MESSAGE_QUEUED: 'WHATSAPP_MESSAGE_QUEUED',
  MESSAGE_SIMULATED: 'WHATSAPP_MESSAGE_SIMULATED',
  MESSAGE_SENT: 'WHATSAPP_MESSAGE_SENT',
  MESSAGE_FAILED: 'WHATSAPP_MESSAGE_FAILED',
  TEMPLATE_UPDATED: 'WHATSAPP_TEMPLATE_UPDATED',
  WEBHOOK_RECEIVED: 'WHATSAPP_WEBHOOK_RECEIVED',
  ERROR: 'WHATSAPP_ERROR'
};

/* ---------- Configuração (lida dinamicamente para permitir testes) ---------- */

function isWhatsappEnabled() {
  return String(process.env.WHATSAPP_ENABLED || '').toLowerCase() === 'true';
}

function evolutionConfigured() {
  return evolutionProvider.isConfigured(evolutionProvider.getSettings());
}

function providerSetting() {
  return String(process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
}

function activeProviderName() {
  const forced = providerSetting();
  if (forced === PROVIDER_MOCK) return PROVIDER_MOCK;
  if (forced === PROVIDER_EVOLUTION) {
    return (isWhatsappEnabled() && evolutionProvider.getSettings().enabled) ? PROVIDER_EVOLUTION : PROVIDER_MOCK;
  }
  if (isWhatsappEnabled() && evolutionProvider.getSettings().enabled) return PROVIDER_EVOLUTION;
  return PROVIDER_MOCK;
}

function getProvider() {
  return activeProviderName() === PROVIDER_EVOLUTION ? evolutionProvider : mockProvider;
}

/* Compatibilidade: simulação sempre disponível; real só se a Evolution
   estiver habilitada e configurada. */
function isConfigured() {
  return activeProviderName() === PROVIDER_EVOLUTION ? evolutionConfigured() : true;
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

function dateTimeNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
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

/* Lista de serviços do agendamento (services_json) com fallback para
   service_name — usado no placeholder {{SERVICOS}}. */
function servicesList(a) {
  if (!a) return '';
  let names = [];
  try {
    const parsed = JSON.parse(a.services_json || '[]');
    if (Array.isArray(parsed)) {
      names = parsed
        .map((s) => (typeof s === 'string' ? s : (s && (s.name || s.service_name)) || ''))
        .filter(Boolean);
    }
  } catch { /* services_json corrompido não quebra a renderização */ }
  return names.join(', ') || a.service_name || '';
}

/* Endereço da unidade do agendamento — placeholder {{UNIDADE_ENDERECO}}. */
function unitAddress(a) {
  if (!a) return '';
  const db = getDb();
  let unit = null;
  if (a.unit_id) {
    try { unit = db.prepare('SELECT * FROM units WHERE id = ?').get(a.unit_id); } catch { /* ignora */ }
  }
  const street = unit && (unit.address_street || unit.address);
  const parts = [];
  if (street) parts.push(`${street}${unit.address_number ? `, ${unit.address_number}` : ''}`);
  if (unit && unit.address_neighborhood) parts.push(unit.address_neighborhood);
  if (unit && (unit.address_city || unit.address_state)) {
    parts.push([unit.address_city, unit.address_state].filter(Boolean).join(' - '));
  }
  if (parts.length) return parts.join(' — ');
  return a.unit_name || '';
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

/* Resumo de saldo do pacote PÓS-consumo, usado no evento
   APPOINTMENT_COMPLETED_PACKAGE. Deve ser chamado depois de
   consumeForAppointment para refletir o estado já atualizado. */
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

/* Resolve os valores de todos os placeholders para um evento/agendamento.
   Para APPOINTMENT_COMPLETED_PACKAGE, inclui o saldo do pacote já consumido. */
function resolvePlaceholders(eventKey, appointment, opts = {}) {
  const a = appointment || {};
  const company = opts.companyName || getCompanyName();
  const dateLabel = fmtDateBR(a.appointment_date);
  const timeLabelValue = timeLabel(a);
  const values = {
    EMPRESA_NOME: company,
    CLIENTE_NOME: a.customer_name || '',
    CLIENTE_TELEFONE: a.customer_phone || '',
    CODIGO_AGENDAMENTO: a.appointment_code || '',
    DATA_AGENDAMENTO: dateLabel,
    DATA: dateLabel,
    HORARIO_AGENDAMENTO: timeLabelValue,
    HORARIO: timeLabelValue,
    DURACAO: a.booked_duration_minutes ? fmtDuration(a.booked_duration_minutes) : '',
    SERVICO: a.service_name || '',
    SERVICOS: servicesList(a),
    VEICULO: vehicleDescription(a),
    UNIDADE: a.unit_name || '—',
    UNIDADE_NOME: a.unit_name || '—',
    UNIDADE_ENDERECO: opts.unitAddress || unitAddress(a),
    MODALIDADE: a.modality_name || '—',
    VALOR: formatMoney(Number(a.total_price)),
    SALDO_PACOTE: '',
    DATA_CONCLUSAO: opts.conclusionDate || dateNow(),
    HORA_CONCLUSAO: opts.conclusionTime || timeNow(),
    LINK_ADMIN: opts.linkAdmin || '/admin'
  };
  if (canonicalEventKey(eventKey) === EVENTS.COMPLETED_PACKAGE) {
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

/* ---------- Auditoria ---------- */

/* Grava log de auditoria no core com ação WHATSAPP_*. NUNCA recebe QR
   completo, API key nem token de webhook. */
function logWhatsapp(action, tenantId, details, userId) {
  let detail = '';
  if (typeof details === 'string') detail = details;
  else if (details && typeof details === 'object') {
    try { detail = JSON.stringify(details); } catch { detail = ''; }
  }
  try {
    logActivity(userId || null, tenantId || null, action, detail);
  } catch (err) {
    console.error(`[whatsapp] Falha ao registrar log ${action}:`, err.message);
  }
}

/* ---------- Outbox ---------- */

function idempotencyKey(eventKey, appointmentId) {
  return `${canonicalEventKey(eventKey)}:${appointmentId}`;
}

function outboxEnabled() {
  return String(process.env.WHATSAPP_OUTBOX_ENABLED || 'true').toLowerCase() !== 'false';
}

function outboxIntervalMs() {
  const n = Number(process.env.WHATSAPP_OUTBOX_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

function maxRetries() {
  const n = Number(process.env.WHATSAPP_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

/* Grava a mensagem na outbox (status PENDING) e agenda o processamento em
   segundo plano — depois da operação de negócio e antes da resposta da API.
   NÃO lança erro em falha de WhatsApp: retorna { skipped, reason }. */
function enqueueEvent(eventKey, appointment, opts = {}) {
  const db = getDb();
  if (!appointment || !appointment.id) {
    return { skipped: true, reason: 'invalid_appointment' };
  }
  const canonical = canonicalEventKey(eventKey);
  const template = db.prepare('SELECT * FROM whatsapp_message_templates WHERE event_key = ?').get(canonical);
  if (!template) return { skipped: true, reason: 'no_template' };
  if (!template.enabled) return { skipped: true, reason: 'disabled' };

  const recipientKind = canonical === EVENTS.REQUESTED_STORE ? 'store' : 'customer';
  let recipient;
  if (recipientKind === 'store') {
    recipient = opts.recipient || getStorePhone();
    if (!recipient) return { skipped: true, reason: 'no_store_phone' };
  } else {
    recipient = appointment.customer_phone;
    if (!recipient) return { skipped: true, reason: 'no_recipient' };
  }
  recipient = normalizePhone(recipient);

  const key = idempotencyKey(canonical, appointment.id);
  const existing = db.prepare('SELECT * FROM whatsapp_outbox WHERE idempotency_key = ?').get(key);

  /* Reenvio de um item que falhou: reaproveita a mesma linha. */
  if (existing) {
    if (existing.status !== 'FAILED') {
      return { skipped: true, reason: 'idempotent', id: existing.id };
    }
    const values = resolvePlaceholders(canonical, appointment, opts);
    const text = renderTemplate(template.content, values);
    db.prepare(
      `UPDATE whatsapp_outbox SET recipient = ?, recipient_kind = ?, payload_json = ?,
         message_text = ?, status = 'PENDING', attempts = 0, last_error = NULL,
         scheduled_at = datetime('now', 'localtime'), sent_at = NULL, processed_at = NULL
       WHERE id = ?`
    ).run(recipient, recipientKind, JSON.stringify(values), text, existing.id);
    scheduleProcessing(db);
    return { id: existing.id, skipped: false, reenqueued: true };
  }

  const values = resolvePlaceholders(canonical, appointment, opts);
  const text = renderTemplate(template.content, values);
  const info = db.prepare(
    `INSERT INTO whatsapp_outbox
       (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`
  ).run(canonical, recipient, recipientKind, JSON.stringify(values), text, key);
  logWhatsapp(LOG_ACTIONS.MESSAGE_QUEUED, null, { event_key: canonical, outbox_id: info.lastInsertRowid });
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

/* Registra no histórico imutável (whatsapp_message_history) quando a mensagem
   atinge um status final. */
function insertHistory(db, row, status, errorText) {
  try {
    db.prepare(
      `INSERT INTO whatsapp_message_history
         (outbox_id, event_key, recipient, recipient_kind, message_text, status, attempts, error, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id, row.event_key, row.recipient, row.recipient_kind,
      row.message_text, status, row.attempts, errorText || null,
      status === 'SENT' || status === 'SIMULATED' ? dateTimeNow() : null
    );
  } catch (err) {
    console.error('[whatsapp] Falha ao gravar histórico:', err.message);
  }
}

/*
 * Processa mensagens PENDING da outbox.
 *   - MOCK: marca como SIMULATED, sem chamar API externa e sem erro.
 *   - Evolution habilitada: envia de verdade; ok vira SENT, falha vira
 *     FAILED (a operação de negócio continua valendo) com retries até
 *     WHATSAPP_MAX_RETRIES.
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
  const providerName = activeProviderName();
  const instanceName = instanceNameFromDb(db);
  let outcome;
  let errorText = null;

  if (providerName === PROVIDER_MOCK) {
    await mockProvider.sendText(instanceName, row.recipient, row.message_text);
    outcome = 'SIMULATED';
    logWhatsapp(LOG_ACTIONS.MESSAGE_SIMULATED, null, { outbox_id: row.id, event_key: row.event_key });
  } else {
    if (!evolutionConfigured()) {
      outcome = 'FAILED';
      errorText = 'WhatsApp não configurado (Evolution API sem URL/chave).';
    } else {
      const result = await evolutionProvider.sendText(instanceName, row.recipient, row.message_text, evolutionProvider.getSettings());
      if (result.error) {
        outcome = 'FAILED';
        errorText = result.message || `Falha de envio (HTTP ${result.status}).`;
      } else {
        outcome = 'SENT';
        logWhatsapp(LOG_ACTIONS.MESSAGE_SENT, null, { outbox_id: row.id, event_key: row.event_key });
      }
    }
  }

  return finalizeOutboxRow(db, row, outcome, errorText);
}

/* Aplica o status final (ou reagenda com retry) e grava o histórico. */
function finalizeOutboxRow(db, row, outcome, errorText) {
  const attemptsMade = (row.attempts || 0) + 1;
  const max = maxRetries();

  if (outcome === 'FAILED') {
    if (attemptsMade < max) {
      /* Reagenda a tentativa seguinte sem liberar a operação de negócio. */
      db.prepare(
        "UPDATE whatsapp_outbox SET status = 'PENDING', last_error = ?, scheduled_at = datetime('now', 'localtime') WHERE id = ?"
      ).run(errorText || 'Falha de envio.', row.id);
      logWhatsapp(LOG_ACTIONS.MESSAGE_FAILED, null, { outbox_id: row.id, event_key: row.event_key, attempt: attemptsMade, retry: true, error: (errorText || '').slice(0, 200) });
      return 'FAILED';
    }
    db.prepare(
      "UPDATE whatsapp_outbox SET status = 'FAILED', last_error = ?, processed_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(errorText, row.id);
    insertHistory(db, row, 'FAILED', errorText);
    logWhatsapp(LOG_ACTIONS.MESSAGE_FAILED, null, { outbox_id: row.id, event_key: row.event_key, attempt: attemptsMade, error: (errorText || '').slice(0, 200) });
    return 'FAILED';
  }

  db.prepare(
    "UPDATE whatsapp_outbox SET status = ?, sent_at = datetime('now', 'localtime'), processed_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(outcome, row.id);
  insertHistory(db, row, outcome, null);
  return outcome;
}

/* Reenvio manual (admin): reseta a linha para PENDING e reprocessa. Só faz
   sentido para mensagens que falharam ou foram simuladas. */
function resendOutbox(db, id) {
  const row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(id);
  if (!row) return null;
  if (!['FAILED', 'SIMULATED'].includes(row.status)) return row;
  db.prepare(
    "UPDATE whatsapp_outbox SET status = 'PENDING', attempts = 0, last_error = NULL, sent_at = NULL, processed_at = NULL, scheduled_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(id);
  return { ...row, status: 'PENDING', attempts: 0, last_error: null, sent_at: null };
}

/* ---------- Envio direto (compatibilidade) ---------- */

async function sendTextMessage(to, text, instanceName) {
  const providerName = activeProviderName();
  if (providerName === PROVIDER_MOCK) {
    return { simulated: true, ok: true };
  }
  const settings = evolutionProvider.getSettings();
  if (!evolutionProvider.isConfigured(settings)) {
    return { skipped: true, reason: 'not_configured' };
  }
  return evolutionProvider.sendText(instanceName || evolutionProvider.DEFAULT_INSTANCE_NAME, to, text, settings);
}

/* ---------- Instâncias / conexão ---------- */

function instanceNameFromDatabaseName(databaseName) {
  const path = require('path');
  const base = String(databaseName || '').trim();
  if (!base) return evolutionProvider.DEFAULT_INSTANCE_NAME;
  const file = base.includes('\\') || base.includes('/') ? path.basename(base) : base;
  return file.replace(/\.[^.]*$/, '').toLowerCase() || evolutionProvider.DEFAULT_INSTANCE_NAME;
}

function instanceNameFromDb(db) {
  if (!db) return evolutionProvider.DEFAULT_INSTANCE_NAME;
  return instanceNameFromDatabaseName(db.name);
}

function safeInstance(instance) {
  if (!instance) return null;
  return {
    instance_name: instance.instance_name,
    status: instance.status,
    owner_number: instance.owner_number || '',
    owner_name: instance.owner_name || '',
    qr_base64: instance.qr_base64 || '',
    last_error: instance.last_error || ''
  };
}

/* Estado combinado para o painel do cliente/desenvolvedor. */
function connectionState(tenant) {
  const providerName = activeProviderName();
  const configured = evolutionConfigured();
  const instance = getEvolutionInstance(tenant.id);
  const status = instance && instance.status ? instance.status : 'disconnected';
  const out = {
    provider: providerName,
    mode: providerName === PROVIDER_MOCK ? 'simulation' : 'evolution',
    available: providerName === PROVIDER_EVOLUTION ? configured : true,
    settings_configured: configured,
    status,
    instance: safeInstance(instance)
  };
  if (status === 'connecting' && instance && instance.qr_base64) out.qr = instance.qr_base64;
  if (instance) {
    out.connected_at = instance.connected_at || '';
    out.last_connection = instance.last_connection || '';
    out.last_disconnect = instance.last_disconnect || '';
    out.last_qr_generated = instance.last_qr_generated || '';
    out.last_synced_at = instance.updated_at || '';
    out.webhook_token_set = Boolean(instance.webhook_token);
  }
  return out;
}

/* Gera o webhook_token da instância (usado na validação do webhook). */
function ensureWebhookToken(tenantId) {
  const existing = getEvolutionInstance(tenantId);
  if (existing && existing.webhook_token) return existing.webhook_token;
  const token = require('crypto').randomBytes(24).toString('hex');
  upsertEvolutionInstance(tenantId, { webhook_token: token });
  return token;
}

/*
 * Conecta uma empresa: em MOCK simula o QR; com Evolution cria a instância,
 * busca o QR Code e devolve ao front para exibição. O status fica
 * "connecting" até o usuário escanear.
 */
async function connect(tenant, { force = false } = {}) {
  const providerName = activeProviderName();
  const tenantId = tenant.id;
  const instanceName = instanceNameFromDatabaseName(tenant.database_name);

  if (providerName === PROVIDER_MOCK) {
    const current = getEvolutionInstance(tenantId);
    if (force && current) deleteEvolutionInstance(tenantId);
    const qr = await mockProvider.generateQRCode(instanceName);
    upsertEvolutionInstance(tenantId, {
      tenant_id: tenantId,
      database_name: tenant.database_name,
      instance_name: instanceName,
      status: 'connecting',
      qr_base64: qr.qr,
      last_error: null,
      last_qr_generated: dateTimeNow()
    });
    ensureWebhookToken(tenantId);
    logWhatsapp(LOG_ACTIONS.QR_GENERATED, tenantId, { instance_name: instanceName, mock: true });
    return { ok: true, status: 'connecting', qr: qr.qr, mock: true };
  }

  const settings = evolutionProvider.getSettings();
  if (!evolutionProvider.isConfigured(settings)) {
    return { error: true, code: 'evolution_not_configured', message: 'Evolution API ainda não está configurada no painel do desenvolvedor.' };
  }

  const current = getEvolutionInstance(tenantId);
  if (force && current) {
    try { await evolutionProvider.disconnect(current.instance_name, settings); } catch { /* ignora */ }
    deleteEvolutionInstance(tenantId);
  }

  if (!current || force) {
    const created = await evolutionProvider.createInstance(instanceName, settings);
    if (created.error) {
      logWhatsapp(LOG_ACTIONS.ERROR, tenantId, `Falha ao criar instância: ${created.message}`);
      return { error: true, message: `Não foi possível criar a instância: ${created.message}` };
    }
    logWhatsapp(LOG_ACTIONS.INSTANCE_CREATED, tenantId, { instance_name: instanceName });
  }

  upsertEvolutionInstance(tenantId, {
    tenant_id: tenantId,
    database_name: tenant.database_name,
    instance_name: instanceName,
    status: 'connecting',
    qr_base64: '',
    last_error: null
  });

  const qr = await evolutionProvider.generateQRCode(instanceName, settings);
  if (qr.error) {
    upsertEvolutionInstance(tenantId, { status: 'error', last_error: qr.message });
    logWhatsapp(LOG_ACTIONS.ERROR, tenantId, `Falha ao obter QR: ${qr.message}`);
    return { error: true, message: `Não foi possível obter o QR Code: ${qr.message}` };
  }

  upsertEvolutionInstance(tenantId, {
    status: 'connecting',
    qr_base64: qr.qr,
    last_error: null,
    last_qr_generated: dateTimeNow()
  });
  ensureWebhookToken(tenantId);
  logWhatsapp(LOG_ACTIONS.QR_GENERATED, tenantId, { instance_name: instanceName });
  return { ok: true, status: 'connecting', qr: qr.qr };
}

async function reconnect(tenant) {
  return connect(tenant, { force: true });
}

async function disconnect(tenant) {
  const providerName = activeProviderName();
  const tenantId = tenant.id;
  const current = getEvolutionInstance(tenantId);
  if (providerName === PROVIDER_EVOLUTION && current && evolutionConfigured()) {
    try { await evolutionProvider.disconnect(current.instance_name, evolutionProvider.getSettings()); } catch { /* ignora */ }
  }
  if (current) {
    upsertEvolutionInstance(tenantId, { status: 'disconnected', qr_base64: '', last_disconnect: dateTimeNow() });
  } else {
    deleteEvolutionInstance(tenantId);
  }
  logWhatsapp(LOG_ACTIONS.DISCONNECTED, tenantId, { instance_name: current && current.instance_name });
  return { ok: true, status: 'disconnected' };
}

/* Atualiza o status local a partir do provider. Não lança erro: em falha de
   rede mantém o último status conhecido. */
async function refreshStatus(tenant) {
  const providerName = activeProviderName();
  const instance = getEvolutionInstance(tenant.id);
  if (!instance) return { ok: true, status: 'disconnected' };

  if (providerName === PROVIDER_MOCK) {
    const st = await mockProvider.syncStatus(instance.instance_name);
    const status = st.connected ? 'connected' : (st.status === 'connecting' ? 'connecting' : 'disconnected');
    if (status === 'connected') {
      upsertEvolutionInstance(tenant.id, {
        status: 'connected',
        qr_base64: '',
        last_error: null,
        connected_at: instance.connected_at || dateTimeNow(),
        last_connection: dateTimeNow()
      });
      logWhatsapp(LOG_ACTIONS.CONNECTED, tenant.id, { instance_name: instance.instance_name, mock: true });
    }
    return { ok: true, status };
  }

  if (!evolutionConfigured()) return { ok: true, status: instance.status };
  try {
    const remote = await evolutionProvider.getState(instance.instance_name, evolutionProvider.getSettings());
    if (remote.ok) {
      if (remote.connected) {
        upsertEvolutionInstance(tenant.id, {
          status: 'connected',
          owner_number: remote.owner_number,
          owner_name: remote.owner_name,
          qr_base64: '',
          last_error: null,
          connected_at: instance.connected_at || dateTimeNow(),
          last_connection: dateTimeNow()
        });
        logWhatsapp(LOG_ACTIONS.CONNECTED, tenant.id, { instance_name: instance.instance_name });
      } else {
        upsertEvolutionInstance(tenant.id, { status: 'disconnected', qr_base64: '' });
      }
      return { ok: true, status: remote.connected ? 'connected' : 'disconnected' };
    }
  } catch (err) {
    console.error(`[evolution] Falha ao consultar status de ${instance.instance_name}:`, err.message);
  }
  return { ok: true, status: instance.status };
}

async function testConnection(settingsOverride) {
  return evolutionProvider.testConnection(settingsOverride);
}

/* ---------- Configurações globais (Evolution) ---------- */

function getWhatsappSettings() {
  const s = evolutionProvider.getSettings();
  return { enabled: s.enabled, server_url: s.server_url, api_key: s.api_key };
}

function updateWhatsappSettings({ enabled, server_url, api_key }) {
  return upsertEvolutionSettings({ enabled, server_url, api_key });
}

/* Alias de compatibilidade (painel do desenvolvedor / testes legados). */
function getEvolutionSettings() {
  return coreGetEvolutionSettings();
}

/* ---------- Painel do desenvolvedor ---------- */

function listInstancesOverview() {
  const tenants = listTenants();
  return tenants.map((t) => {
    const instance = getEvolutionInstance(t.id);
    return {
      tenant_id: t.id,
      name: t.name,
      slug: t.slug,
      database_name: t.database_name,
      status: instance ? instance.status : 'disconnected',
      instance_name: instance ? instance.instance_name : instanceNameFromDatabaseName(t.database_name),
      owner_number: instance ? instance.owner_number || '' : '',
      qr_base64: instance && instance.status === 'connecting' ? instance.qr_base64 || '' : '',
      last_error: instance ? instance.last_error || '' : '',
      connected_at: instance ? instance.connected_at || '' : '',
      last_connection: instance ? instance.last_connection || '' : '',
      last_disconnect: instance ? instance.last_disconnect || '' : '',
      last_qr_generated: instance ? instance.last_qr_generated || '' : '',
      last_synced_at: instance ? instance.updated_at || '' : ''
    };
  });
}

/* Resumo por empresa para o painel do desenvolvedor. */
function overview() {
  const settings = evolutionProvider.getSettings();
  const providerName = activeProviderName();
  return {
    provider: providerName,
    enabled: settings.enabled,
    configured: evolutionConfigured(),
    server_url: settings.server_url,
    api_key_defined: Boolean(settings.api_key),
    whatsapp_enabled: isWhatsappEnabled(),
    active_provider: providerName,
    instances: listInstancesOverview()
  };
}

/* ---------- Webhook ---------- */

function webhookTokenFrom(payload, headers) {
  const body = payload && typeof payload === 'object' ? payload : {};
  return String(
    body.webhook_token ||
    body.secret ||
    (headers && (headers['x-evolution-secret'] || headers['x-webhook-token'])) ||
    ''
  ).trim();
}

/*
 * Trata o webhook da Evolution: valida token, identifica instância → tenant,
 * atualiza status, registra log e responde rápido. NUNCA loga QR completo,
 * API key nem token.
 */
async function handleWebhook(payload, headers = {}) {
  const received = await getProvider().receiveWebhook(payload);

  const instance = getEvolutionInstanceByInstanceName(received.instanceName);
  if (!instance) {
    return { status: 404, error: 'Instância não encontrada.' };
  }

  const expected = instance.webhook_token || String(process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim();
  const token = webhookTokenFrom(payload, headers);
  if (!expected || !token || token !== expected) {
    logWhatsapp(LOG_ACTIONS.WEBHOOK_RECEIVED, instance.tenant_id, { event: received.event, rejected: 'invalid_token' });
    return { status: 401, error: 'Token inválido.' };
  }

  logWhatsapp(LOG_ACTIONS.WEBHOOK_RECEIVED, instance.tenant_id, { event: received.event, instance_name: instance.instance_name });

  const tenantId = instance.tenant_id;
  switch (received.event) {
    case 'connection.update':
      if (received.connected) {
        upsertEvolutionInstance(tenantId, {
          status: 'connected',
          qr_base64: '',
          last_error: null,
          connected_at: instance.connected_at || dateTimeNow(),
          last_connection: dateTimeNow()
        });
        logWhatsapp(LOG_ACTIONS.CONNECTED, tenantId, { instance_name: instance.instance_name });
      } else {
        upsertEvolutionInstance(tenantId, { status: 'disconnected', qr_base64: '', last_disconnect: dateTimeNow() });
        logWhatsapp(LOG_ACTIONS.DISCONNECTED, tenantId, { instance_name: instance.instance_name });
      }
      break;
    case 'qrcode.updated':
      {
        const qr = payload && payload.data && payload.data.base64;
        if (qr) {
          upsertEvolutionInstance(tenantId, { status: 'connecting', qr_base64: qr, last_qr_generated: dateTimeNow() });
          logWhatsapp(LOG_ACTIONS.QR_GENERATED, tenantId, { instance_name: instance.instance_name });
        }
      }
      break;
    case 'logout':
      upsertEvolutionInstance(tenantId, { status: 'disconnected', qr_base64: '', last_disconnect: dateTimeNow() });
      logWhatsapp(LOG_ACTIONS.DISCONNECTED, tenantId, { instance_name: instance.instance_name });
      break;
    /* messages.upsert, send.message e send.update: apenas auditados por ora.
       NÃO há auto-resposta nem campanhas em massa nesta versão. */
    default:
      break;
  }

  return { received: true, status: 200, event: received.event };
}

/* ---------- Worker da outbox ---------- */

let workerTimer = null;
let workerRunning = false;

/* Processa a outbox de TODAS as empresas em segundo plano (safety net). O
   processamento imediato continua sendo agendado por enqueueEvent. */
async function processAllTenantsOutbox() {
  const tenants = listTenants();
  for (const t of tenants) {
    if (!t.database_name || t.status === 'SUSPENDED') continue;
    /* Só fecha o banco se o worker o abriu agora — nunca derruba uma conexão
       que já estava em uso por outra requisição (padrão do projeto). */
    const wasOpen = isOpenTenantDatabase(t.database_name);
    let tenantDb;
    try {
      tenantDb = openTenantDatabase(t.database_name);
      await processOutbox({ db: tenantDb, limit: 25 });
    } catch (err) {
      console.error(`[whatsapp] worker falhou para ${t.database_name}:`, err.message);
    } finally {
      if (tenantDb && !wasOpen) closeTenantDatabase(t.database_name);
    }
  }
}

function startWorker() {
  if (workerTimer || !outboxEnabled()) return;
  workerTimer = setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    processAllTenantsOutbox()
      .catch((err) => console.error('[whatsapp] worker da outbox:', err && err.message))
      .finally(() => { workerRunning = false; });
  }, outboxIntervalMs());
  if (workerTimer.unref) workerTimer.unref();
}

function stopWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

/* ---------- Status ---------- */

function getStatus() {
  const providerName = activeProviderName();
  const settings = evolutionProvider.getSettings();
  const configured = evolutionProvider.isConfigured(settings);
  return {
    provider: providerName,
    enabled: isWhatsappEnabled() && settings.enabled,
    configured: providerName === PROVIDER_EVOLUTION ? configured : false,
    mock: providerName === PROVIDER_MOCK,
    evolution: {
      enabled: settings.enabled,
      configured,
      server_url: settings.server_url
    }
  };
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

module.exports = {
  /* constantes */
  EVENTS,
  EVENT_LABELS,
  EVENT_ALIASES,
  ALLOWED_PLACEHOLDERS,
  OUTBOX_STATUSES,
  DEFAULT_TEMPLATES: WHATSAPP_DEFAULT_TEMPLATES,
  LOG_ACTIONS,
  /* config */
  isWhatsappEnabled,
  isConfigured,
  getProvider,
  activeProviderName,
  getStatus,
  /* placeholders / template */
  validateTemplateContent,
  resolvePlaceholders,
  renderTemplate,
  /* outbox */
  enqueueEvent,
  processOutbox,
  processOne,
  resendOutbox,
  insertHistory,
  sendTextMessage,
  maxRetries,
  /* notificações (compat) */
  notifyAppointmentConfirmed,
  notifyStoreNewAppointment,
  buildConfirmationMessage,
  buildStoreNotificationMessage,
  /* conexão */
  instanceNameFromDatabaseName,
  instanceNameFromDb,
  connectionState,
  connect,
  reconnect,
  disconnect,
  refreshStatus,
  testConnection,
  ensureWebhookToken,
  /* settings */
  getWhatsappSettings,
  updateWhatsappSettings,
  getEvolutionSettings,
  /* painel do desenvolvedor */
  overview,
  listInstancesOverview,
  /* webhook */
  handleWebhook,
  /* worker */
  startWorker,
  stopWorker,
  processAllTenantsOutbox,
  outboxEnabled,
  outboxIntervalMs,
  /* auditoria */
  logWhatsapp,
  /* utils */
  formatPhone,
  normalizePhone,
  /* providers (informação — nada de chamadas diretas do controller) */
  PROVIDER_MOCK,
  PROVIDER_EVOLUTION
};
