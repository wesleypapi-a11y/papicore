#!/usr/bin/env node
/*
 * testWhatsappModule.js
 *
 * Suíte do módulo WhatsApp (novo núcleo services/whatsapp/whatsappService.js
 * + providers mock/evolution):
 *   - migrações whatsapp_v2 (histórico imutável + processed_at) e
 *     evolution_v2 (colunas de auditoria + webhook_token);
 *   - interface comum dos providers (mock e evolution);
 *   - regra de segurança: Evolution JAMAIS executa sem WHATSAPP_ENABLED=true;
 *   - outbox: fila, idempotência, reenvio, retries e histórico imutável;
 *   - placeholders: lista fechada + validação de conteúdo (HTML/JS rejeitado);
 *   - conexão/QR (MOCK simula scan), auditoria e webhook (token);
 *   - painel do desenvolvedor (overview), worker e compatibilidade (shims).
 *
 * Roda em DATA_DIR temporário (não toca os dados reais):
 *   node scripts/testWhatsappModule.js
 *
 * Código de saída: 0 (ok) ou 1 (falha).
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-whatsapp-module-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';
process.env.WHATSAPP_ENABLED = 'false';
delete process.env.WHATSAPP_PROVIDER;
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.EVOLUTION_ENABLED;
delete process.env.EVOLUTION_SERVER_URL;
delete process.env.EVOLUTION_API_KEY;

const core = require('../database/coreDatabase');
const { openTenantDatabase, closeTenantDatabase, runWithTenant } = require('../database/tenantDatabase');
const whatsappService = require('../services/whatsappService');
const coreService = require('../services/whatsapp/whatsappService');
const evolutionService = require('../services/evolutionService');
const mockProvider = require('../services/whatsapp/providers/mockProvider');
const evolutionProvider = require('../services/whatsapp/providers/evolutionProvider');
const whatsappController = require('../controllers/whatsappController');
const packageService = require('../services/packageService');
const { todayStr, toDateStr, addDays } = require('../utils/helpers');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
let failures = 0;

async function run() {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      failures += 1;
      console.error(`  FALHA ${t.name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n        ') : err}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* ---------- Helpers ---------- */

let db = null;
let tenant = null;
let tenantName = null;

function withDb(fn) {
  return runWithTenant(db, fn);
}

function flush(database) {
  return whatsappService.processOutbox({ db: database || db });
}

function callController(fn, params, body, user, query) {
  let result;
  const req = {
    body: body || {},
    params: params || {},
    query: query || {},
    user: user || { id: 999, name: 'Teste', role: 'owner' },
    tenant
  };
  const res = {
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (d) => {
      result = d;
      return res;
    }
  };
  return new Promise((resolve) => {
    runWithTenant(db, async () => {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') await out.catch((err) => { res.statusCode = res.statusCode || 500; result = { error: err.message }; });
      resolve({ result, status: res.statusCode });
    });
  });
}

function outboxFor(database, eventKey, appointmentId) {
  return database.prepare('SELECT * FROM whatsapp_outbox WHERE idempotency_key = ? ORDER BY id ASC')
    .all(`${eventKey}:${appointmentId}`);
}

function historyFor(database, outboxId) {
  return database.prepare('SELECT * FROM whatsapp_message_history WHERE outbox_id = ? ORDER BY id ASC').all(outboxId);
}

function appointmentFactory(id, extra = {}) {
  return {
    id,
    appointment_code: `TEST-${id}`,
    customer_name: 'Cliente Módulo',
    customer_phone: '(11) 97777-1234',
    appointment_date: toDateStr(addDays(new Date(), 1)),
    start_time: '09:00',
    end_time: '10:00',
    service_name: 'Lavagem',
    vehicle_brand: 'Fiat',
    vehicle_model: 'Argo',
    vehicle_year: '2020',
    unit_name: 'Matriz',
    modality_name: 'Presencial',
    total_price: 120,
    booked_duration_minutes: 60,
    customer_package_id: null,
    ...extra
  };
}

function pickService() {
  const s = db.prepare(
    "SELECT * FROM services WHERE active = 1 AND price_type = 'fixed' AND available_at_unit = 1 ORDER BY id ASC LIMIT 1"
  ).get();
  assert(s, 'tenant precisa de ao menos 1 serviço fixo ativo');
  return s;
}

function storePhoneFrom(database) {
  const s = database.prepare('SELECT whatsapp, phone FROM company_settings WHERE id = 1').get() || {};
  return s.whatsapp || s.phone || null;
}

