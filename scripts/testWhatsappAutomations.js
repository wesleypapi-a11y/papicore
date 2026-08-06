#!/usr/bin/env node
/*
 * testWhatsappAutomations.js
 *
 * Testes do módulo WhatsApp (mensagens automáticas, MOCK por padrão):
 *   - migração: tabelas whatsapp_message_templates/whatsapp_outbox, seed de
 *     7 modelos padrão neutros e marco whatsapp_v1;
 *   - criação pública: mensagens ao cliente E à loja (APPOINTMENT_REQUESTED_*);
 *   - confirmação (accept) → APPOINTMENT_CONFIRMED;
 *   - cancelamento → APPOINTMENT_CANCELLED;
 *   - reagendamento (mudança de data/horário na edição) → APPOINTMENT_RESCHEDULED;
 *   - conclusão sem pacote → APPOINTMENT_COMPLETED (veículo pronto, sem saldo);
 *   - conclusão com pacote → APPOINTMENT_COMPLETED_PACKAGE com saldo pós-consumo;
 *   - idempotência (duplo clique não duplica envio);
 *   - falha de envio NÃO desfaz a conclusão (status permanece e entrada
 *     financeira é criada; outbox fica FAILED);
 *   - modelo desativado não gera mensagem;
 *   - placeholders: resolução e rejeição de desconhecidos/HTML/JS;
 *   - modo MOCK não chama nenhuma API externa;
 *   - isolamento de dados entre tenants;
 *   - restauração do modelo padrão e reenvio do histórico.
 *
 * Roda em DATA_DIR temporário (não toca os dados reais):
 *   node scripts/testWhatsappAutomations.js
 *
 * KEEP_DATA_DIR=1 preserva o diretório ao final para inspeção.
 * Código de saída: 0 (ok) ou 1 (falha).
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-whatsapp-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';
process.env.WHATSAPP_ENABLED = 'false';
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;

const core = require('../database/coreDatabase');
const { openTenantDatabase, createTenantDatabase, closeTenantDatabase, runWithTenant } = require('../database/tenantDatabase');
const whatsappService = require('../services/whatsappService');
const whatsappController = require('../controllers/whatsappController');
const packageService = require('../services/packageService');
const adminController = require('../controllers/adminController');
const agendamentoController = require('../controllers/agendamentoController');
const { todayStr, toDateStr, addDays, parseWorkingDays } = require('../utils/helpers');

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
let tenantName = null;

function withDb(fn) {
  return runWithTenant(db, fn);
}

function withDbFor(database, fn) {
  return runWithTenant(database, fn);
}

function tomorrow() {
  return toDateStr(addDays(new Date(), 1));
}

function dayPlus(n) {
  return toDateStr(addDays(new Date(), n));
}

function pickUnit() {
  return db.prepare('SELECT * FROM units WHERE active = 1 ORDER BY id ASC LIMIT 1').get();
}

function pickService() {
  const s = db.prepare(
    "SELECT * FROM services WHERE active = 1 AND price_type = 'fixed' AND available_at_unit = 1 ORDER BY id ASC LIMIT 1"
  ).get();
  assert(s, 'tenant precisa de ao menos 1 serviço fixo ativo');
  return s;
}

let dayCounter = 1;
function nextAppointmentDay() {
  const unit = pickUnit();
  const workingDays = parseWorkingDays(unit ? unit.working_days : '[]');
  for (;;) {
    const d = dayPlus(dayCounter);
    dayCounter += 1;
    const dow = new Date(`${d}T00:00:00`).getDay();
    if (workingDays.length === 0 || workingDays.includes(dow)) return d;
  }
}

function appointmentBody(extra = {}) {
  const unit = pickUnit();
  const service = pickService();
  return {
    modality_id: 1,
    unit_id: unit ? unit.id : null,
    service_ids: [service.id],
    customer_name: 'Cliente WhatsApp',
    customer_phone: '(11) 98888-7777',
    customer_email: 'wa@teste.com.br',
    customer_cpf: null,
    vehicle_brand: 'Honda',
    vehicle_model: 'Civic',
    vehicle_year: '2022',
    vehicle_plate: 'WAT1234',
    vehicle_color: 'Preto',
    vehicle_category: 'sedan',
    appointment_date: nextAppointmentDay(),
    start_time: '09:00',
    ...extra
  };
}

function callController(fn, params, body, user) {
  let result;
  const req = {
    body: body || {},
    params: params || {},
    query: {},
    user: user || { id: 999, name: 'Teste', role: 'owner' },
    protocol: 'https',
    get: (h) => (h === 'host' ? 'wa.test.local' : undefined)
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
  withDb(() => {
    fn(req, res);
  });
  return { result, status: res.statusCode };
}

function outboxFor(db, eventKey, appointmentId) {
  return db.prepare('SELECT * FROM whatsapp_outbox WHERE event_key = ? AND idempotency_key = ? ORDER BY id ASC')
    .all(eventKey, `${eventKey}:${appointmentId}`);
}

function allOutbox(db) {
  return db.prepare('SELECT * FROM whatsapp_outbox ORDER BY id ASC').all();
}

/* Processa a fila explicitamente — a fila automática roda via setImmediate e
   pode ainda não ter executado quando a asserção roda. */
