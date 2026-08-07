#!/usr/bin/env node
/*
 * testEvolutionApi.js
 *
 * Testes da integração Evolution API (WhatsApp real):
 *   - migração: tabelas core evolution_settings/evolution_instances + marco;
 *   - MOCK preservado: sem Evolution habilitada, o envio continua simulado e
 *     nenhuma API externa é chamada;
 *   - settings globais: salvar/ler, máscara da API key, validação de URL;
 *   - teste de conexão (fetchInstances) com stub de rede;
 *   - connect: cria instância + QR e registra em evolution_instances;
 *   - reconnect (force) gera novo QR; disconnect remove o registro;
 *   - refreshStatus marca connected com número do dono quando a Evolution
 *     responde "open";
 *   - envio real via whatsappService.processOne passa pela Evolution;
 *   - isolamento por tenant no registro core.
 *
 * Roda em DATA_DIR temporário (não toca os dados reais):
 *   node scripts/testEvolutionApi.js
 *
 * Código de saída: 0 (ok) ou 1 (falha).
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-evo-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';
process.env.WHATSAPP_ENABLED = 'false';
delete process.env.WHATSAPP_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
delete process.env.EVOLUTION_ENABLED;
delete process.env.EVOLUTION_SERVER_URL;
delete process.env.EVOLUTION_API_KEY;

const core = require('../database/coreDatabase');
const { openTenantDatabase, closeTenantDatabase, runWithTenant } = require('../database/tenantDatabase');
const evolutionService = require('../services/evolutionService');
const whatsappService = require('../services/whatsappService');
const whatsappController = require('../controllers/whatsappController');
const developerController = require('../controllers/developerController');

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

const EVO_URL = 'https://evo.teste.local';
const EVO_KEY = 'evo-api-key-teste';
let INSTANCE = 'tenant_0001_torque_detail';

function callController(fn, params, body, user, tenantOverride) {
  let result;
  const req = {
    body: body || {},
    params: params || {},
    query: {},
    user: user || { id: 1, name: 'Dev', role: 'developer' },
    tenant: tenantOverride || tenant
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
  return new Promise((resolve, reject) => {
    runWithTenant(db, async () => {
      try {
        await fn(req, res);
        resolve({ result, status: res.statusCode });
      } catch (err) {
        reject(err);
      }
    });
  });
}

function enableEvolution() {
  core.upsertEvolutionSettings({ enabled: true, server_url: EVO_URL, api_key: EVO_KEY });
}

process.env.PAPICORE_PUBLIC_URL = 'https://papicore.example.com';

function disableEvolution() {
  core.upsertEvolutionSettings({ enabled: false, server_url: '', api_key: '' });
}

/* Nova arquitetura: a Evolution SÓ é ativada com WHATSAPP_ENABLED=true
   (regra de segurança — "Evolution JAMAIS executa sem WHATSAPP_ENABLED=true").
   Os cenários de Evolution ligam aqui dentro de try/finally e restauram
   WHATSAPP_ENABLED=false ao final. */
function setRealProvider(on) {
  process.env.WHATSAPP_ENABLED = on ? 'true' : 'false';
  if (on) enableEvolution(); else disableEvolution();
}