/* WHATSAPP_* logs no core (auditoria) */
function whatsappLogs() {
  return core.getCoreDb().prepare(
    "SELECT action, details, tenant_id FROM activity_logs WHERE action LIKE 'WHATSAPP_%' ORDER BY id ASC"
  ).all();
}

/* ---------- Testes ---------- */

test('migração whatsapp_v2: histórico imutável + processed_at na outbox', () => {
  core.initCore();
  tenant = core.getTenantById(1);
  assert(tenant, 'tenant padrão existe');
  tenantName = tenant.database_name;
  db = openTenantDatabase(tenantName);

  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('whatsapp_outbox', 'whatsapp_message_history')`
  ).all().map((r) => r.name);
  assert(tables.includes('whatsapp_outbox'), 'whatsapp_outbox existe');
  assert(tables.includes('whatsapp_message_history'), 'whatsapp_message_history existe');

  const cols = db.prepare('PRAGMA table_info(whatsapp_outbox)').all().map((c) => c.name);
  assert(cols.includes('processed_at'), 'whatsapp_outbox.processed_at existe');

  const marker = db.prepare("SELECT name FROM schema_migrations WHERE name = 'whatsapp_v2'").get();
  assert(marker, 'migração whatsapp_v2 registrada em schema_migrations');
});

test('migração evolution_v2: colunas de auditoria + webhook_token na instância', () => {
  const cols = core.getCoreDb().prepare('PRAGMA table_info(evolution_instances)').all().map((c) => c.name);
  for (const c of ['connected_at', 'last_connection', 'last_disconnect', 'last_qr_generated', 'webhook_token']) {
    assert(cols.includes(c), `evolution_instances.${c} existe`);
  }
  const marker = core.getCoreDb().prepare("SELECT name FROM schema_migrations WHERE name = 'evolution_v2'").get();
  assert(marker, 'migração evolution_v2 registrada em schema_migrations');
  assert(typeof core.getEvolutionInstanceByInstanceName === 'function', 'getEvolutionInstanceByInstanceName exportada');
});

test('interface comum dos providers (mock e evolution): 12 métodos', () => {
  const required = [
    'testConnection', 'createInstance', 'deleteInstance', 'connect', 'disconnect',
    'generateQRCode', 'sendText', 'sendImage', 'sendFile', 'getStatus', 'syncStatus', 'receiveWebhook'
  ];
  for (const p of [mockProvider, evolutionProvider]) {
    for (const method of required) {
      assert(typeof p[method] === 'function', `${p.name}.${method} é função`);
    }
  }
  assert(mockProvider.name === 'mock', 'provider mock identificado');
  assert(evolutionProvider.name === 'evolution', 'provider evolution identificado');
});

test('MOCK é o padrão e Evolution JAMAIS executa sem WHATSAPP_ENABLED=true', () => {
  core.upsertEvolutionSettings({ enabled: true, server_url: 'https://evo.local', api_key: 'chave' });
  process.env.WHATSAPP_ENABLED = 'false';
  assert(whatsappService.activeProviderName() === 'mock', 'WHATSAPP_ENABLED=false → mock mesmo com settings habilitadas');
  assert(whatsappService.getStatus().mock === true, 'getStatus.mock true');

  process.env.WHATSAPP_ENABLED = 'true';
  assert(whatsappService.activeProviderName() === 'evolution', 'WHATSAPP_ENABLED=true + settings habilitadas → evolution');
  core.upsertEvolutionSettings({ enabled: false, server_url: '', api_key: '' });
  assert(whatsappService.activeProviderName() === 'mock', 'settings desabilitadas → mock');

  core.upsertEvolutionSettings({ enabled: true, server_url: 'https://evo.local', api_key: 'chave' });
  process.env.WHATSAPP_ENABLED = 'false';
  core.upsertEvolutionSettings({ enabled: false, server_url: '', api_key: '' });
  delete process.env.WHATSAPP_PROVIDER;
});

test('provider evolution ativa mas sem URL/chave: envio é skipped not_configured (sem rede)', async () => {
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHATSAPP_PROVIDER = 'evolution';
  core.upsertEvolutionSettings({ enabled: true, server_url: '', api_key: '' });
  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { fetchCalls += 1; return { ok: false, status: 500, json: async () => ({}) }; };
  try {
    const r = await whatsappService.sendTextMessage('(11) 99999-0000', 'teste', 'inst');
    assert(r.skipped === true && r.reason === 'not_configured', 'não configurado → skipped sem chamar rede');
    assert(fetchCalls === 0, `nenhuma chamada de rede (chamadas: ${fetchCalls})`);
  } finally {
    global.fetch = originalFetch;
    process.env.WHATSAPP_ENABLED = 'false';
    delete process.env.WHATSAPP_PROVIDER;
    core.upsertEvolutionSettings({ enabled: false, server_url: '', api_key: '' });
  }
});

test('enqueueEvent: alias REQUESTED_CLIENT→CUSTOMER, mensagem ao cliente', () => {
  let out;
  withDb(() => {
    out = whatsappService.enqueueEvent('APPOINTMENT_REQUESTED_CLIENT', appointmentFactory(1001));
  });
  assert(out.skipped !== true, 'enfileirada');
  const row = outboxFor(db, 'APPOINTMENT_REQUESTED_CUSTOMER', 1001);
  assert(row.length === 1, `uma mensagem ao cliente (veio ${row.length})`);
  assert(row[0].recipient_kind === 'customer', 'destinatário cliente');
  assert(row[0].status === 'PENDING', 'começa PENDING');
  assert((row[0].message_text || '').includes('TEST-1001'), 'código do agendamento no texto');
});

test('enqueueEvent à loja: só enfileira se a empresa tem telefone', () => {
  const original = storePhoneFrom(db);
  db.prepare("UPDATE company_settings SET whatsapp = NULL, phone = NULL WHERE id = 1").run();
  let out;
  withDb(() => {
    out = whatsappService.enqueueEvent('APPOINTMENT_REQUESTED_STORE', appointmentFactory(1002));
  });
  assert(out.skipped === true && out.reason === 'no_store_phone', `sem telefone → skipped (veio ${out.reason})`);

  db.prepare("UPDATE company_settings SET whatsapp = '(11) 91234-5678' WHERE id = 1").run();
  withDb(() => {
    out = whatsappService.enqueueEvent('APPOINTMENT_REQUESTED_STORE', appointmentFactory(1002));
  });
  assert(out.skipped !== true, 'com telefone → enfileirada');
  const row = outboxFor(db, 'APPOINTMENT_REQUESTED_STORE', 1002);
  assert(row.length === 1 && row[0].recipient_kind === 'store', 'mensagem à loja');

  /* restaura */
  db.prepare('UPDATE company_settings SET whatsapp = ?, phone = NULL WHERE id = 1').run(original);
});

test('enqueueEvent: idempotência (mesmo evento/agendamento não duplica)', () => {
  withDb(() => {
    whatsappService.enqueueEvent('APPOINTMENT_CONFIRMED', appointmentFactory(1003));
    whatsappService.enqueueEvent('APPOINTMENT_CONFIRMED', appointmentFactory(1003));
  });
  const rows = outboxFor(db, 'APPOINTMENT_CONFIRMED', 1003);
  assert(rows.length === 1, `uma linha apesar do duplo clique (veio ${rows.length})`);
});

test('enqueueEvent: reuso da linha FAILED (reenfileira sem criar outra)', () => {
  db.prepare(
    `INSERT INTO whatsapp_outbox (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
     VALUES ('APPOINTMENT_CANCELLED', '5511977771234', 'customer', '{}', 'erro', 'APPOINTMENT_CANCELLED:1004', 'FAILED')`
  ).run();
  let out;
  withDb(() => {
    out = whatsappService.enqueueEvent('APPOINTMENT_CANCELLED', appointmentFactory(1004));
  });
  assert(out.reenqueued === true, `linha FAILED reenfileirada (veio ${JSON.stringify(out)})`);
  const rows = outboxFor(db, 'APPOINTMENT_CANCELLED', 1004);
  assert(rows.length === 1, `continua uma linha só (veio ${rows.length})`);
  assert(rows[0].status === 'PENDING' && rows[0].attempts === 0, 'status PENDING e attempts zeradas');
});

test('enqueueEvent: sem template ou template desativado → skipped', () => {
  let out;
  withDb(() => { out = whatsappService.enqueueEvent('EVENTO_INEXISTENTE', appointmentFactory(1005)); });
  assert(out.skipped === true && out.reason === 'no_template', 'sem template → no_template');

  db.prepare("UPDATE whatsapp_message_templates SET enabled = 0 WHERE event_key = 'APPOINTMENT_CANCELLED'").run();
  withDb(() => { out = whatsappService.enqueueEvent('APPOINTMENT_CANCELLED', appointmentFactory(1005)); });
  assert(out.skipped === true && out.reason === 'disabled', 'template desativado → disabled');
  db.prepare("UPDATE whatsapp_message_templates SET enabled = 1 WHERE event_key = 'APPOINTMENT_CANCELLED'").run();

  withDb(() => { out = whatsappService.enqueueEvent('APPOINTMENT_CONFIRMED', null); });
  assert(out.skipped === true && out.reason === 'invalid_appointment', 'sem agendamento → invalid_appointment');
});

test('processOutbox MOCK: SIMULATED, processed_at preenchido e histórico gravado', async () => {
  await flush(db);
  const row = outboxFor(db, 'APPOINTMENT_REQUESTED_CUSTOMER', 1001)[0];
  assert(row.status === 'SIMULATED', `simulada (veio ${row.status})`);
  assert(row.processed_at, 'processed_at preenchido');
  assert(row.sent_at, 'sent_at preenchido (simulação = envio efetivado)');

  const hist = historyFor(db, row.id);
  assert(hist.length === 1, `um registro no histórico (veio ${hist.length})`);
  assert(hist[0].status === 'SIMULATED', 'histórico com status SIMULATED');
  assert(hist[0].sent_at, 'histórico com sent_at');

  const logs = whatsappLogs();
  assert(logs.some((l) => l.action === 'WHATSAPP_MESSAGE_SIMULATED'), 'log WHATSAPP_MESSAGE_SIMULATED gravado');
  assert(logs.some((l) => l.action === 'WHATSAPP_MESSAGE_QUEUED'), 'log WHATSAPP_MESSAGE_QUEUED gravado');
});

test('histórico imutável: reenvio gera NOVO registro sem alterar o anterior', async () => {
  const before = outboxFor(db, 'APPOINTMENT_REQUESTED_CUSTOMER', 1001)[0];
  whatsappService.resendOutbox(db, before.id);
  assert(before.status !== 'PENDING', 'estado anterior preservado no objeto lido antes do reenvio');
  await flush(db);
  const after = outboxFor(db, 'APPOINTMENT_REQUESTED_CUSTOMER', 1001)[0];
  assert(after.status === 'SIMULATED', 'reenviada e simulada de novo');

  const hist = historyFor(db, before.id);
  assert(hist.length === 2, `histórico imutável: 2 registros (veio ${hist.length})`);
  assert(hist[0].status === 'SIMULATED', 'primeiro registro mantido');
});

test('resendOutbox: FAILED e SIMULATED voltam para PENDING; SENT não', () => {
  const ok = outboxFor(db, 'APPOINTMENT_REQUESTED_STORE', 1002)[0];
  assert(ok.status === 'SIMULATED', 'loja simulada (pré-requisito)');
  const r = whatsappService.resendOutbox(db, ok.id);
  assert(r.status === 'PENDING' && r.attempts === 0, 'SIMULATED → PENDING com attempts 0');
  db.prepare(
    `INSERT INTO whatsapp_outbox (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
     VALUES ('APPOINTMENT_COMPLETED', '5511977771234', 'customer', '{}', 'x', 'APPOINTMENT_COMPLETED:1006', 'SENT')`
  ).run();
  const sentRow = db.prepare("SELECT * FROM whatsapp_outbox WHERE idempotency_key = 'APPOINTMENT_COMPLETED:1006'").get();
  const keep = whatsappService.resendOutbox(db, sentRow.id);
  assert(keep.status === 'SENT', 'SENT não é reenviada pelo resendOutbox');
});

test('retries: 3 tentativas com falha → FAILED + histórico (operação não é desfeita)', async () => {
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHATSAPP_PROVIDER = 'evolution';
  process.env.WHATSAPP_MAX_RETRIES = '3';
  core.upsertEvolutionSettings({ enabled: true, server_url: 'https://evo.local', api_key: 'chave' });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  try {
    const info = db.prepare(
      `INSERT INTO whatsapp_outbox (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
       VALUES ('APPOINTMENT_COMPLETED', '5511977771234', 'customer', '{}', 'falha proposital', 'APPOINTMENT_COMPLETED:1007', 'PENDING')`
    ).run();
    await flush(db);
    let row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(info.lastInsertRowid);
    assert(row.status === 'PENDING' && row.attempts === 1 && row.last_error, '1ª falha: PENDING com retry e erro registrado');

    await flush(db);
    row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(info.lastInsertRowid);
    assert(row.status === 'PENDING' && row.attempts === 2, '2ª falha: aguarda retry');

    await flush(db);
    row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(info.lastInsertRowid);
    assert(row.status === 'FAILED' && row.attempts === 3, `3ª falha: FAILED (veio ${row.status}/${row.attempts})`);
    assert(row.processed_at, 'processed_at no FAILED final');

    const hist = historyFor(db, row.id);
    assert(hist.some((h) => h.status === 'FAILED'), 'histórico com FAILED final');
  } finally {
    global.fetch = originalFetch;
    process.env.WHATSAPP_ENABLED = 'false';
    delete process.env.WHATSAPP_PROVIDER;
    delete process.env.WHATSAPP_MAX_RETRIES;
    core.upsertEvolutionSettings({ enabled: false, server_url: '', api_key: '' });
  }
});

test('placeholders: resolução no texto e bloco de saldo no evento de pacote', () => {
  const template = '{{CLIENTE_NOME}} — {{DATA}} {{HORARIO}} — {{VEICULO}} — {{UNIDADE_NOME}} — {{MODALIDADE}} — {{VALOR}} — {{UNIDADE_ENDERECO}}';
  const rendered = withDb(() => whatsappService.renderTemplate(template, whatsappService.resolvePlaceholders(
    'APPOINTMENT_CONFIRMED', appointmentFactory(1008), { linkAdmin: '/admin', unitAddress: 'Rua A, 10 — Centro' }
  )));
  assert(rendered.includes('Cliente Módulo'), 'CLIENTE_NOME resolvido');
  assert(rendered.includes('Fiat Argo'), 'VEICULO resolvido');
  assert(rendered.includes('R$ 120,00') || rendered.includes('R$ 120'), 'VALOR formatado');
  assert(rendered.includes('Rua A, 10 — Centro'), 'UNIDADE_ENDERECO via opts');

  /* SALDO_PACOTE apenas para COMPLETED_PACKAGE */
  const pkg = withDb(() => packageService.createServicePackage(db, {
    name: 'Pacote Módulo',
    price: '150,00',
    items: [{ service_id: pickService().id, quantity: 3 }]
  }, 1));
  const sold = withDb(() => packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Pacote Módulo', phone: '(11) 96666-0000' } }, 1));
  const values = withDb(() => whatsappService.resolvePlaceholders('APPOINTMENT_COMPLETED_PACKAGE', appointmentFactory(1009, { customer_package_id: sold.id })));
  assert((values.SALDO_PACOTE || '').includes('3 disponíveis'), `saldo do pacote (3 vendidos): ${values.SALDO_PACOTE}`);
  const normal = withDb(() => whatsappService.resolvePlaceholders('APPOINTMENT_COMPLETED', appointmentFactory(1009, { customer_package_id: sold.id })));
  assert(normal.SALDO_PACOTE === '', 'saldo vazio no evento comum');
});

test('validateTemplateContent: aceita lista fechada e rejeita HTML/JS/desconhecidos/chaves soltas', () => {
  assert(whatsappService.validateTemplateContent('Olá {{CLIENTE_NOME}}, seu {{SERVICO}}!') === 'Olá {{CLIENTE_NOME}}, seu {{SERVICO}}!', 'conteúdo válido aceito');

  let threw = null;
  try { whatsappService.validateTemplateContent('Oi <script>alert(1)</script>'); } catch (e) { threw = e; }
  assert(threw && /HTML|JavaScript|inseguro/i.test(threw.message), 'script rejeitado');

  try { whatsappService.validateTemplateContent('{{NAO_EXISTE}}'); } catch (e) { threw = e; }
  assert(threw && /desconhecido/i.test(threw.message), 'placeholder desconhecido rejeitado');

  try { whatsappService.validateTemplateContent('chave solta {{CLIENTE_NOME'); } catch (e) { threw = e; }
  assert(threw && /chaves soltas/i.test(threw.message), 'chaves soltas rejeitadas');

  try { whatsappService.validateTemplateContent(''); } catch (e) { threw = e; }
  assert(threw && /vazio/i.test(threw.message), 'vazio rejeitado');
});

/* Decodifica o QR de simulação (base64 de um SVG) e procura texto. */
function qrText(qr) {
  if (!qr || !qr.startsWith('data:image/svg+xml;base64,')) return '';
  return Buffer.from(qr.split(',')[1], 'base64').toString('utf8');
}

test('connect MOCK: QR de simulação, instância registrada e webhook_token gerado', async () => {
  const result = await whatsappService.connect(tenant);
  assert(result.ok === true && result.status === 'connecting', 'connect ok em MOCK');
  assert(result.mock === true, 'indica MOCK');
  assert(result.qr && result.qr.startsWith('data:image/svg+xml;base64,'), 'QR de simulação exibível');
  assert(qrText(result.qr).includes('MODO SIMULAÇÃO'), 'QR marcado como MODO SIMULAÇÃO');

  const row = core.getEvolutionInstance(tenant.id);
  assert(row, 'instância registrada no core');
  assert(row.instance_name === whatsappService.instanceNameFromDatabaseName(tenantName), 'instance_name derivado do banco');
  assert(row.status === 'connecting', 'status connecting');
  assert(row.webhook_token && row.webhook_token.length >= 20, 'webhook_token gerado');
  assert(row.last_qr_generated, 'last_qr_generated preenchido');
});

test('connectionState expõe QR, provider e timestamps de auditoria', () => {
  const state = whatsappService.connectionState(tenant);
  assert(state.status === 'connecting', 'status connecting no painel');
  assert(state.qr && qrText(state.qr).includes('MODO SIMULAÇÃO'), 'QR exposto ao painel');
  assert(state.provider === 'mock', 'provider mock');
  assert(state.mode === 'simulation', 'modo simulação');
  assert(state.webhook_token_set === true, 'webhook_token_set true');
  assert(state.last_qr_generated, 'last_qr_generated no estado');
});

test('refreshStatus MOCK simula o scan: connecting → connected com timestamps', async () => {
  const out = await whatsappService.refreshStatus(tenant);
  assert(out.status === 'connected', `scan simulado conecta (veio ${out.status})`);
  const row = core.getEvolutionInstance(tenant.id);
  assert(row.status === 'connected', 'status no registro = connected');
  assert(!row.qr_base64, 'QR limpo após conectar');
  assert(row.connected_at && row.last_connection, 'connected_at e last_connection preenchidos');
  const state = whatsappService.connectionState(tenant);
  assert(state.status === 'connected', 'painel vê connected');
  assert(state.connected_at && state.last_connection, 'painel expõe connected_at/last_connection');
});

test('disconnect MOCK: status disconnected, QR limpo, last_disconnect e log', async () => {
  const out = await whatsappService.disconnect(tenant);
  assert(out.status === 'disconnected', 'disconnect ok');
  const row = core.getEvolutionInstance(tenant.id);
  assert(row.status === 'disconnected' && !row.qr_base64, 'registro mantido como disconnected, QR limpo');
  assert(row.last_disconnect, 'last_disconnect preenchido');
  const logs = whatsappLogs();
  assert(logs.some((l) => l.action === 'WHATSAPP_DISCONNECTED'), 'log WHATSAPP_DISCONNECTED gravado');
});

test('webhook válido: connection.update open → connected + log, sem expor token', async () => {
  const token = core.getEvolutionInstance(tenant.id).webhook_token;
  assert(token, 'token disponível para o webhook');

  const r = await whatsappService.handleWebhook(
    { event: 'connection.update', state: 'open', instance: whatsappService.instanceNameFromDatabaseName(tenantName), webhook_token: token },
    {}
  );
  assert(r.status === 200 && r.received === true, `webhook aceito (${r.status})`);
  const row = core.getEvolutionInstance(tenant.id);
  assert(row.status === 'connected', 'instância conectada via webhook');

  const logs = whatsappLogs();
  assert(logs.some((l) => l.action === 'WHATSAPP_WEBHOOK_RECEIVED'), 'log WHATSAPP_WEBHOOK_RECEIVED');
  assert(logs.some((l) => l.action === 'WHATSAPP_CONNECTED'), 'log WHATSAPP_CONNECTED');
  const joined = JSON.stringify(logs);
  assert(!joined.includes(token), 'token de webhook NUNCA vai para o log');
});

test('webhook: token inválido → 401; instância desconhecida → 404', async () => {
  const instance = whatsappService.instanceNameFromDatabaseName(tenantName);
  const bad = await whatsappService.handleWebhook({ event: 'connection.update', instance, webhook_token: 'token-errado' }, {});
  assert(bad.status === 401, `token errado rejeitado (${bad.status})`);

  const unknown = await whatsappService.handleWebhook({ event: 'connection.update', instance: 'tenant_9999_nao_existe', webhook_token: 'x' }, {});
  assert(unknown.status === 404, `instância desconhecida → 404 (${unknown.status})`);
});

test('webhook: qrcode.updated grava QR; logout desconecta e limpa QR', async () => {
  const instance = whatsappService.instanceNameFromDatabaseName(tenantName);
  const token = core.getEvolutionInstance(tenant.id).webhook_token;

  const qr = await whatsappService.handleWebhook(
    { event: 'qrcode.updated', instance, data: { base64: 'data:image/png;base64,QRX' }, webhook_token: token }, {}
  );
  assert(qr.status === 200, 'qrcode.updated aceito');
  const row = core.getEvolutionInstance(tenant.id);
  assert(row.status === 'connecting' && row.qr_base64 === 'data:image/png;base64,QRX', 'QR atualizado via webhook');

  const out = await whatsappService.handleWebhook({ event: 'logout', instance, webhook_token: token }, {});
  assert(out.status === 200, 'logout aceito');
  const row2 = core.getEvolutionInstance(tenant.id);
  assert(row2.status === 'disconnected' && !row2.qr_base64, 'logout desconecta e limpa QR');

  const logs = whatsappLogs();
  const joined = JSON.stringify(logs);
  assert(!joined.includes('QRX') && !joined.includes('MODO SIMULAÇÃO'), 'QR nunca é logado');
});

test('controller webhook: rota pública repassa e responde status adequado', async () => {
  const instance = whatsappService.instanceNameFromDatabaseName(tenantName);
  const token = core.getEvolutionInstance(tenant.id).webhook_token;
  const ok = await callController(whatsappController.handleWebhook, null,
    { event: 'connection.update', state: 'open', instance, webhook_token: token });
  assert(ok.result.received === true, 'controller webhook aceita');
  const bad = await callController(whatsappController.handleWebhook, null,
    { event: 'connection.update', instance, webhook_token: 'errado' });
  assert(bad.status === 401, `controller webhook rejeita token inválido (${bad.status})`);
});

test('controller: getHistory com filtros (status/event_key/date) e paginação', async () => {
  const rows = await callController(whatsappController.getHistory, null, null, null, { status: 'SIMULATED' });
  assert(Array.isArray(rows.result) && rows.result.length >= 1, 'histórico filtrado por status');

  const byEvent = await callController(whatsappController.getHistory, null, null, null, { event_key: 'APPOINTMENT_REQUESTED_CUSTOMER' });
  assert(byEvent.result.every((r) => r.event_key === 'APPOINTMENT_REQUESTED_CUSTOMER'), 'filtro por evento');

  const byDate = await callController(whatsappController.getHistory, null, null, null, { date: todayStr() });
  assert(byDate.result.length >= 1, 'filtro por data');

  const pag = await callController(whatsappController.getHistory, null, null, null, { limit: 1 });
  assert(pag.result.length === 1, 'limit respeitado');
});

test('overview: instâncias por tenant com auditoria e sem expor api key', () => {
  const overview = whatsappService.overview();
  assert(Array.isArray(overview.instances), 'overview lista instâncias');
  const mine = overview.instances.find((i) => i.tenant_id === tenant.id);
  assert(mine, 'empresa presente no overview');
  assert(typeof mine.instance_name === 'string' && mine.instance_name.length > 0, 'instance_name no overview');
  assert('connected_at' in mine && 'last_disconnect' in mine, 'campos de auditoria no overview');
  assert(!('api_key' in overview), 'api key nunca é exposta pelo overview');
});

test('sendTextMessage: MOCK simula; compat aliases de notificação funcionam', async () => {
  const mockResult = await whatsappService.sendTextMessage('(11) 97777-0000', 'oi', 'inst');
  assert(mockResult.simulated === true && mockResult.ok === true, 'MOCK simula envio direto');

  withDb(() => {
    const r1 = whatsappService.notifyAppointmentConfirmed(appointmentFactory(1010));
    assert(r1.skipped !== true, 'notifyAppointmentConfirmed enfileira');
    const r2 = whatsappService.notifyStoreNewAppointment(appointmentFactory(1010));
    assert(r2.skipped !== true, 'notifyStoreNewAppointment enfileira');
  });
  assert(outboxFor(db, 'APPOINTMENT_CONFIRMED', 1010).length === 1, 'confirmação enfileirada');
  assert(outboxFor(db, 'APPOINTMENT_REQUESTED_STORE', 1010).length === 1, 'loja enfileirada');
});

test('buildConfirmationMessage/buildStoreNotificationMessage renderizam os modelos', () => {
  const confirmation = withDb(() => whatsappService.buildConfirmationMessage(appointmentFactory(1011)));
  const store = withDb(() => whatsappService.buildStoreNotificationMessage(appointmentFactory(1011)));
  assert((confirmation || '').includes('TEST-1011'), 'mensagem de confirmação com código');
  assert((store || '').length > 0, 'mensagem à loja não vazia');
});

test('shims de compatibilidade: whatsappService e evolutionService repassam o núcleo', () => {
  assert(require('../services/whatsappService') === coreService, 'services/whatsappService re-exporta o núcleo');
  assert(whatsappService.activeProviderName === coreService.activeProviderName, 'funções iguais via shim');
  assert(typeof evolutionService.connect === 'function', 'evolutionService.connect (shim deprecado) disponível');
  assert(typeof evolutionService.overview === 'function', 'evolutionService.overview disponível');
  assert(evolutionService.instanceNameFromDatabaseName(tenantName) === whatsappService.instanceNameFromDatabaseName(tenantName), 'instanceName coerente');
});

test('logWhatsapp: auditoria com ação WHATSAPP_* e tenant correto, sem segredos', () => {
  whatsappService.logWhatsapp(whatsappService.LOG_ACTIONS.SETTINGS_UPDATED, tenant.id, { enabled: true });
  const logs = whatsappLogs();
  const last = logs[logs.length - 1];
  assert(last.action === 'WHATSAPP_SETTINGS_UPDATED', 'ação de settings registrada');
  assert(last.tenant_id === tenant.id, 'tenant_id correto no log');
  assert(!JSON.stringify(logs).includes('api_key'), 'api key não vaza em logs');
});

test('processAllTenantsOutbox: processa a fila de todas as empresas', async () => {
  const info = db.prepare(
    `INSERT INTO whatsapp_outbox (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
     VALUES ('APPOINTMENT_CONFIRMED', '5511977779999', 'customer', '{}', 'fila global', 'APPOINTMENT_CONFIRMED:1012', 'PENDING')`
  ).run();
  await whatsappService.processAllTenantsOutbox();
  const row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(info.lastInsertRowid);
  assert(row.status === 'SIMULATED', `worker direto processou (veio ${row.status})`);
});

test('worker start/stop: processa PENDING em intervalo curto e para corretamente', async () => {
  const info = db.prepare(
    `INSERT INTO whatsapp_outbox (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
     VALUES ('APPOINTMENT_COMPLETED', '5511977778888', 'customer', '{}', 'worker', 'APPOINTMENT_COMPLETED:1013', 'PENDING')`
  ).run();

  process.env.WHATSAPP_OUTBOX_ENABLED = 'true';
  process.env.WHATSAPP_OUTBOX_INTERVAL_MS = '30';
  whatsappService.startWorker();
  whatsappService.startWorker();
  await new Promise((resolve) => setTimeout(resolve, 150));
  whatsappService.stopWorker();

  const row = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(info.lastInsertRowid);
  assert(row.status === 'SIMULATED', `worker processou a fila (veio ${row.status})`);
  delete process.env.WHATSAPP_OUTBOX_INTERVAL_MS;
  delete process.env.WHATSAPP_OUTBOX_ENABLED;
});

test('controller: getConnection e connect/reconnect/disconnect via provider MOCK', async () => {
  const state = await callController(whatsappController.getConnection, null, null, null);
  assert(state.result.provider === 'mock' && state.result.mode === 'simulation', 'getConnection reflete MOCK');

  const conn = await callController(whatsappController.connectConnection, null, null, null);
  assert(conn.result.ok === true && conn.result.status === 'connecting', 'connect via controller');
  const rec = await callController(whatsappController.reconnectConnection, null, null, null);
  assert(rec.result.ok === true && rec.result.status === 'connecting', 'reconnect via controller (force)');
  const dis = await callController(whatsappController.disconnectConnection, null, null, null);
  assert(dis.result.status === 'disconnected', 'disconnect via controller');
});

test('testConnection: valida URL+chave via fetchInstances e retorna erro amigável sem URL', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url).replace(/https?:\/\/[^/]+/, ''));
    return { ok: true, status: 200, json: async () => ({ instances: [{ instanceName: 'x', connectionState: 'open' }] }) };
  };
  try {
    const ok = await whatsappService.testConnection({ enabled: true, server_url: 'https://evo.local', api_key: 'chave' });
    assert(ok.ok === true, 'testConnection ok com URL+chave');
    assert(ok.instances.length === 1, 'instância retornada');
    assert(calls.some((c) => c === '/instance/fetchInstances'), 'fetchInstances chamado');
  } finally {
    global.fetch = originalFetch;
  }

  const evoR = await whatsappService.testConnection({ enabled: true, server_url: '', api_key: '' });
  assert(evoR.error === true && /URL e a API key/i.test(evoR.message), 'sem URL → erro amigável');
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testWhatsappModule] DATA_DIR isolado: ${TEST_DIR}`);
  await run();
  try {
    if (db) closeTenantDatabase(tenantName);
  } catch (err) {
    console.error('  aviso ao fechar banco:', err.message);
  }
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  }
  process.exit(failures ? 1 : 0);
})();
