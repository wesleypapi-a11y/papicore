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

/* Instâncias reservadas da PapiCore: nunca são criadas, alteradas ou excluídas
   pelo fluxo de tenant. A instância central de suporte vive só na Evolution e
   não pode ser vinculada a nenhuma empresa. */
const RESERVED_INSTANCE_NAMES = new Set(['papicore_support', 'papicore-central', 'papicore-support']);

function isReservedInstanceName(name) {
  return RESERVED_INSTANCE_NAMES.has(String(name || '').trim().toLowerCase());
}

/* QR Code perde validade após este tempo — o usuário precisa de um novo.
   Sobrescrevível por WHATSAPP_QR_TTL_MS. */
function qrTtlMs() {
  const n = Number(process.env.WHATSAPP_QR_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 120000;
}

/* Converte o timestamp gravado do QR (formato local "YYYY-MM-DD HH:mm:ss"
   gerado por dateTimeNow, ou ISO com offset) em ms absolutos. O ISO local sem
   offset é interpretado como hora local — o mesmo relógio que o gravou — e o
   ISO com offset (Z/+HH:MM) é interpretado em UTC: em ambos os casos o valor
   é coerente com Date.now(), então NUNCA expira por diferença de timezone. */
function qrTimestampMs(timestamp) {
  const s = String(timestamp || '').trim();
  if (!s) return NaN;
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function qrExpired(timestamp) {
  const t = qrTimestampMs(timestamp);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > qrTtlMs();
}

/* Momento de expiração (UTC ISO) do QR gerado em "timestamp". Compartilhado
   com o front para a contagem regressiva e calculado a partir do mesmo TTL da
   validação — a tela nunca marca expirado antes do backend. */
function qrExpiresAt(timestamp) {
  const t = qrTimestampMs(timestamp);
  if (Number.isNaN(t)) return null;
  return new Date(t + qrTtlMs()).toISOString();
}

/* ---------- Eventos ---------- */

const EVENTS = {
  REQUESTED_CLIENT: 'APPOINTMENT_REQUESTED_CLIENT',
  REQUESTED_CUSTOMER: 'APPOINTMENT_REQUESTED_CUSTOMER',
  REQUESTED_STORE: 'APPOINTMENT_REQUESTED_STORE',
  CONFIRMED: 'APPOINTMENT_CONFIRMED',
  CANCELLED: 'APPOINTMENT_CANCELLED',
  RESCHEDULED: 'APPOINTMENT_RESCHEDULED',
  COMPLETED: 'APPOINTMENT_COMPLETED',
  COMPLETED_PACKAGE: 'APPOINTMENT_COMPLETED_PACKAGE',
  PACKAGE_CREDIT_USED: 'PACKAGE_CREDIT_USED'
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
  [EVENTS.COMPLETED_PACKAGE]: 'Conclusão — pacote',
  [EVENTS.PACKAGE_CREDIT_USED]: 'Créditos de pacote utilizados'
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
  'CREDITOS_USADOS',
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
  WEBHOOK_CONFIGURED: 'WHATSAPP_WEBHOOK_CONFIGURED',
  INSTANCE_DELETED: 'WHATSAPP_INSTANCE_DELETED',
  INSTANCE_ASSOCIATED: 'WHATSAPP_INSTANCE_ASSOCIATED',
  RECONCILED: 'WHATSAPP_RECONCILED',
  ERROR: 'WHATSAPP_ERROR'
};

/* Lock por instância (PASSO 4): impede cliques simultâneos de dispararem
   vários create/QR em paralelo para a mesma instância. A segunda requisição
   aguarda a operação em andamento e reutiliza o resultado dela. */
const connectLocks = new Map();

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
  const lines = cp.balances.map((b) => `• ${b.service_name}: ${b.available} crédito${b.available === 1 ? '' : 's'}`);
  return lines.join('\n');
}

function creditsUsedBlock(a) {
  if (!a || !a.id) return '';
  const db = getDb();
  return db.prepare(`SELECT b.service_name_snapshot AS name, SUM(pt.quantity) AS quantity
    FROM package_transactions pt JOIN customer_package_balances b ON b.id=pt.balance_id
    WHERE pt.appointment_id=? AND pt.transaction_type='CONSUME'
    GROUP BY b.service_name_snapshot ORDER BY b.id`).all(a.id)
    .map((row) => `• ${row.name}: ${row.quantity} crédito${Number(row.quantity) === 1 ? '' : 's'}`).join('\n');
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
    CREDITOS_USADOS: '',
    DATA_CONCLUSAO: opts.conclusionDate || dateNow(),
    HORA_CONCLUSAO: opts.conclusionTime || timeNow(),
    LINK_ADMIN: opts.linkAdmin || '/admin'
  };
  if ([EVENTS.COMPLETED_PACKAGE, EVENTS.PACKAGE_CREDIT_USED].includes(canonicalEventKey(eventKey))) {
    values.SALDO_PACOTE = packageBalanceBlock(a);
    values.CREDITOS_USADOS = creditsUsedBlock(a);
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
  const rows = db.prepare(
    "SELECT * FROM whatsapp_outbox WHERE status = ? AND scheduled_at <= datetime('now', 'localtime') ORDER BY id ASC LIMIT ?"
  ).all('PENDING', limit);
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
      const registered = getEvolutionInstanceByInstanceName(instanceName);
      if (!registered) {
        outcome = 'FAILED';
        errorText = 'A instância WhatsApp do tenant não está cadastrada.';
      } else {
        /* Verifica a instância de verdade na Evolution antes de enviar: o
           status local pode estar "connected" por herança do modo MOCK ou de
           webhook antigo, mas a instância pode não existir mais no servidor.
           Nunca envia para um "nome fantasma". */
        const settings = evolutionProvider.getSettings();
        let remote;
        try {
          remote = await evolutionProvider.getState(instanceName, settings);
        } catch (err) {
          remote = { ok: false, status: 0, message: err.message };
        }

        const instanceMissing = !remote.ok &&
          (remote.status === 404 || /does not exist|not found|not_found/i.test(remote.message || ''));
        if (instanceMissing) {
          upsertEvolutionInstance(registered.tenant_id, { status: 'missing_remote', qr_base64: '', last_error: `Instância "${instanceName}" não encontrada na Evolution.` });
          outcome = 'FAILED';
          errorText = `A instância "${instanceName}" não existe na Evolution. Reconecte o WhatsApp da empresa para recriá-la.`;
        } else if (!remote.ok) {
          outcome = 'FAILED';
          errorText = `Não foi possível verificar a instância na Evolution (HTTP ${remote.status || 'erro'}).`;
        } else if (!remote.connected) {
          outcome = 'FAILED';
          errorText = 'A instância WhatsApp do tenant não está conectada na Evolution (estado: ' + (remote.status || 'unknown') + ').';
        } else {
          upsertEvolutionInstance(registered.tenant_id, {
            status: 'connected',
            owner_number: remote.owner_number || registered.owner_number,
            last_connection: dateTimeNow()
          });
          const result = await evolutionProvider.sendText(instanceName, row.recipient, row.message_text, settings);
          if (result.error || result.skipped) {
            outcome = 'FAILED';
            errorText = result.message || result.reason || `Falha de envio (HTTP ${result.status}).`;
          } else {
            outcome = 'SENT';
            logWhatsapp(LOG_ACTIONS.MESSAGE_SENT, registered.tenant_id, { outbox_id: row.id, event_key: row.event_key, provider_message_id: result.id || '' });
          }
        }
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
      const delaySeconds = Math.min(300, Math.pow(2, Math.max(0, attemptsMade - 1)) * 5);
      db.prepare(
        "UPDATE whatsapp_outbox SET status = 'PENDING', last_error = ?, scheduled_at = datetime('now', 'localtime', '+' || ? || ' seconds') WHERE id = ?"
      ).run(errorText || 'Falha de envio.', delaySeconds, row.id);
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

/* Estado combinado para o painel do cliente/desenvolvedor. Quando há QR
   válido salvo (não expirado) ele é devolvido no contrato normalizado
   (qrType/qrCode/pairingCode/expiresAt) para a tela exibir direto — sem
   depender de "recarregar a página". */
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
  if (status === 'connecting' && instance && instance.qr_base64) {
    const qrCode = evolutionProvider.ensureDataUri(instance.qr_base64);
    if (qrExpired(instance.last_qr_generated)) {
      out.qr_expired = true;
    } else {
      out.qr = qrCode;
      out.qrType = 'image';
      out.qrCode = qrCode;
      out.pairingCode = null;
      out.expiresAt = qrExpiresAt(instance.last_qr_generated);
    }
  }
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
 * Conecta uma empresa: em MOCK simula o QR; com Evolution cria a instância
 * (apenas se ainda não existir), busca o QR Code e devolve ao front para
 * exibição. O status fica "connecting" até o usuário escanear.
 *
 * No reconnect (force=true) a instância NÃO é recriada: ela é deslogada na
 * Evolution (novo pareamento) e o QR é regenerado na instância existente.
 * Antes era feito logout + delete local + createInstance — o create falhava
 * com 400 ("instance already exists") quando a instância ainda existia no
 * servidor, e o controller devolvia 502.
 */
async function connect(tenant, { force = false } = {}) {
  const providerName = activeProviderName();
  const tenantId = tenant.id;
  const instanceName = instanceNameFromDatabaseName(tenant.database_name);

  if (isReservedInstanceName(instanceName)) {
    return { error: true, code: 'reserved_instance', message: 'O nome desta instância é reservado para a PapiCore e não pode ser usado por uma empresa.' };
  }

  if (providerName === PROVIDER_MOCK) {
    const current = getEvolutionInstance(tenantId);
    if (force && current) deleteEvolutionInstance(tenantId);
    const qr = await mockProvider.generateQRCode(instanceName);
    const generatedAt = dateTimeNow();
    upsertEvolutionInstance(tenantId, {
      tenant_id: tenantId,
      database_name: tenant.database_name,
      instance_name: instanceName,
      status: 'connecting',
      qr_base64: qr.qr,
      last_error: null,
      last_qr_generated: generatedAt
    });
    ensureWebhookToken(tenantId);
    logWhatsapp(LOG_ACTIONS.QR_GENERATED, tenantId, { instance_name: instanceName, mock: true });
    return {
      ok: true,
      success: true,
      status: 'qr_pending',
      qrType: 'image',
      qrCode: qr.qr || null,
      pairingCode: null,
      expiresAt: qrExpiresAt(generatedAt),
      mock: true
    };
  }

  const settings = evolutionProvider.getSettings();
  if (!evolutionProvider.isConfigured(settings)) {
    return { error: true, code: 'evolution_not_configured', message: 'Evolution API ainda não está configurada no painel do desenvolvedor.' };
  }

  /* PASSO 4 — concorrência: se já existe uma conexão em andamento para esta
     instância, reutiliza o resultado dela em vez de iniciar outra operação. */
  const inflight = connectLocks.get(instanceName);
  if (inflight) {
    try {
      const reused = await inflight;
      return reused;
    } catch (err) {
      /* operação anterior falhou com exceção: segue e tenta de novo */
    }
  }

  const promise = (async () => {
    /* Falha de rede/timeout com a Evolution vira erro tratado (e logado), nunca
       exceção crua que derruba a requisição em 500 sem mensagem amigável. */
    const outcome = await connectEvolution(tenant, { force, instanceName, settings });
    if (outcome.error) {
      console.error(`[whatsapp] Falha ao conectar "${instanceName}" (${outcome.code || 'erro'}): ${outcome.message}`);
      logWhatsapp(LOG_ACTIONS.ERROR, tenantId, `${outcome.code || 'erro'}: ${outcome.message}`);
    }
    return outcome;
  })();

  connectLocks.set(instanceName, promise);
  try {
    return await promise;
  } catch (err) {
    console.error(`[whatsapp] Falha de comunicação ao conectar "${instanceName}":`, err && err.message);
    logWhatsapp(LOG_ACTIONS.ERROR, tenantId, `evolution_unreachable: ${(err && err.message) || String(err)}`);
    try {
      upsertEvolutionInstance(tenantId, { status: 'error', qr_base64: '', last_error: 'Não foi possível falar com a Evolution. Verifique se o servidor da Evolution está online.' });
    } catch { /* auditoria não pode quebrar a resposta */ }
    return { error: true, code: 'evolution_unreachable', message: 'Não foi possível falar com a Evolution. Verifique se o servidor da Evolution está online.' };
  } finally {
    if (connectLocks.get(instanceName) === promise) connectLocks.delete(instanceName);
  }
}

/* Consulta a existência real da instância na Evolution (connectionState).
   Retorna { exists: true|false|null } — null significa "não foi possível
   confirmar" (falha de rede), caso em que NÃO se deve criar cegamente. */
async function remoteInstanceState(instanceName, settings) {
  try {
    const state = await evolutionProvider.getState(instanceName, settings);
    if (state.ok) return { exists: true, state };
    const missing = state.status === 404 ||
      /does not exist|not found|not_found|não encontr/i.test(state.message || '');
    return { exists: missing ? false : true, state };
  } catch (err) {
    return { exists: null, error: err.message };
  }
}

/* Fluxo real da Evolution (separado para o try/catch de comunicação).
   Idempotente (PASSO 2):
     1. verifica a existência real da instância;
     2. cria SOMENTE se confirmado que não existe;
     3. "name already in use" vira reconsulta → reutiliza a existente;
     4. configura o webhook;
     5. consulta connectionState → se open, conectado sem QR;
     6. senão solicita o QR e sincroniza o banco local. */
async function connectEvolution(tenant, { force, instanceName, settings }) {
  const tenantId = tenant.id;
  let current = getEvolutionInstance(tenantId);

  /* Desconecta o aparelho na Evolution para forçar novo QR — sem excluir a
     instância. Se ela não existir, o erro é ignorado (best-effort). */
  if (force && current) {
    try { await evolutionProvider.disconnect(current.instance_name, settings); } catch { /* best-effort */ }
  }

  /* 1. Existe de verdade na Evolution? */
  let probe = await remoteInstanceState(instanceName, settings);

  /* 2. Cria somente se confirmado que não existe. */
  if (probe.exists === false) {
    const created = await evolutionProvider.createInstance(instanceName, settings);
    if (created.error && !created.already_exists) {
      /* Falha real — mas pode ter havido corrida (outro pedido criou entre a
         consulta e o create). Reconsulta antes de desistir. */
      const recheck = await remoteInstanceState(instanceName, settings);
      if (recheck.exists === true) {
        current = getEvolutionInstance(tenantId);
        probe = recheck;
      } else {
        upsertEvolutionInstance(tenantId, { status: 'error', last_error: created.message });
        return {
          error: true,
          code: created.code === 'name_in_use' ? 'instance_name_conflict' : 'instance_create_failed',
          message: created.code === 'name_in_use'
            ? `O nome "${instanceName}" já está em uso na Evolution, mas a instância não pôde ser verificada para reutilização.`
            : `Não foi possível criar a instância: ${created.message}`
        };
      }
    } else if (created.error && created.already_exists) {
      /* "name already in use" (PASSO 2.4): não devolve erro — reconsulta a
         existente e reutiliza. Só falha se continuar inacessível. */
      const recheck = await remoteInstanceState(instanceName, settings);
      if (recheck.exists !== true) {
        upsertEvolutionInstance(tenantId, { status: 'error', last_error: created.message });
        return {
          error: true,
          code: 'instance_name_conflict',
          message: `O nome "${instanceName}" já está em uso na Evolution, mas a instância não pôde ser verificada para reutilização.`
        };
      }
      current = getEvolutionInstance(tenantId);
      probe = recheck;
    } else {
      logWhatsapp(LOG_ACTIONS.INSTANCE_CREATED, tenantId, { instance_name: instanceName });
      current = getEvolutionInstance(tenantId);
    }
  }

  /* 3. Sincroniza o registro local (criado ou atualizado). */
  upsertEvolutionInstance(tenantId, {
    tenant_id: tenantId,
    database_name: tenant.database_name,
    instance_name: instanceName,
    status: 'connecting',
    qr_base64: '',
    last_error: null
  });

  /* 4. Configura o webhook. */
  const webhookToken = ensureWebhookToken(tenantId);
  const publicUrl = String(process.env.PAPICORE_PUBLIC_URL || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(publicUrl)) {
    upsertEvolutionInstance(tenantId, { status: 'error', last_error: 'PAPICORE_PUBLIC_URL HTTPS não configurada.' });
    return { error: true, code: 'public_url_missing', message: 'Configure PAPICORE_PUBLIC_URL com a URL HTTPS pública antes de conectar.' };
  }
  const webhook = await evolutionProvider.setWebhook(instanceName, {
    url: `${publicUrl}/api/webhooks/whatsapp`,
    headers: { 'x-webhook-token': webhookToken }
  }, settings);
  if (webhook.error) {
    upsertEvolutionInstance(tenantId, { status: 'error', last_error: webhook.message });
    return { error: true, code: 'webhook_failed', message: `A instância foi criada, mas o webhook não pôde ser configurado: ${webhook.message}` };
  }

  /* 5. Estado real: se já estiver open, retorna conectado sem gerar QR. */
  const state = await remoteInstanceState(instanceName, settings);
  if (state.exists === true && state.state && state.state.connected) {
    const existing = getEvolutionInstance(tenantId);
    upsertEvolutionInstance(tenantId, {
      status: 'connected',
      qr_base64: '',
      last_error: null,
      connected_at: (existing && existing.connected_at) || dateTimeNow(),
      last_connection: dateTimeNow()
    });
    logWhatsapp(LOG_ACTIONS.CONNECTED, tenantId, { instance_name: instanceName });
    return { ok: true, status: 'connected', message: 'A instância já está conectada na Evolution.' };
  }

  /* 6. Solicita o QR Code. */
  const qr = await evolutionProvider.generateQRCode(instanceName, settings);
  if (qr.error) {
    upsertEvolutionInstance(tenantId, { status: 'error', last_error: qr.message });
    return { error: true, code: qr.errorCode === 'qr_missing' ? 'qr_missing' : 'qr_failed', message: qr.message };
  }

  /* Instância conectou enquanto gerávamos o QR (state open sem base64):
     não deixa o painel preso em "Gerando QR Code…". */
  if (!qr.qr && qr.state === 'open') {
    const existing = getEvolutionInstance(tenantId);
    upsertEvolutionInstance(tenantId, {
      status: 'connected',
      qr_base64: '',
      last_error: null,
      connected_at: (existing && existing.connected_at) || dateTimeNow(),
      last_connection: dateTimeNow()
    });
    logWhatsapp(LOG_ACTIONS.CONNECTED, tenantId, { instance_name: instanceName });
    return { ok: true, status: 'connected', message: 'A instância já está conectada na Evolution.' };
  }

  /* Sem QR e sem estado "open": não existe QR para exibir — erro controlado
     (o front mostra "A Evolution respondeu, mas não forneceu um QR Code"). */
  if (!qr.qr && !qr.pairingCode && !qr.code) {
    upsertEvolutionInstance(tenantId, {
      status: 'error',
      last_error: 'A Evolution respondeu, mas não forneceu um QR Code. Tente gerar novamente.'
    });
    return { error: true, code: 'qr_missing', message: 'A Evolution respondeu, mas não forneceu um QR Code. Tente gerar novamente.' };
  }

  const generatedAt = dateTimeNow();
  upsertEvolutionInstance(tenantId, {
    status: 'connecting',
    qr_base64: qr.qrType === 'image' ? (qr.qr || null) : null,
    last_error: null,
    last_qr_generated: generatedAt
  });
  logWhatsapp(LOG_ACTIONS.QR_GENERATED, tenantId, { instance_name: instanceName });
  return {
    ok: true,
    success: true,
    status: 'qr_pending',
    qrType: qr.qrType || 'image',
    qrCode: qr.qr || null,
    pairingCode: qr.pairingCode || null,
    expiresAt: qr.expiresAt || qrExpiresAt(generatedAt),
    message: qr.qrType === 'pairing_code' || qr.qrType === 'text'
      ? 'Use o código de pareamento abaixo para conectar.'
      : 'QR Code gerado. Escaneie com o WhatsApp.'
  };
}

async function reconnect(tenant) {
  return connect(tenant, { force: true });
}

/* Mensagem amigável para o painel a partir do código de erro retornado pelo
   connect/disconnect. O detalhe técnico fica nos logs do servidor. */
function friendlyErrorMessage(result) {
  const messages = {
    evolution_not_configured: 'A Evolution ainda não está configurada no painel do desenvolvedor.',
    evolution_unreachable: 'A Evolution está indisponível. Verifique se o servidor da Evolution está online e tente novamente.',
    instance_create_failed: 'A instância ainda não existe na Evolution e não foi possível criá-la automaticamente.',
    instance_name_conflict: 'O nome desta instância já está em uso na Evolution e ela não pôde ser verificada para reutilização.',
    webhook_failed: 'A instância foi criada, mas o webhook não pôde ser configurado.',
    qr_failed: 'Não foi possível gerar o QR Code. Tente novamente.',
    qr_missing: 'A Evolution respondeu, mas não forneceu um QR Code. Tente gerar novamente.',
    public_url_missing: 'A URL pública HTTPS do PapiCore ainda não está configurada.',
    reserved_instance: 'O nome desta instância é reservado para a PapiCore e não pode ser usado por uma empresa.',
    already_connected: 'A instância já está conectada na Evolution.',
    evolution_not_configured_legacy: 'Evolution API ainda não está configurada no painel do desenvolvedor.'
  };
  const code = result && result.code;
  if (code && messages[code]) return messages[code];
  return (result && result.message) || 'Não foi possível gerar o QR Code.';
}

/* Mapeia o código de erro do connect para um status HTTP coerente (PASSO 3).
   Conflito não recuperável de nome de instância vira 409 (não 502 genérico);
   falhas de dependência (Evolution/QR/webhook) continuam 502; configuração
   ausente vira 503/500. */
function connectErrorHttpStatus(result) {
  switch (result && result.code) {
    case 'instance_name_conflict':
    case 'connect_in_progress':
      return 409;
    case 'public_url_missing':
      return 500;
    case 'evolution_not_configured':
      return 503;
    case 'instance_create_failed':
    case 'webhook_failed':
    case 'qr_failed':
    case 'qr_missing':
    case 'evolution_unreachable':
    default:
      return 502;
  }
}

/* Código interno sanitizado (sem segredos) exposto ao front junto do erro. */
function connectErrorCode(result) {
  switch (result && result.code) {
    case 'instance_name_conflict': return 'INSTANCE_NAME_CONFLICT';
    case 'connect_in_progress': return 'CONNECT_IN_PROGRESS';
    case 'evolution_not_configured': return 'EVOLUTION_NOT_CONFIGURED';
    case 'public_url_missing': return 'PUBLIC_URL_MISSING';
    case 'instance_create_failed': return 'INSTANCE_CREATE_FAILED';
    case 'webhook_failed': return 'WEBHOOK_FAILED';
    case 'qr_failed': return 'QR_FAILED';
    case 'qr_missing': return 'QR_MISSING';
    case 'evolution_unreachable': return 'EVOLUTION_UNREACHABLE';
    default: return 'CONNECT_FAILED';
  }
}

async function disconnect(tenant) {
  const providerName = activeProviderName();
  const tenantId = tenant.id;
  const current = getEvolutionInstance(tenantId);
  if (current && isReservedInstanceName(current.instance_name)) {
    return { error: true, message: 'Esta instância é reservada para a PapiCore e não pode ser desconectada.' };
  }
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

/* ---------- Reconciliação (banco core ↔ Evolution) ---------- */

/* Compara as instâncias locais (evolution_instances) com as existentes na
   Evolution. dryRun=true apenas reporta; dryRun=false aplica os status no
   banco. NUNCA exclui, desconecta ou altera instância reservada
   (papicore_support). */
async function reconcileInstances({ dryRun = false } = {}) {
  const providerName = activeProviderName();
  const settings = evolutionProvider.getSettings();
  const configured = evolutionProvider.isConfigured(settings);
  const result = {
    provider: providerName,
    configured,
    synced: [],
    missing_remote: [],
    orphans: [],
    reserved: []
  };

  const tenants = listTenants();
  const local = tenants
    .map((t) => {
      const instance = getEvolutionInstance(t.id);
      return instance
        ? { tenant_id: t.id, tenant_name: t.name, instance_name: instance.instance_name, status: instance.status }
        : null;
    })
    .filter(Boolean);

  if (providerName !== PROVIDER_EVOLUTION || !configured) {
    result.local = local;
    result.note = 'Provider não ativo/configurado — apenas inventário local.';
    return result;
  }

  let remote = null;
  try {
    remote = await evolutionProvider.listInstances(settings);
  } catch (err) {
    return { ...result, error: `Não foi possível consultar a Evolution: ${err.message}` };
  }
  if (remote.error) return { ...result, error: remote.message };

  const remoteByName = new Map((remote.instances || []).map((i) => [i.name, i]));
  const localByName = new Map(local.map((l) => [l.instance_name, l]));

  for (const item of local) {
    const remoteInstance = remoteByName.get(item.instance_name);
    if (remoteInstance) {
      result.synced.push({
        tenant_id: item.tenant_id,
        tenant_name: item.tenant_name,
        instance_name: item.instance_name,
        remote_status: remoteInstance.status,
        local_status: item.status
      });
      if (!dryRun) {
        const status = remoteInstance.status === 'open'
          ? 'connected'
          : remoteInstance.status === 'connecting' ? 'connecting' : 'disconnected';
        const patch = { status, qr_base64: '' };
        if (status === 'connected') {
          const row = getEvolutionInstance(item.tenant_id);
          patch.connected_at = (row && row.connected_at) || dateTimeNow();
        }
        upsertEvolutionInstance(item.tenant_id, patch);
      }
    } else {
      result.missing_remote.push({
        tenant_id: item.tenant_id,
        tenant_name: item.tenant_name,
        instance_name: item.instance_name,
        local_status: item.status
      });
      if (!dryRun) upsertEvolutionInstance(item.tenant_id, { status: 'missing_remote' });
    }
  }

  for (const remoteInstance of remoteByName.values()) {
    if (isReservedInstanceName(remoteInstance.name)) {
      result.reserved.push({ instance_name: remoteInstance.name, status: remoteInstance.status });
      continue;
    }
    if (!localByName.has(remoteInstance.name)) {
      result.orphans.push({ instance_name: remoteInstance.name, status: remoteInstance.status });
    }
  }

  logWhatsapp(LOG_ACTIONS.RECONCILED, null, {
    dry_run: Boolean(dryRun),
    synced: result.synced.length,
    missing_remote: result.missing_remote.length,
    orphans: result.orphans.length,
    reserved: result.reserved.length
  });
  return result;
}

/* Vincula uma instância órfã (existe na Evolution, sem vínculo local) a um
   tenant. Valida instância reservada e conflitos antes de gravar. */
async function associateOrphan(instanceName, tenantId) {
  const name = String(instanceName || '').trim();
  if (!name) return { error: true, message: 'Informe o nome da instância.' };
  if (isReservedInstanceName(name)) {
    return { error: true, message: 'Instância reservada da PapiCore não pode ser associada a uma empresa.' };
  }
  const tenant = getTenantById(tenantId);
  if (!tenant) return { error: true, message: 'Empresa não encontrada.' };

  const byName = getEvolutionInstanceByInstanceName(name);
  if (byName && byName.tenant_id !== tenantId) {
    return { error: true, message: 'Esta instância já está vinculada a outra empresa.' };
  }
  const existing = getEvolutionInstance(tenantId);
  if (existing && existing.instance_name !== name) {
    return { error: true, message: 'A empresa já possui outra instância vinculada.' };
  }

  let remoteStatus = 'unknown';
  const settings = evolutionProvider.getSettings();
  if (evolutionProvider.isConfigured(settings)) {
    try {
      const remote = await evolutionProvider.getState(name, settings);
      if (remote.ok) remoteStatus = remote.status;
    } catch { /* mantém unknown */ }
  }
  const status = remoteStatus === 'open'
    ? 'connected'
    : remoteStatus === 'connecting' ? 'connecting' : 'disconnected';
  upsertEvolutionInstance(tenantId, {
    tenant_id: tenantId,
    database_name: tenant.database_name,
    instance_name: name,
    status,
    qr_base64: '',
    last_error: null,
    connected_at: status === 'connected' ? dateTimeNow() : null
  });
  ensureWebhookToken(tenantId);
  logWhatsapp(LOG_ACTIONS.INSTANCE_ASSOCIATED, tenantId, { instance_name: name, remote_status: remoteStatus });
  return { ok: true, instance: safeInstance(getEvolutionInstance(tenantId)) };
}

/* Exclui da Evolution uma instância órfã (sem vínculo local). Bloqueia a
   instância reservada da PapiCore. */
async function deleteOrphan(instanceName) {
  const name = String(instanceName || '').trim();
  if (!name) return { error: true, message: 'Informe o nome da instância.' };
  if (isReservedInstanceName(name)) {
    return { error: true, message: 'Instância reservada da PapiCore não pode ser excluída.' };
  }
  const byName = getEvolutionInstanceByInstanceName(name);
  if (byName) {
    return { error: true, message: 'A instância está vinculada a uma empresa — use a ação da própria empresa.' };
  }
  const settings = evolutionProvider.getSettings();
  if (!evolutionProvider.isConfigured(settings)) {
    return { error: true, message: 'Evolution API não está configurada.' };
  }
  const result = await evolutionProvider.deleteInstance(name, settings);
  if (result.error) return { error: true, message: result.message };
  logWhatsapp(LOG_ACTIONS.INSTANCE_DELETED, null, { instance_name: name, orphan: true });
  return { ok: true };
}

/* (Re)configura o webhook da instância de uma empresa contra a Evolution,
   usando o token por instância no header x-webhook-token. */
async function configureWebhook(tenant) {
  const providerName = activeProviderName();
  if (providerName !== PROVIDER_EVOLUTION) {
    return { error: true, message: 'O provider ativo não é a Evolution.' };
  }
  const instance = getEvolutionInstance(tenant.id);
  if (!instance) return { error: true, message: 'Nenhuma instância registrada para esta empresa.' };
  const settings = evolutionProvider.getSettings();
  if (!evolutionProvider.isConfigured(settings)) {
    return { error: true, message: 'Evolution API ainda não está configurada.' };
  }
  const publicUrl = String(process.env.PAPICORE_PUBLIC_URL || process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(publicUrl)) {
    return { error: true, message: 'Configure PAPICORE_PUBLIC_URL com a URL HTTPS pública.' };
  }
  const webhookToken = ensureWebhookToken(tenant.id);
  const url = `${publicUrl}/api/webhooks/whatsapp`;
  const result = await evolutionProvider.setWebhook(instance.instance_name, {
    url,
    headers: { 'x-webhook-token': webhookToken }
  }, settings);
  if (result.error) return { error: true, message: result.message };
  logWhatsapp(LOG_ACTIONS.WEBHOOK_CONFIGURED, tenant.id, { instance_name: instance.instance_name });
  return { ok: true, url };
}

/* Validação de boot: se a Evolution é o provider ativo e está habilitada, as
   variáveis obrigatórias precisam existir. O server.js aborta com mensagem
   clara se faltar alguma (evita provider ativo com config parcial). */
function validateEvolutionBootConfig() {
  const forced = providerSetting();
  if (forced !== PROVIDER_EVOLUTION) {
    return { ok: true, provider: forced || 'auto', evolution: false };
  }
  const evolutionEnabledEnv = String(process.env.EVOLUTION_ENABLED || '').toLowerCase() === 'true';
  if (!isWhatsappEnabled() && !evolutionEnabledEnv) {
    return { ok: true, provider: PROVIDER_EVOLUTION, evolution: false };
  }
  const url = String(process.env.WHATSAPP_API_URL || process.env.EVOLUTION_SERVER_URL || '').trim();
  const key = String(process.env.WHATSAPP_API_KEY || process.env.EVOLUTION_API_KEY || '').trim();
  const missing = [];
  if (!url) missing.push('WHATSAPP_API_URL (ou EVOLUTION_SERVER_URL)');
  if (!key) missing.push('WHATSAPP_API_KEY (ou EVOLUTION_API_KEY)');
  if (process.env.NODE_ENV === 'production' && !String(process.env.WHATSAPP_WEBHOOK_SECRET || '').trim()) {
    missing.push('WHATSAPP_WEBHOOK_SECRET (obrigatório em produção)');
  }
  if (missing.length) {
    return {
      ok: false,
      provider: PROVIDER_EVOLUTION,
      message: `WhatsApp Evolution é o provider ativo, mas faltam variáveis: ${missing.join(', ')}. Defina-as no .env.`
    };
  }
  return { ok: true, provider: PROVIDER_EVOLUTION, evolution: true };
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
      phone: formatPhone(t.phone || ''),
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

  const expected = instance.webhook_token || String(process.env.WHATSAPP_WEBHOOK_SECRET || process.env.WHATSAPP_WEBHOOK_TOKEN || '').trim();
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
        const raw = payload && payload.data && payload.data.base64;
        const qr = evolutionProvider.ensureDataUri(raw);
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
      tenantDb.prepare(
        "UPDATE whatsapp_outbox SET status = 'PENDING', last_error = COALESCE(last_error, 'Processamento abandonado recuperado.') WHERE status = 'PROCESSING' AND scheduled_at < datetime('now', 'localtime', '-10 minutes')"
      ).run();
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
  friendlyErrorMessage,
  connectErrorHttpStatus,
  connectErrorCode,
  ensureWebhookToken,
  configureWebhook,
  /* reconciliação / segurança */
  reconcileInstances,
  associateOrphan,
  deleteOrphan,
  isReservedInstanceName,
  validateEvolutionBootConfig,
  qrExpired,
  qrExpiresAt,
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