/* Stub de rede: roteia pelos caminhos da Evolution API. */
function stubFetch(router, calls) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const pathname = String(url).replace(/https?:\/\/[^/]+/, '');
    calls.push({ url: pathname, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
    const handler = router[pathname];
    if (!handler) {
      return { ok: false, status: 404, json: async () => ({ response: { message: 'endpoint desconhecido' } }) };
    }
    return handler(pathname, opts);
  };
  return () => { global.fetch = original; };
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

function connectionState(req, res) {
  return whatsappController.getConnection(req, res);
}
function connectConnection(req, res) {
  return whatsappController.connectConnection(req, res);
}
function disconnectConnection(req, res) {
  return whatsappController.disconnectConnection(req, res);
}

/* ---------- Testes ---------- */

test('migração: tabelas evolution no core + marco evolution_v1', () => {
  core.initCore();
  tenant = core.getTenantById(1);
  assert(tenant, 'tenant padrão existe');
  tenantName = tenant.database_name;
  INSTANCE = evolutionService.instanceNameFromDatabaseName(tenantName);
  db = openTenantDatabase(tenantName);

  const tables = core.getCoreDb().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('evolution_settings', 'evolution_instances')`
  ).all().map((r) => r.name);
  assert(tables.includes('evolution_settings'), 'tabela evolution_settings existe');
  assert(tables.includes('evolution_instances'), 'tabela evolution_instances existe');

  const marker = core.getCoreDb().prepare("SELECT name FROM schema_migrations WHERE name = 'evolution_v1'").get();
  assert(marker, 'migração evolution_v1 registrada em schema_migrations');
});

test('MOCK preservado: sem Evolution, envio continua simulado sem fetch', async () => {
  disableEvolution();
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; return jsonResponse({}); };

  try {
    const status = whatsappService.getStatus();
    assert(status.mock === true, `mock ativo (veio ${JSON.stringify(status)})`);
    assert(status.evolution && status.evolution.enabled === false, 'evolution desativada');

    let enqueued;
    runWithTenant(db, () => {
      enqueued = whatsappService.enqueueEvent('APPOINTMENT_CONFIRMED', {
        id: 888001,
        customer_phone: '(11) 97777-8888',
        appointment_code: 'EVO-MOCK',
        appointment_date: '2026-08-12',
        start_time: '09:00',
        end_time: '10:00',
        customer_name: 'Mock',
        service_name: 'Teste',
        vehicle_brand: 'A',
        vehicle_model: 'B',
        total_price: 0,
        customer_package_id: null
      });
    });
    assert(enqueued.skipped !== true, 'mensagem enfileirada no MOCK');
    await whatsappService.processOutbox({ db });
    const row = db.prepare('SELECT * FROM whatsapp_outbox WHERE idempotency_key = ?').get('APPOINTMENT_CONFIRMED:888001');
    assert(row && row.status === 'SIMULATED', `simulada no MOCK (veio ${row && row.status})`);
    assert(fetchCalls === 0, `MOCK não chama fetch (chamadas: ${fetchCalls})`);
  } finally {
    global.fetch = originalFetch;
  }
});

test('settings: salvar, máscara da API key e validação de URL', async () => {
  const r = await callController(developerController.updateEvolutionSettingsHandler, null, {
    enabled: true,
    server_url: EVO_URL,
    api_key: EVO_KEY
  });
  assert(r.result.enabled === true, 'enabled salvo');
  assert(r.result.server_url === EVO_URL, 'url salva');
  assert(r.result.api_key === '••••••••', `api key mascarada na resposta (veio ${r.result.api_key})`);
  assert(core.getEvolutionSettings().api_key === EVO_KEY, 'api key real guardada no banco');

  /* URL inválida é rejeitada */
  let threw = null;
  try {
    await callController(developerController.updateEvolutionSettingsHandler, null, { server_url: 'nao-e-url' });
  } catch (e) { threw = e; }
  assert(threw && /http/i.test(threw.message), `URL inválida rejeitada (${threw && threw.message})`);
});

test('teste de conexão: valida URL + chave via fetchInstances', async () => {
  const calls = [];
  const restore = stubFetch({
    '/instance/fetchInstances': () => jsonResponse({ instances: [{ instanceName: 'torque-detail', connectionState: 'open' }] })
  }, calls);

  try {
    const r = await callController(developerController.testEvolutionConnectionHandler, null, {
      server_url: EVO_URL,
      api_key: EVO_KEY
    });
    assert(r.result.ok === true, 'conexão ok');
    assert(r.result.instances.length === 1, 'instância retornada');
    assert(calls.some((c) => c.url === '/instance/fetchInstances'), 'fetchInstances chamado');
  } finally {
    restore();
  }

  const calls2 = [];
  const restore2 = stubFetch({}, calls2);
  try {
    const r = await callController(developerController.testEvolutionConnectionHandler, null, {
      server_url: EVO_URL,
      api_key: 'chave-errada'
    });
    assert(r.result.ok !== true, 'chave errada falha');
  } finally {
    restore2();
  }
});

test('connect: cria instância, obtém QR e registra no core', async () => {
  enableEvolution();
  process.env.WHATSAPP_ENABLED = 'true';
  const calls = [];
  const restore = stubFetch({
    '/instance/create': () => jsonResponse({ instance: { instanceName: INSTANCE, status: 'close' } }),
    '/instance/connect/tenant_0001_torque_detail': () => jsonResponse({ qrcode: 'data:image/png;base64,QR1' }),
    '/webhook/set/tenant_0001_torque_detail': () => jsonResponse({})
  }, calls);

  try {
    const result = await evolutionService.connect(tenant);
    assert(result.ok === true, 'connect ok');
    assert(result.qr === 'data:image/png;base64,QR1', 'QR retornado');
    assert(calls.some((c) => c.url === '/instance/create'), 'create chamado (POST /instance/create v2)');
    assert(calls.some((c) => c.url === '/instance/connect/tenant_0001_torque_detail'), 'connect/QR chamado');
    assert(calls.some((c) => c.url === '/webhook/set/tenant_0001_torque_detail'), 'webhook/set chamado');

    const row = core.getEvolutionInstance(tenant.id);
    assert(row, 'registro criado');
    assert(row.instance_name === INSTANCE, `nome da instância (veio ${row.instance_name})`);
    assert(row.status === 'connecting', `status connecting (veio ${row.status})`);
    assert(row.qr_base64 === 'data:image/png;base64,QR1', 'QR gravado no registro');

    const state = evolutionService.connectionState(tenant);
    assert(state.status === 'connecting' && state.qr, 'connectionState expõe QR ao painel');
  } finally {
    restore();
    process.env.WHATSAPP_ENABLED = 'false';
  }
});

test('admin: conexão do cliente reflete QR e actions connect/disconnect', async () => {
  process.env.WHATSAPP_ENABLED = 'true';
  const calls = [];
  const restore = stubFetch({
    '/instance/connect/tenant_0001_torque_detail': () => jsonResponse({ qrcode: 'data:image/png;base64,QR2' }),
    '/webhook/set/tenant_0001_torque_detail': () => jsonResponse({}),
    '/instance/logout/tenant_0001_torque_detail': () => jsonResponse({})
  }, calls);

  try {
    const state = await callController(connectionState, null, null, null);
    assert(state.result.status === 'connecting' && state.result.qr, `admin vê QR (veio ${state.result.status})`);

    /* desconecta via admin */
    const dis = await callController(disconnectConnection, null, null, null);
    assert(dis.result.status === 'disconnected', 'desconectado');
    const row = core.getEvolutionInstance(tenant.id);
    assert(row && row.status === 'disconnected' && !row.qr_base64, 'registro mantido com status disconnected e QR limpo');
    assert(calls.some((c) => c.url === '/instance/logout/tenant_0001_torque_detail'), 'logout remoto chamado');

    /* reconecta via admin */
    const conn = await callController(connectConnection, null, null, null);
    assert(conn.result.qr === 'data:image/png;base64,QR2', 'novo QR pelo admin');
    assert(core.getEvolutionInstance(tenant.id).qr_base64 === 'data:image/png;base64,QR2', 'QR registrado');
  } finally {
    restore();
    process.env.WHATSAPP_ENABLED = 'false';
  }
});

test('refreshStatus: Evolution responde "open" → connected com número', async () => {
  process.env.WHATSAPP_ENABLED = 'true';
  const calls = [];
  const restore = stubFetch({
    '/instance/connectionState/tenant_0001_torque_detail': () => jsonResponse({ instance: { instanceName: INSTANCE, state: 'open', number: '5511999998888', name: 'Empresa' } })
  }, calls);

  try {
    const out = await evolutionService.refreshStatus(tenant);
    assert(out.status === 'connected', `refresh marcou connected (veio ${out.status})`);
    const row = core.getEvolutionInstance(tenant.id);
    assert(row.status === 'connected', `status no registro (veio ${row.status})`);
    assert(row.owner_number === '5511999998888', 'número do dono salvo');
    assert(!row.qr_base64, 'QR limpo após conectar');

    const state = evolutionService.connectionState(tenant);
    assert(state.status === 'connected', 'painel admin vê connected');
  } finally {
    restore();
    process.env.WHATSAPP_ENABLED = 'false';
  }
});

test('envio real: processOne passa pela Evolution e marca SENT', async () => {
  enableEvolution();
  process.env.WHATSAPP_ENABLED = 'true';
  const calls = [];
  const restore = stubFetch({
    '/message/sendText/tenant_0001_torque_detail': () => jsonResponse({ key: { id: 'EVO-MSG-1' } })
  }, calls);

  try {
    let enqueued;
    runWithTenant(db, () => {
      enqueued = whatsappService.enqueueEvent('APPOINTMENT_CONFIRMED', {
        id: 888002,
        customer_phone: '(11) 97777-0002',
        appointment_code: 'EVO-REAL',
        appointment_date: '2026-08-12',
        start_time: '09:00',
        end_time: '10:00',
        customer_name: 'Real',
        service_name: 'Teste',
        vehicle_brand: 'A',
        vehicle_model: 'B',
        total_price: 0,
        customer_package_id: null
      });
    });
    assert(enqueued.skipped !== true, 'enfileirada');
    await whatsappService.processOutbox({ db });
    const row = db.prepare('SELECT * FROM whatsapp_outbox WHERE idempotency_key = ?').get('APPOINTMENT_CONFIRMED:888002');
    assert(row.status === 'SENT', `enviada de verdade (veio ${row.status})`);
    assert(row.sent_at, 'sent_at preenchido');

    const sendCall = calls.find((c) => c.url === '/message/sendText/tenant_0001_torque_detail');
    assert(sendCall, 'sendText chamado na instância certa');
    assert(sendCall.body.number === '5511977770002', `número normalizado (veio ${sendCall.body.number})`);
    assert((sendCall.body.text || '').includes('EVO-REAL'), 'texto renderizado enviado');
  } finally {
    restore();
    process.env.WHATSAPP_ENABLED = 'false';
    disableEvolution();
  }
});

test('isolamento por tenant: registro da instância é único por empresa', () => {
  const rows = core.getCoreDb().prepare('SELECT COUNT(*) AS total FROM evolution_instances WHERE tenant_id = ?').get(tenant.id);
  assert(rows.total === 1, `uma instância para o tenant (veio ${rows.total})`);

  assert(!core.getEvolutionInstance(9999), 'tenant inexistente não tem registro');
  assert(!core.getEvolutionInstanceByDatabaseName('banco_inexistente.db'), 'banco desconhecido não encontra instância');

  const overview = evolutionService.overview();
  assert(Array.isArray(overview.instances), 'overview lista instâncias');
  assert(overview.instances.length >= 1, 'pelo menos uma empresa no overview');
  const mine = overview.instances.find((i) => i.tenant_id === tenant.id);
  assert(mine && mine.status === 'connected', 'overview reflete o status');
});

test('developer overview: visão geral com empresas e instâncias', async () => {
  enableEvolution();
  process.env.WHATSAPP_ENABLED = 'true';
  const r = await callController(developerController.whatsappOverviewHandler, null, null);
  assert(r.result.enabled === true, 'enabled no overview');
  assert(r.result.api_key === '••••••••', 'chave mascarada no overview');
  assert(Array.isArray(r.result.instances), 'instâncias no overview');
  assert(r.result.whatsapp && r.result.whatsapp.provider === 'evolution', 'provider evolution quando ativa');
  assert(r.result.whatsapp.mock === false, 'não é mock quando evolution ativa');
  process.env.WHATSAPP_ENABLED = 'false';
});

test('disconnect limpa registro e volta ao MOCK', async () => {
  enableEvolution();
  process.env.WHATSAPP_ENABLED = 'true';
  const calls = [];
  const restore = stubFetch({
    '/instance/logout/tenant_0001_torque_detail': () => jsonResponse({})
  }, calls);

  try {
    const out = await evolutionService.disconnect(tenant);
    assert(out.status === 'disconnected', 'desconectado');
    const row = core.getEvolutionInstance(tenant.id);
    assert(row && row.status === 'disconnected' && !row.qr_base64, 'registro mantido como disconnected, QR limpo');
    assert(calls.some((c) => c.url === '/instance/logout/tenant_0001_torque_detail'), 'logout remoto chamado');

    process.env.WHATSAPP_ENABLED = 'false';
    disableEvolution();
    const status = whatsappService.getStatus();
    assert(status.mock === true, `volta ao MOCK após desabilitar (veio ${JSON.stringify(status)})`);
  } finally {
    restore();
    process.env.WHATSAPP_ENABLED = 'false';
    disableEvolution();
  }
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testEvolutionApi] DATA_DIR isolado: ${TEST_DIR}`);
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