async function flush(db) {
  return whatsappService.processOutbox({ db });
}

/* ---------- Testes ---------- */

test('migração: tabelas de WhatsApp + 7 modelos padrão + marco whatsapp_v1', () => {
  core.initCore();
  const coreTenant = core.getTenantById(1);
  assert(coreTenant, 'tenant padrão torque-detail existe');
  tenantName = coreTenant.database_name;
  db = openTenantDatabase(tenantName);

  withDb(() => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('whatsapp_message_templates', 'whatsapp_outbox')`
    ).all().map((r) => r.name);
    assert(tables.includes('whatsapp_message_templates'), 'tabela whatsapp_message_templates existe');
    assert(tables.includes('whatsapp_outbox'), 'tabela whatsapp_outbox existe');

    const marker = db.prepare("SELECT name FROM schema_migrations WHERE name = 'whatsapp_v1'").get();
    assert(marker, 'migração whatsapp_v1 registrada em schema_migrations');

    const templates = db.prepare('SELECT * FROM whatsapp_message_templates ORDER BY id ASC').all();
    assert(templates.length === 7, `7 modelos padrão (veio ${templates.length})`);
    const keys = templates.map((t) => t.event_key);
    for (const k of [
      'APPOINTMENT_REQUESTED_CUSTOMER',
      'APPOINTMENT_REQUESTED_STORE',
      'APPOINTMENT_CONFIRMED',
      'APPOINTMENT_CANCELLED',
      'APPOINTMENT_RESCHEDULED',
      'APPOINTMENT_COMPLETED',
      'APPOINTMENT_COMPLETED_PACKAGE'
    ]) {
      assert(keys.includes(k), `modelo ${k} presente`);
    }
    for (const t of templates) {
      assert(t.enabled === 1, `${t.event_key} habilitado por padrão`);
      assert(t.content && t.content.trim().length > 0, `${t.event_key} com conteúdo`);
    }
  });
});

test('criação pública: mensagens ao cliente E à loja, simuladas no MOCK', async () => {
  const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody());
  const appt = created.result;
  assert(appt && appt.id, 'agendamento criado pelo site público');
  assert(created.status === 201, 'resposta 201');

  await flush(db);

  const toCustomer = outboxFor(db, 'APPOINTMENT_REQUESTED_CUSTOMER', appt.id);
  const toStore = outboxFor(db, 'APPOINTMENT_REQUESTED_STORE', appt.id);
  assert(toCustomer.length === 1, 'uma mensagem ao cliente');
  assert(toStore.length === 1, 'uma mensagem à loja');
  assert(toCustomer[0].status === 'SIMULATED', `cliente simulada (veio ${toCustomer[0].status})`);
  assert(toStore[0].status === 'SIMULATED', `loja simulada (veio ${toStore[0].status})`);
  assert(toCustomer[0].recipient_kind === 'customer', 'destinatário = cliente');
  assert(toStore[0].recipient_kind === 'store', 'destinatário = loja');
  assert(toCustomer[0].recipient, 'cliente tem telefone no destinatário');
  assert(toStore[0].recipient, 'loja tem telefone no destinatário');
  const text = toCustomer[0].message_text || '';
  assert(text.includes('solicitação de agendamento foi recebida'), 'mensagem ao cliente é de solicitação');
  assert(text.includes(appt.appointment_code), 'mensagem contém o código');
});

test('confirmação (aceitar) → APPOINTMENT_CONFIRMED simulada', async () => {
  const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-1111' }));
  const appt = created.result;
  await flush(db);

  const accepted = callController(adminController.acceptAppointment, { id: appt.id }, null);
  assert(accepted.result.status === 'confirmed', 'agendamento confirmado');
  await flush(db);

  const rows = outboxFor(db, 'APPOINTMENT_CONFIRMED', appt.id);
  assert(rows.length === 1, `uma confirmação (veio ${rows.length})`);
  assert(rows[0].status === 'SIMULATED', `status simulada (veio ${rows[0].status})`);
  assert((rows[0].message_text || '').includes('confirmado'), 'mensagem de confirmação');
});

test('cancelamento → APPOINTMENT_CANCELLED simulada', async () => {
  const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-2222' }));
  const appt = created.result;
  await flush(db);

  const cancelled = callController(adminController.updateStatus, { id: appt.id }, { status: 'cancelled' });
  assert(cancelled.result.status === 'cancelled', 'agendamento cancelado');
  await flush(db);

  const rows = outboxFor(db, 'APPOINTMENT_CANCELLED', appt.id);
  assert(rows.length === 1, `um cancelamento (veio ${rows.length})`);
  assert(rows[0].status === 'SIMULATED', 'simulada');
  assert((rows[0].message_text || '').includes('cancelado'), 'mensagem de cancelamento');
});

test('reagendamento: edição com data/horário diferentes → APPOINTMENT_RESCHEDULED', async () => {
  const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-3333' }));
  const appt = created.result;
  await flush(db);

  const newDay = nextAppointmentDay();
  const body = appointmentBody({ customer_phone: '(11) 97777-3333', appointment_date: newDay, start_time: '14:00', status: 'pending' });
  const updated = callController(adminController.updateAppointment, { id: appt.id }, body);
  assert(updated.result.id === appt.id, 'agendamento atualizado');
  assert(updated.result.appointment_date === newDay, 'data nova aplicada');
  await flush(db);

  const rows = outboxFor(db, 'APPOINTMENT_RESCHEDULED', appt.id);
  assert(rows.length === 1, `um reagendamento (veio ${rows.length})`);
  assert(rows[0].status === 'SIMULATED', 'simulada');
  assert((rows[0].message_text || '').includes('reagendado'), 'mensagem de reagendamento');
  assert((rows[0].message_text || '').includes(newDay.split('-').reverse().join('/')), 'mensagem tem a data nova');
});

test('conclusão sem pacote → APPOINTMENT_COMPLETED (veículo pronto, sem saldo)', async () => {
  const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-4444' }));
  const appt = created.result;
  await flush(db);

  const done = callController(adminController.updateStatus, { id: appt.id }, { status: 'completed' });
  assert(done.result.status === 'completed', 'concluído');
  await flush(db);

  const rows = outboxFor(db, 'APPOINTMENT_COMPLETED', appt.id);
  assert(rows.length === 1, `uma conclusão (veio ${rows.length})`);
  assert(rows[0].status === 'SIMULATED', 'simulada');
  const text = rows[0].message_text || '';
  assert(text.includes('pronto'), 'mensagem de veículo pronto');
  assert(!text.includes('Saldo restante'), 'sem bloco de saldo (não é pacote)');

  const entry = db.prepare('SELECT * FROM financial_entries WHERE appointment_id = ? AND type = ?').get(appt.id, 'entrada');
  assert(entry, 'entrada financeira criada na conclusão');
});

test('conclusão com pacote → APPOINTMENT_COMPLETED_PACKAGE com saldo pós-consumo', async () => {
  const service = pickService();
  const pkg = withDb(() => packageService.createServicePackage(db, {
    name: 'Pacote WA',
    price: '150,00',
    items: [{ service_id: service.id, quantity: 3 }]
  }, 1));
  const sold = withDb(() => packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Pacote WA', phone: '(11) 96666-9999' } }, 1));

  const created = callController(adminController.createAppointment, null,
    appointmentBody({ customer_package_id: sold.id, customer_phone: '(11) 96666-9999', status: 'pending' }));
  const appt = created.result;
  assert(appt.package_credit_status === 'RESERVED', 'crédito reservado na criação');
  await flush(db);

  const done = callController(adminController.updateStatus, { id: appt.id }, { status: 'completed' });
  assert(done.result.status === 'completed', 'concluído');
  assert(done.result.package_credit_status === 'CONSUMED', 'crédito consumido');
  await flush(db);

  /* Não é conclusão comum: o evento de pacote é separado. */
  const normal = outboxFor(db, 'APPOINTMENT_COMPLETED', appt.id);
  assert(normal.length === 0, 'sem evento de conclusão comum');
  const rows = outboxFor(db, 'APPOINTMENT_COMPLETED_PACKAGE', appt.id);
  assert(rows.length === 1, `uma conclusão de pacote (veio ${rows.length})`);
  assert(rows[0].status === 'SIMULATED', 'simulada');
  const text = rows[0].message_text || '';
  assert(text.includes('Saldo restante do seu pacote'), 'bloco de saldo presente');
  assert(text.includes('2 disponíveis'), `saldo pós-consumo (3-1=2) presente (veio: ${text})`);
});

test('idempotência: duplo clique na conclusão não duplica o envio', async () => {
  const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-5555' }));
  const appt = created.result;
  await flush(db);

  callController(adminController.updateStatus, { id: appt.id }, { status: 'completed' });
  /* segunda chamada: transição já não existe → nada é enfileirado de novo */
  callController(adminController.updateStatus, { id: appt.id }, { status: 'completed' });
  await flush(db);

  const rows = outboxFor(db, 'APPOINTMENT_COMPLETED', appt.id);
  assert(rows.length === 1, `uma única mensagem de conclusão (veio ${rows.length})`);
});

test('falha de envio NÃO desfaz a conclusão (outbox fica FAILED, agendamento concluído)', async () => {
  const originalFetch = global.fetch;
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHATSAPP_TOKEN = 'token-invalido';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'id-invalido';
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'Invalid token' } })
  });

  try {
    const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-6666' }));
    const appt = created.result;
    await flush(db);

    const done = callController(adminController.updateStatus, { id: appt.id }, { status: 'completed' });
    assert(done.result.status === 'completed', 'agendamento continua concluído mesmo com falha de WhatsApp');
    await flush(db);

    const rows = outboxFor(db, 'APPOINTMENT_COMPLETED', appt.id);
    assert(rows.length === 1, 'mensagem de conclusão enfileirada');
    assert(rows[0].status === 'FAILED', `envio falhou (veio ${rows[0].status})`);
    assert(rows[0].last_error && rows[0].last_error.length > 0, 'erro registrado no histórico');
    assert(rows[0].attempts >= 1, 'tentativa registrada');

    const entry = db.prepare('SELECT * FROM financial_entries WHERE appointment_id = ? AND type = ?').get(appt.id, 'entrada');
    assert(entry, 'entrada financeira NÃO é desfeita pela falha de WhatsApp');
  } finally {
    process.env.WHATSAPP_ENABLED = 'false';
    delete process.env.WHATSAPP_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    global.fetch = originalFetch;
  }
});

test('modelo desativado → nenhuma mensagem é enfileirada', async () => {
  withDb(() => {
    db.prepare("UPDATE whatsapp_message_templates SET enabled = 0 WHERE event_key = 'APPOINTMENT_CONFIRMED'").run();
  });
  const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-7777' }));
  const appt = created.result;
  await flush(db);
  callController(adminController.acceptAppointment, { id: appt.id }, null);
  await flush(db);

  const rows = outboxFor(db, 'APPOINTMENT_CONFIRMED', appt.id);
  assert(rows.length === 0, `nenhuma confirmação (veio ${rows.length})`);
  withDb(() => {
    db.prepare("UPDATE whatsapp_message_templates SET enabled = 1 WHERE event_key = 'APPOINTMENT_CONFIRMED'").run();
  });
});

test('placeholders: resolução no texto e rejeição de desconhecidos/HTML/JS/chaves soltas', () => {
  withDb(() => {
    const values = whatsappService.resolvePlaceholders('APPOINTMENT_CONFIRMED', {
      customer_name: 'João',
      appointment_code: 'ABC123',
      appointment_date: '2026-08-10',
      start_time: '09:00',
      end_time: '10:00',
      booked_duration_minutes: 60,
      service_name: 'Lavagem completa',
      vehicle_brand: 'Fiat',
      vehicle_model: 'Argo',
      vehicle_year: '2020',
      unit_name: 'Unidade Centro',
      modality_name: 'Lavagem na unidade',
      total_price: 80,
      payment_method: 'pix',
      customer_package_id: null
    }, { companyName: 'Empresa Teste' });

    assert(values.CLIENTE_NOME === 'João', 'CLIENTE_NOME resolvido');
    assert(values.DATA_AGENDAMENTO === '10/08/2026', 'DATA_AGENDAMENTO em formato BR');
    assert(values.VALOR === 'R$ 80,00', `VALOR formatado (veio ${values.VALOR})`);
    assert(values.VEICULO.includes('Fiat Argo'), 'VEICULO resolvido');

    const rendered = whatsappService.renderTemplate('Olá {{CLIENTE_NOME}}, dia {{DATA_AGENDAMENTO}}', values);
    assert(rendered === 'Olá João, dia 10/08/2026', `renderização (veio: ${rendered})`);

    /* validação do modelo */
    assert(whatsappService.validateTemplateContent('Olá {{CLIENTE_NOME}}!') === 'Olá {{CLIENTE_NOME}}!', 'conteúdo válido passa');

    let threw = null;
    try { whatsappService.validateTemplateContent('Olá {{CLIENTE}}'); } catch (e) { threw = e; }
    assert(threw && /desconhecido/i.test(threw.message), `placeholder desconhecido rejeitado (${threw && threw.message})`);

    threw = null;
    try { whatsappService.validateTemplateContent('<b>oi</b>'); } catch (e) { threw = e; }
    assert(threw && /inseguro|HTML/i.test(threw.message), `HTML rejeitado (${threw && threw.message})`);

    threw = null;
    try { whatsappService.validateTemplateContent('Clique <script>alert(1)</script>'); } catch (e) { threw = e; }
    assert(threw && /inseguro|HTML/i.test(threw.message), `JavaScript rejeitado (${threw && threw.message})`);

    threw = null;
    try { whatsappService.validateTemplateContent('{{CLIENTE_NOME'); } catch (e) { threw = e; }
    assert(threw && /formato/i.test(threw.message), `chaves soltas rejeitadas (${threw && threw.message})`);

    threw = null;
    try { whatsappService.validateTemplateContent('   '); } catch (e) { threw = e; }
    assert(threw && /vazio/i.test(threw.message), `conteúdo vazio rejeitado (${threw && threw.message})`);
  });
});

test('modo MOCK: nenhuma chamada a API externa', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'msg-1' }] }) };
  };

  try {
    const created = callController(agendamentoController.createAppointmentPublic, null, appointmentBody({ customer_phone: '(11) 97777-8888' }));
    const appt = created.result;
    await flush(db);
    callController(adminController.updateStatus, { id: appt.id }, { status: 'completed' });
    await flush(db);

    assert(fetchCalls === 0, `MOCK não deve chamar fetch (chamadas: ${fetchCalls})`);
    const rows = allOutbox(db).filter((r) => r.status === 'SIMULATED');
    assert(rows.length >= 2, 'mensagens simuladas registradas');
  } finally {
    global.fetch = originalFetch;
  }
});

test('isolamento entre tenants: outbox de A não vaza para B', async () => {
  const dbB = createTenantDatabase('tenant_0002_isolado.db', { companyName: 'Empresa B' });

  let createdCountA;
  withDb(() => {
    const res = whatsappService.enqueueEvent('APPOINTMENT_CONFIRMED', {
      id: 770001,
      customer_phone: '(11) 97777-0001',
      appointment_code: 'WA-ISO',
      appointment_date: '2026-08-12',
      start_time: '09:00',
      end_time: '10:00',
      customer_name: 'Isolamento',
      service_name: 'Teste',
      vehicle_brand: 'A',
      vehicle_model: 'B',
      total_price: 0,
      customer_package_id: null
    });
    assert(res.skipped !== true, 'enqueue em A ok');
  });
  await flush(db);
  createdCountA = withDb(() => allOutbox(db).length);
  assert(createdCountA >= 1, `A tem mensagens (veio ${createdCountA})`);

  const countB = withDbFor(dbB, () => dbB.prepare('SELECT COUNT(*) AS total FROM whatsapp_outbox').get().total);
  assert(countB === 0, `B não tem nenhuma mensagem (veio ${countB})`);

  const templatesB = withDbFor(dbB, () => dbB.prepare('SELECT COUNT(*) AS total FROM whatsapp_message_templates').get().total);
  assert(templatesB === 7, `B também nasce com 7 modelos (veio ${templatesB})`);

  closeTenantDatabase('tenant_0002_isolado.db');
});

test('admin: listar modelos, restaurar padrão e reenviar do histórico', async () => {
  withDb(() => {
    /* salva conteúdo válido mas diferente do padrão */
    callController(whatsappController.updateTemplate, { eventKey: 'APPOINTMENT_CANCELLED' }, {
      content: 'Cancelado — {{CLIENTE_NOME}} ({{CODIGO_AGENDAMENTO}})',
      enabled: true
    });
    const row = db.prepare("SELECT * FROM whatsapp_message_templates WHERE event_key = 'APPOINTMENT_CANCELLED'").get();
    assert((row.content || '').includes('Cancelado'), 'modelo editado');

    /* restaura o padrão */
    callController(whatsappController.restoreTemplate, { eventKey: 'APPOINTMENT_CANCELLED' }, null);
    const restored = db.prepare("SELECT * FROM whatsapp_message_templates WHERE event_key = 'APPOINTMENT_CANCELLED'").get();
    const def = whatsappService.DEFAULT_TEMPLATES.find((t) => t.event_key === 'APPOINTMENT_CANCELLED');
    assert(restored.content === def.content, 'modelo padrão restaurado');
    assert(restored.enabled === 1, 'restaurado fica habilitado');

    /* reenvio: linha FAILED volta a ser processada (vira SIMULADA no MOCK) */
    const info = db.prepare(
      `INSERT INTO whatsapp_outbox (event_key, recipient, recipient_kind, payload_json, message_text, idempotency_key, status)
       VALUES (?, ?, 'customer', ?, ?, ?, 'FAILED')`
    ).run('APPOINTMENT_CONFIRMED', '11999990000', '{}', 'teste reenvio', 'WA-RESEND:90001');
    const res = whatsappService.resendOutbox(db, info.lastInsertRowid);
    assert(res && res.status === 'PENDING', 'linha resetada para PENDING');
    return whatsappService.processOutbox({ db }).then(() => {
      const after = db.prepare('SELECT * FROM whatsapp_outbox WHERE id = ?').get(info.lastInsertRowid);
      assert(after.status === 'SIMULATED', `reenvio vira SIMULADA no MOCK (veio ${after.status})`);
    });
  });
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testWhatsappAutomations] DATA_DIR isolado: ${TEST_DIR}`);
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
