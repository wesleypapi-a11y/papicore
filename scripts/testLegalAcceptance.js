#!/usr/bin/env node
/*
 * testLegalAcceptance.js
 *
 * Testes do aceite obrigatório de Termos de Uso / Aviso de Privacidade no
 * fluxo público de agendamento:
 *   - migração (tabelas legal_documents, appointment_legal_acceptances,
 *     legal_document_versions; colunas ip_address/user_agent; seed 1.0);
 *   - validação: sem legalAcceptance, termsAccepted=false,
 *     privacyAcknowledged=false → 422 LEGAL_ACCEPTANCE_REQUIRED, nenhum
 *     agendamento criado;
 *   - documentos indisponíveis (não publicados) → 422
 *     LEGAL_DOCUMENTS_UNAVAILABLE, nenhum agendamento criado;
 *   - aceite válido → agendamento criado + aceite registrado com as versões
 *     vigentes (o servidor nunca confia em versão enviada pelo cliente);
 *   - falha ao registrar o aceite desfaz o agendamento inteiro (rollback);
 *   - versionamento: nova versão ao editar conteúdo, versão anterior
 *     arquivada com o texto antigo preservado, aceites antigos permanecem
 *     ligados à versão que de fato aceitaram;
 *   - isolamento entre tenants (bancos separados).
 *
 * Roda em DATA_DIR temporário (não toca os dados reais):
 *   node scripts/testLegalAcceptance.js
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
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-legal-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';

const core = require('../database/coreDatabase');
const { openTenantDatabase, closeTenantDatabase, createTenantDatabase, runWithTenant } = require('../database/tenantDatabase');
const appointmentService = require('../services/appointmentService');
const legalDocumentService = require('../services/legalDocumentService');
const agendamentoController = require('../controllers/agendamentoController');
const { toDateStr, addDays } = require('../utils/helpers');

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
      console.error(`  FALHA ${t.name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n        ') : err}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* ---------- Helpers ---------- */

let tenantName = null;
let db = null;
let service = null;
let dayOffset = 1;

function withDb(fn) {
  return runWithTenant(db, fn);
}

function withDbB(fn) {
  return runWithTenant(dbB, fn);
}

/* Cada teste que cria um agendamento usa uma data própria (evita conflito de
   horário entre testes). Pula domingo — fora do expediente padrão da
   empresa (working_days = [1,2,3,4,5,6]) — para não derrubar o teste com
   "Não atendemos nesta data" por coincidência de calendário. */
function nextDate() {
  let d;
  do {
    dayOffset += 1;
    d = addDays(new Date(), dayOffset);
  } while (d.getDay() === 0);
  return toDateStr(d);
}

function pickService(database) {
  const s = database.prepare(
    "SELECT * FROM services WHERE active = 1 AND price_type = 'fixed' AND available_at_unit = 1 ORDER BY id ASC LIMIT 1"
  ).get();
  assert(s, 'tenant precisa de ao menos 1 serviço fixo ativo');
  return s;
}

function appointmentBody(database, svc, extra = {}) {
  const unit = database.prepare('SELECT * FROM units WHERE active = 1 ORDER BY id ASC LIMIT 1').get();
  return {
    modality_id: 1,
    unit_id: unit ? unit.id : null,
    service_ids: [svc.id],
    customer_name: 'Cliente Teste Aceite Legal',
    customer_phone: '(11) 98888-1111',
    customer_email: 'aceite-legal@teste.com.br',
    vehicle_brand: 'Fiat',
    vehicle_model: 'Uno',
    vehicle_year: '2019',
    vehicle_plate: 'XYZ9876',
    vehicle_color: 'Prata',
    vehicle_category: 'passeio',
    appointment_date: nextDate(),
    start_time: '10:00',
    legalAcceptance: { termsAccepted: true, privacyAcknowledged: true },
    ...extra
  };
}

function appointmentCount(database) {
  return database.prepare('SELECT COUNT(*) AS c FROM appointments').get().c;
}

let dbB = null;
let tenantBName = null;

/* ---------- Migração ---------- */

test('initCore + tenant padrão: migração do aceite legal aplicada (tabelas, colunas, seed 1.0)', () => {
  core.initCore();
  const coreTenant = core.getTenantById(1);
  assert(coreTenant, 'tenant padrão existe');
  tenantName = coreTenant.database_name;
  db = openTenantDatabase(tenantName);

  withDb(() => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
       ('legal_documents', 'appointment_legal_acceptances', 'legal_document_versions')`
    ).all().map((r) => r.name);
    for (const t of ['legal_documents', 'appointment_legal_acceptances', 'legal_document_versions']) {
      assert(tables.includes(t), `tabela ${t} deve existir`);
    }

    const acceptanceCols = db.prepare('PRAGMA table_info(appointment_legal_acceptances)').all().map((c) => c.name);
    for (const c of ['appointment_id', 'legal_document_id', 'document_version', 'document_title', 'ip_address', 'user_agent', 'accepted_at']) {
      assert(acceptanceCols.includes(c), `appointment_legal_acceptances deve ter coluna ${c}`);
    }

    const terms = legalDocumentService.getDocumentByKey(db, 'terms');
    const privacy = legalDocumentService.getDocumentByKey(db, 'privacy');
    assert(terms && terms.published === 1 && terms.version === '1.0', 'Termos de Uso publicados na versão 1.0');
    assert(privacy && privacy.published === 1 && privacy.version === '1.0', 'Aviso de Privacidade publicado na versão 1.0');
    assert(/\{\{/.test(terms.content), 'o conteúdo bruto (não renderizado) mantém os placeholders — a substituição só acontece na leitura pública');

    const pub = legalDocumentService.publicDocument(db, 'terms', 'cliente-teste.com.br');
    assert(pub && !/\{\{/.test(pub.content), 'publicDocument substitui todos os placeholders (sem chaves duplas sobrando)');
    assert(!/undefined|null/i.test(pub.content), 'conteúdo publicado nunca contém "undefined"/"null" mesmo com campos ausentes');

    service = pickService(db);
  });
});

/* ---------- Validação obrigatória ---------- */

test('sem legalAcceptance no corpo → 422 LEGAL_ACCEPTANCE_REQUIRED, nenhum agendamento criado', () => {
  withDb(() => {
    const before = appointmentCount(db);
    let err = null;
    try {
      appointmentService.createAppointment(appointmentBody(db, service, { legalAcceptance: undefined }));
    } catch (e) { err = e; }
    assert(err && err.status === 422, `deveria falhar com 422 (veio ${err && err.status})`);
    assert(err.extra && err.extra.code === 'LEGAL_ACCEPTANCE_REQUIRED', `code deveria ser LEGAL_ACCEPTANCE_REQUIRED (veio ${err.extra && err.extra.code})`);
    assert(appointmentCount(db) === before, 'nenhum agendamento deve ser criado');
  });
});

test('termsAccepted=false → 422 LEGAL_ACCEPTANCE_REQUIRED, nenhum agendamento criado', () => {
  withDb(() => {
    const before = appointmentCount(db);
    let err = null;
    try {
      appointmentService.createAppointment(appointmentBody(db, service, {
        legalAcceptance: { termsAccepted: false, privacyAcknowledged: true }
      }));
    } catch (e) { err = e; }
    assert(err && err.status === 422 && err.extra.code === 'LEGAL_ACCEPTANCE_REQUIRED', 'termsAccepted=false deve falhar com 422 LEGAL_ACCEPTANCE_REQUIRED');
    assert(appointmentCount(db) === before, 'nenhum agendamento deve ser criado');
  });
});

test('privacyAcknowledged=false → 422 LEGAL_ACCEPTANCE_REQUIRED, nenhum agendamento criado', () => {
  withDb(() => {
    const before = appointmentCount(db);
    let err = null;
    try {
      appointmentService.createAppointment(appointmentBody(db, service, {
        legalAcceptance: { termsAccepted: true, privacyAcknowledged: false }
      }));
    } catch (e) { err = e; }
    assert(err && err.status === 422 && err.extra.code === 'LEGAL_ACCEPTANCE_REQUIRED', 'privacyAcknowledged=false deve falhar com 422 LEGAL_ACCEPTANCE_REQUIRED');
    assert(appointmentCount(db) === before, 'nenhum agendamento deve ser criado');
  });
});

test('termsAccepted="true" (string, não booleano) → 422 — só aceita exatamente true', () => {
  withDb(() => {
    let err = null;
    try {
      appointmentService.createAppointment(appointmentBody(db, service, {
        legalAcceptance: { termsAccepted: 'true', privacyAcknowledged: true }
      }));
    } catch (e) { err = e; }
    assert(err && err.status === 422 && err.extra.code === 'LEGAL_ACCEPTANCE_REQUIRED', 'string "true" não deve ser aceita como válida');
  });
});

test('documentos indisponíveis (Termos despublicado) → 422 LEGAL_DOCUMENTS_UNAVAILABLE, nenhum agendamento criado', () => {
  withDb(() => {
    const terms = legalDocumentService.getDocumentByKey(db, 'terms');
    legalDocumentService.setPublished(db, terms.id, false);
    const before = appointmentCount(db);
    let err = null;
    try {
      appointmentService.createAppointment(appointmentBody(db, service));
    } catch (e) { err = e; }
    legalDocumentService.setPublished(db, terms.id, true);
    assert(err && err.status === 422, `deveria falhar com 422 (veio ${err && err.status})`);
    assert(err.extra && err.extra.code === 'LEGAL_DOCUMENTS_UNAVAILABLE', `code deveria ser LEGAL_DOCUMENTS_UNAVAILABLE (veio ${err.extra && err.extra.code})`);
    assert(appointmentCount(db) === before, 'nenhum agendamento deve ser criado quando os documentos estão indisponíveis');
  });
});

/* ---------- Aceite válido ---------- */

test('aceite válido cria o agendamento e registra o aceite com as versões vigentes + ip/user-agent', () => {
  withDb(() => {
    const terms = legalDocumentService.getDocumentByKey(db, 'terms');
    const privacy = legalDocumentService.getDocumentByKey(db, 'privacy');

    const appointment = appointmentService.createAppointment(
      appointmentBody(db, service),
      { ip: '203.0.113.42', userAgent: 'TesteAgent/1.0 (script)' }
    );
    assert(appointment && appointment.id > 0, 'agendamento criado');

    const acceptances = legalDocumentService.acceptancesForAppointment(db, appointment.id);
    assert(acceptances.length === 2, `deve haver 2 aceites registrados (veio ${acceptances.length})`);
    const termsAcc = acceptances.find((a) => a.legal_document_id === terms.id);
    const privacyAcc = acceptances.find((a) => a.legal_document_id === privacy.id);
    assert(termsAcc && termsAcc.document_version === '1.0', 'aceite dos Termos com a versão vigente (1.0)');
    assert(privacyAcc && privacyAcc.document_version === '1.0', 'aceite da Privacidade com a versão vigente (1.0)');
    assert(termsAcc.ip_address === '203.0.113.42', 'IP do aceite registrado');
    assert(termsAcc.user_agent === 'TesteAgent/1.0 (script)', 'user-agent do aceite registrado');
  });
});

test('versão enviada pelo cliente é ignorada — o servidor sempre usa a versão vigente do banco', () => {
  withDb(() => {
    const appointment = appointmentService.createAppointment(appointmentBody(db, service, {
      legalAcceptance: {
        termsAccepted: true,
        privacyAcknowledged: true,
        /* campos forjados que um cliente malicioso poderia tentar enviar */
        termsVersion: '99.9',
        privacyVersion: '99.9',
        documentIds: [999999, 999999]
      }
    }));
    const acceptances = legalDocumentService.acceptancesForAppointment(db, appointment.id);
    assert(acceptances.every((a) => a.document_version === '1.0'), 'versão forjada pelo cliente não deve ser usada — sempre 1.0 (a real)');
  });
});

test('falha ao registrar o aceite desfaz o agendamento inteiro (rollback da transação)', () => {
  withDb(() => {
    const before = appointmentCount(db);
    const original = legalDocumentService.recordAcceptances;
    legalDocumentService.recordAcceptances = () => { throw new Error('falha simulada no registro do aceite'); };
    let threw = null;
    try {
      appointmentService.createAppointment(appointmentBody(db, service));
    } catch (e) { threw = e; }
    legalDocumentService.recordAcceptances = original;
    assert(threw && /falha simulada/.test(threw.message), 'o erro do registro do aceite deve propagar');
    assert(appointmentCount(db) === before, 'nenhum agendamento deve ficar salvo quando o registro do aceite falha (rollback completo)');
  });
});

test('controller público (createAppointmentPublic) repassa ip/user-agent do request para o registro do aceite', () => {
  withDb(() => {
    const body = appointmentBody(db, service);
    const req = {
      body,
      ip: '198.51.100.7',
      get: (h) => (String(h).toLowerCase() === 'user-agent' ? 'Mozilla/5.0 (TesteControllerScript)' : undefined),
      protocol: 'https'
    };
    let statusCode = null;
    let payload = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { payload = data; return this; }
    };
    agendamentoController.createAppointmentPublic(req, res);
    assert(statusCode === 201, `controller deve responder 201 (veio ${statusCode})`);
    assert(payload && payload.id, 'controller deve retornar o agendamento criado');
    const acceptances = legalDocumentService.acceptancesForAppointment(db, payload.id);
    assert(acceptances.some((a) => a.ip_address === '198.51.100.7'), 'ip do request chegou ao registro do aceite via o controller público');
    assert(acceptances.some((a) => a.user_agent === 'Mozilla/5.0 (TesteControllerScript)'), 'user-agent do request chegou ao registro do aceite via o controller público');
  });
});

/* ---------- Versionamento ---------- */

test('versionamento: editar o conteúdo cria nova versão, arquiva a anterior com o texto antigo, e aceites antigos continuam com a versão que aceitaram', () => {
  withDb(() => {
    const terms = legalDocumentService.getDocumentByKey(db, 'terms');
    const oldContent = terms.content;

    /* agendamento criado ainda na versão 1.0 */
    const firstAppointment = appointmentService.createAppointment(appointmentBody(db, service));
    const firstAcceptances = legalDocumentService.acceptancesForAppointment(db, firstAppointment.id);
    const firstTermsAcc = firstAcceptances.find((a) => a.legal_document_id === terms.id);
    assert(firstTermsAcc.document_version === '1.0', 'primeiro agendamento aceitou a versão 1.0');

    /* publica a versão 1.1 */
    const updated = legalDocumentService.updateDocument(db, terms.id, { content: oldContent + '\n\nCláusula adicional de teste — versão 1.1.' });
    assert(updated.version === '1.1', `versão deveria virar 1.1 (veio ${updated.version})`);
    assert(updated.published === 1, 'documento continua publicado após a edição');

    const history = legalDocumentService.versionHistory(db, terms.id);
    assert(history.length >= 1, 'deve existir ao menos 1 versão arquivada');
    const archived10 = history.find((h) => h.version === '1.0');
    assert(archived10, 'a versão 1.0 deve estar arquivada');
    assert(archived10.title === terms.title, 'título da versão arquivada preservado');

    const archivedRaw = db.prepare('SELECT content FROM legal_document_versions WHERE legal_document_id = ? AND version = ?').get(terms.id, '1.0');
    assert(archivedRaw.content === oldContent, 'o TEXTO da versão 1.0 foi preservado integralmente no arquivo (não apenas o rótulo da versão)');

    /* segundo agendamento, já na versão 1.1 */
    const secondAppointment = appointmentService.createAppointment(appointmentBody(db, service));
    const secondAcceptances = legalDocumentService.acceptancesForAppointment(db, secondAppointment.id);
    const secondTermsAcc = secondAcceptances.find((a) => a.legal_document_id === terms.id);
    assert(secondTermsAcc.document_version === '1.1', `segundo agendamento deveria aceitar a versão 1.1 (veio ${secondTermsAcc.document_version})`);

    /* o primeiro agendamento CONTINUA ligado à versão que ele de fato aceitou */
    const firstAcceptancesAfter = legalDocumentService.acceptancesForAppointment(db, firstAppointment.id);
    const firstTermsAccAfter = firstAcceptancesAfter.find((a) => a.legal_document_id === terms.id);
    assert(firstTermsAccAfter.document_version === '1.0', 'o aceite do primeiro agendamento não muda retroativamente — continua 1.0');

    /* legal_documents guarda só a versão vigente (uma linha por doc_key) */
    const termsRows = db.prepare('SELECT COUNT(*) AS c FROM legal_documents WHERE doc_key = ?').get('terms').c;
    assert(termsRows === 1, 'continua existindo apenas 1 linha vigente para "terms" em legal_documents');
  });
});

/* ---------- Isolamento entre tenants ---------- */

test('isolamento: um segundo tenant tem documentos e aceites totalmente separados', () => {
  const tenantB = core.insertTenant({
    name: 'Empresa B Teste Legal',
    slug: 'empresa-b-teste-legal',
    database_name: 'tenant_9001_empresa_b_teste_legal.db',
    plan: 'FREE',
    status: 'ACTIVE'
  });
  tenantBName = tenantB.database_name;
  dbB = createTenantDatabase(tenantBName, {
    companyName: 'Empresa B Teste Legal',
    phone: '(21) 99999-0000',
    whatsapp: '(21) 99999-0000',
    fullCatalog: true,
    createDefaultUnit: true
  });

  withDbB(() => {
    const termsB = legalDocumentService.getDocumentByKey(dbB, 'terms');
    assert(termsB && termsB.version === '1.0', 'tenant B começa com Termos na versão 1.0, independente do tenant A já estar em 1.1');

    /* tenant B não tem CNPJ/e-mail/endereço cadastrados (só nome/telefone) —
       o texto gerado deve omitir esses dados, nunca exibir "undefined"/"null". */
    const pubB = legalDocumentService.publicDocument(dbB, 'privacy');
    assert(pubB && !/undefined|null/i.test(pubB.content), 'tenant B: dados empresariais ausentes não geram "undefined"/"null" no texto');
    assert(pubB.content.includes('Empresa B Teste Legal'), 'tenant B: nome da própria empresa aparece no texto (nunca fixo/hardcoded de outro cliente)');

    const svcB = pickService(dbB);
    const apptB = appointmentService.createAppointment(appointmentBody(dbB, svcB));
    const acceptancesB = legalDocumentService.acceptancesForAppointment(dbB, apptB.id);
    assert(acceptancesB.length === 2, 'tenant B registra seus próprios 2 aceites');

    const crossCheck = dbB.prepare('SELECT COUNT(*) AS c FROM appointment_legal_acceptances').get().c;
    assert(crossCheck === 2, 'appointment_legal_acceptances do tenant B só contém os aceites do próprio tenant B (banco de arquivo separado)');
  });

  withDb(() => {
    const termsA = legalDocumentService.getDocumentByKey(db, 'terms');
    assert(termsA.version === '1.1', 'a versão 1.1 do tenant A não vazou/afetou o tenant B');
  });
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testLegalAcceptance] DATA_DIR isolado: ${TEST_DIR}`);
  await run();
  try {
    if (db) closeTenantDatabase(tenantName);
    if (dbB) closeTenantDatabase(tenantBName);
  } catch (err) {
    console.error('  aviso ao fechar banco:', err.message);
  }
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  }
  process.exit(failures ? 1 : 0);
})();
