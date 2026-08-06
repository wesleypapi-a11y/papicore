#!/usr/bin/env node
/*
 * testPublicApi.js
 *
 * Suíte da API pública (/api/v1) + painel do desenvolvedor (aba API):
 *   - geração de chaves: prefixo/hash (nunca a chave pura no banco);
 *   - autenticação por chave: sem chave, chave inválida, revogada, suspensa,
 *     expirada, tenant suspenso/expirado, manutenção;
 *   - escopos: requireScope libera/nega conforme o conjunto da chave;
 *   - rate limit por chave (janela deslizante) e reset;
 *   - idempotência: 400 sem header, 409 em andamento, 422 corpo diferente,
 *     replay devolve a resposta original sem re-executar o handler;
 *   - multi-tenant: cada chave abre o banco da SUA empresa (A e B isolados);
 *   - webhooks: outbox, HMAC-SHA256, filtro por evento/tenant/ativo,
 *     entrega com fetch mockado, retry com backoff, FAILED ao esgotar,
 *     redeliver e ping de teste;
 *   - logs de requisição; handlers do painel (create/list/rotate de chaves,
 *     webhooks sem exposição do secret).
 *
 * Roda em um DATA_DIR temporário (não toca os dados reais):
 *   node scripts/testPublicApi.js
 *
 * KEEP_DATA_DIR=1 preserva o diretório ao final para inspeção.
 * Código de saída: 0 (ok) ou 1 (falha).
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-public-api-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';
process.env.API_RATE_LIMIT_PER_MIN = '25';
process.env.API_WEBHOOK_MAX_RETRIES = '2';
process.env.API_WEBHOOK_BASE_DELAY_MS = '1';
process.env.API_WEBHOOK_TIMEOUT_MS = '2000';

const core = require('../database/coreDatabase');
const { openTenantDatabase, closeTenantDatabase } = require('../database/tenantDatabase');
const { createTenantDatabase } = require('../database/tenantDatabase');
const { buildDatabaseName } = require('../database/createTenantDatabase');
const { requireApiKey, requireScope, hasScope, resetApiRateLimits, sha256hex, ALL_SCOPES } = require('../middlewares/apiKeyMiddleware');
const { idempotency } = require('../middlewares/idempotencyMiddleware');
const webhookService = require('../services/webhookService');
const publicApiController = require('../controllers/publicApiController');
const apiKeyController = require('../controllers/apiKeyController');

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

/* ---------- Helpers de requisição (simulam o ciclo do Express) ---------- */

function makeReq(overrides = {}) {
  const req = {
    method: 'GET',
    path: '/',
    baseUrl: '',
    url: '/',
    originalUrl: '/',
    headers: {},
    query: {},
    body: {},
    params: {},
    ip: '127.0.0.1',
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
    ...overrides
  };
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    __ended: false,
    listeners: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      res.statusCode = res.statusCode || 200;
      res.__ended = true;
      return res;
    },
    send(body) {
      res.body = body;
      res.__ended = true;
      return res;
    },
    on(ev, cb) {
      (res.listeners[ev] = res.listeners[ev] || []).push(cb);
      return res;
    },
    emit(ev) {
      for (const cb of res.listeners[ev] || []) {
        try { cb(); } catch (e) { /* ignore listener errors */ }
      }
      return res;
    }
  };
  return res;
}

/* Executa middlewares em sequência (estilo Express) e depois o handler final.
   Emite 'finish' para disparar logs e a conclusão da idempotência. */
function runChain(req, res, middlewares, finalHandler) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { res.emit('finish'); } catch (e) { /* ignore */ }
      resolve(res);
    };
    const final = () => {
      if (!finalHandler) return finish();
      let out;
      try {
        out = finalHandler(req, res);
      } catch (err) {
        res.statusCode = err.statusCode || 500;
        res.body = res.body || { error: err.message };
        return finish();
      }
      if (out && typeof out.then === 'function') {
        out.then(() => finish()).catch((err) => {
          res.statusCode = err.statusCode || res.statusCode || 500;
          res.body = res.body || { error: err.message };
          finish();
        });
      } else {
        finish();
      }
    };
    let i = 0;
    const next = (err) => {
      if (err) {
        res.statusCode = err.statusCode || 500;
        res.body = res.body || { error: err.message };
        return finish();
      }
      if (i < middlewares.length) {
        const mw = middlewares[i++];
        let returned = false;
        const cb = () => { returned = true; next(); };
        try {
          mw(req, res, cb);
        } catch (e) {
          res.statusCode = e.statusCode || 500;
          res.body = res.body || { error: e.message };
          return finish();
        }
        if (!returned && res.__ended) finish();
      } else {
        final();
      }
    };
    next();
  });
}

function apiCall(req, finalHandler, extraMiddlewares = []) {
  return runChain(req, makeRes(), [requireApiKey, ...extraMiddlewares], finalHandler);
}

/* ---------- Setup ---------- */

let tenantA = null;
let tenantB = null;
let dbA = null;
let dbB = null;
let keyA = null;    // { raw, row }
let keyB = null;    // { raw, row }

function makeTenant(name, slug, unit) {
  const id = core.nextTenantId();
  const databaseName = buildDatabaseName(id, slug);
  createTenantDatabase(databaseName, {
    companyName: name,
    phone: unit ? unit.phone : null,
    whatsapp: unit ? unit.phone : null,
    unit,
    fullCatalog: false
  });
  const bundle = core.createTenantBundle({
    tenant: {
      name,
      slug,
      database_name: databaseName,
      email: `${slug}@empresa.test`,
      phone: unit ? unit.phone : null,
      plan: 'STARTER',
      status: 'ACTIVE',
      expires_at: null
    },
    user: {
      name: `Admin ${name}`,
      email: `admin.${slug}@empresa.test`,
      password_hash: 'hash-teste',
      role: 'owner',
      active: 1
    },
    domain: null
  });
  return bundle.tenant;
}

function makeKey(tenantId, scopes, extra = {}) {
  const generated = core.generateApiKey();
  const row = core.createApiKey({
    id: crypto.randomUUID(),
    tenant_id: tenantId,
    name: 'Chave de teste',
    key_hash: generated.keyHash,
    key_prefix: generated.keyPrefix,
    scopes: scopes || [],
    expires_at: null,
    created_by_user_id: null,
    ...extra
  });
  return { raw: generated.apiKey, row };
}

function outboxRaw(id) {
  return core.getCoreDb().prepare('SELECT * FROM api_webhook_outbox WHERE id = ?').get(id);
}

function authReq(base, apiKey) {
  return makeReq({
    headers: { authorization: `Bearer ${apiKey.raw}` },
    ...base
  });
}

/* ---------- Testes ---------- */

test('setup: tenants A e B em bancos independentes + tabelas da API no core', () => {
  core.initCore();
  tenantA = core.getTenantById(1);
  assert(tenantA, 'tenant padrão existe');
  dbA = openTenantDatabase(tenantA.database_name);

  tenantB = makeTenant('Beta Detalhes', 'beta-detalhes', null);
  assert(tenantB && tenantB.id > tenantA.id, 'tenant B criado com id maior que A');
  dbB = openTenantDatabase(tenantB.database_name);
  assert(dbB !== dbA, 'bancos de A e B são instâncias distintas');

  const coreDb = core.getCoreDb();
  const tables = coreDb.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN
     ('api_keys','api_webhooks','api_webhook_outbox','api_idempotency_keys','api_request_logs')`
  ).all().map((r) => r.name);
  for (const t of ['api_keys', 'api_webhooks', 'api_webhook_outbox', 'api_idempotency_keys', 'api_request_logs']) {
    assert(tables.includes(t), `tabela ${t} existe no core`);
  }
  const marker = coreDb.prepare("SELECT name FROM schema_migrations WHERE name = 'public_api_v1'").get();
  assert(marker, 'migração public_api_v1 registrada');
});

test('generateApiKey: formato pk_live_, prefixo e hash SHA-256', () => {
  const g = core.generateApiKey();
  assert(/^pk_live_[A-Za-z0-9_-]{32}$/.test(g.apiKey), 'formato pk_live_ + 32 chars base64url');
  assert(g.keyPrefix === g.apiKey.slice(0, 12), 'keyPrefix = 12 primeiros chars');
  assert(g.keyHash === sha256hex(g.apiKey), 'keyHash é o SHA-256 da chave');
  assert(g.apiKey !== g.keyHash, 'hash nunca é igual à chave pura');
});

test('createApiKey + getApiKeyByHash: chave pura jamais armazenada', () => {
  const created = makeKey(tenantA.id, ['settings:read']);
  keyA = created;
  const stored = core.getCoreDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(created.row.id);
  assert(stored.key_hash === sha256hex(created.raw), 'banco guarda o hash, não a chave');
  assert(!String(stored.key_hash).includes('pk_live_'), 'hash não contém o prefixo da chave');
  assert(core.getApiKeyByHash(sha256hex(created.raw)), 'lookup por hash encontra a chave');
  assert(!core.getApiKeyByHash(sha256hex('pk_live_' + 'x'.repeat(32))), 'lookup por hash errado é nulo');
});

test('chave de tenant B + isolamento de scopes e hash', () => {
  keyB = makeKey(tenantB.id, ['catalog:read', 'appointments:read']);
  assert(keyA.raw !== keyB.raw, 'chaves distintas');
  assert(core.getApiKeyByHash(sha256hex(keyB.raw)).tenant_id === tenantB.id, 'hash de B pertence ao tenant B');
});

test('requireApiKey: sem chave → 401', async () => {
  const res = await apiCall(makeReq(), (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 401, `esperava 401, veio ${res.statusCode}`);
  assert(res.body && /Autenticação obrigatória/i.test(res.body.error), 'mensagem de erro clara');
});

test('requireApiKey: chave inválida → 401', async () => {
  const res = await apiCall(authReq({}, { raw: 'pk_live_' + 'a'.repeat(32) }), (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 401, `esperava 401, veio ${res.statusCode}`);
});

test('requireApiKey: chave revogada → 401', async () => {
  const rev = makeKey(tenantA.id, ['settings:read'], { status: 'REVOKED' });
  const res = await apiCall(authReq({}, rev), (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 401, `esperava 401, veio ${res.statusCode}`);
});

test('requireApiKey: chave suspensa → 403', async () => {
  const susp = makeKey(tenantA.id, ['settings:read'], { status: 'SUSPENDED' });
  const res = await apiCall(authReq({}, susp), (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 403, `esperava 403, veio ${res.statusCode}`);
  assert(/suspensa/i.test(res.body.error), 'mensagem informa suspensão');
});

test('requireApiKey: chave expirada (data no passado) → 403', async () => {
  const exp = makeKey(tenantA.id, ['settings:read'], { expires_at: '2000-01-01' });
  const res = await apiCall(authReq({}, exp), (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 403, `esperava 403, veio ${res.statusCode}`);
  assert(/expirou/i.test(res.body.error), 'mensagem informa expiração');
});

test('requireApiKey: chave com status EXPIRED → 403', async () => {
  const exp = makeKey(tenantA.id, ['settings:read'], { status: 'EXPIRED' });
  const res = await apiCall(authReq({}, exp), (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 403, `esperava 403, veio ${res.statusCode}`);
});

test('requireApiKey: chave válida autentica, abre o banco do tenant e segue o handler', async () => {
  let seenTenantId = null;
  let seenDbOk = false;
  const res = await apiCall(authReq({}, keyA), (req, r) => {
    seenTenantId = req.tenantId;
    seenDbOk = Boolean(req.tenantDb) && req.tenantDb.prepare('SELECT COUNT(*) c FROM company_settings WHERE id=1').get().c === 1;
    return r.json({ tenant: req.tenant.name });
  });
  assert(res.statusCode === 200, `esperava 200, veio ${res.statusCode}`);
  assert(seenTenantId === tenantA.id, 'tenantId resolvido pela chave = tenant A');
  assert(seenDbOk, 'banco do tenant A acessível no handler');
  assert(res.body.tenant === tenantA.name, 'dados vêm do tenant correto');
});

test('requireApiKey: tenant suspenso → 403 (chave válida)', async () => {
  const keySusp = makeKey(tenantB.id, ['settings:read']);
  core.updateTenant(tenantB.id, { status: 'SUSPENDED' });
  try {
    const res = await apiCall(authReq({}, keySusp), (req, r) => r.json({ ok: true }));
    assert(res.statusCode === 403, `esperava 403, veio ${res.statusCode}`);
  } finally {
    core.updateTenant(tenantB.id, { status: 'ACTIVE' });
  }
});

test('requireApiKey: tenant em manutenção → 503', async () => {
  core.setTenantMaintenance(tenantB.id, { active: true, reason: 'teste' });
  try {
    const res = await apiCall(authReq({}, keyB), (req, r) => r.json({ ok: true }));
    assert(res.statusCode === 503, `esperava 503, veio ${res.statusCode}`);
  } finally {
    core.setTenantMaintenance(tenantB.id, { active: false });
  }
});

test('requireScope: libera com o escopo certo e nega sem ele', async () => {
  const readKey = makeKey(tenantA.id, ['appointments:read']);
  const writeKey = makeKey(tenantA.id, ['settings:read']);

  let allowed = null;
  const resOk = await runChain(authReq({}, readKey), makeRes(),
    [requireApiKey, requireScope('appointments:read')],
    (req, r) => { allowed = true; return r.json({ ok: true }); });
  assert(resOk.statusCode === 200 && allowed === true, 'escopo correto passa');

  const resNo = await runChain(authReq({}, writeKey), makeRes(),
    [requireApiKey, requireScope('appointments:read')],
    (req, r) => r.json({ ok: true }));
  assert(resNo.statusCode === 403, `sem o escopo → 403, veio ${resNo.statusCode}`);
  assert(/appointments:read/.test(resNo.body.error), 'erro cita o escopo ausente');

  assert(hasScope({ scopes: JSON.stringify(['a']) }, 'a') === true, 'hasScope com permissão');
  assert(hasScope({ scopes: JSON.stringify(['b']) }, 'a') === false, 'hasScope sem permissão');
  assert(Array.isArray(ALL_SCOPES) && ALL_SCOPES.includes('appointments:write'), 'ALL_SCOPES exportado com os escopos fechados');
});

test('rate limit: excede o teto → 429 e reset limpa', async () => {
  resetApiRateLimits();
  const keyRL = makeKey(tenantA.id, ['settings:read']);
  let last = null;
  for (let n = 0; n < 26; n += 1) {
    last = await apiCall(authReq({}, keyRL), (req, r) => r.json({ n }));
  }
  assert(last.statusCode === 429, `esperava 429 na 26ª chamada, veio ${last.statusCode}`);
  assert(/Limite/i.test(last.body.error), 'mensagem de limite excedido');
  resetApiRateLimits();
  const after = await apiCall(authReq({}, keyRL), (req, r) => r.json({ ok: true }));
  assert(after.statusCode === 200, `após reset a chave volta a funcionar, veio ${after.statusCode}`);
});

test('idempotency: POST sem Idempotency-Key → 400', async () => {
  const res = await runChain(authReq({ method: 'POST', body: { a: 1 } }, keyA), makeRes(),
    [requireApiKey, idempotency()], (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 400, `esperava 400, veio ${res.statusCode}`);
});

test('idempotency: primeira chamada executa e grava o resultado', async () => {
  let runs = 0;
  const req = authReq({ method: 'POST', baseUrl: '/api/v1', path: '/appointments', body: { a: 1 } }, keyA);
  req.headers['idempotency-key'] = 'idem-1';
  const res = await runChain(req, makeRes(), [requireApiKey, idempotency()], (rq, r) => { runs += 1; return r.status(201).json({ created: true, seq: runs }); });
  assert(res.statusCode === 201 && runs === 1, 'primeira chamada executou');
  const rec = core.getApiIdempotencyKey(tenantA.id, keyA.row.id, 'idem-1');
  assert(rec && rec.status_code === 201, 'registro idempotente completo');
  assert(JSON.parse(rec.response_body).seq === 1, 'resposta gravada é a original');
});

test('idempotency: replay idêntico devolve a resposta original sem re-executar', async () => {
  let runs = 0;
  const mk = () => {
    const req = authReq({ method: 'POST', baseUrl: '/api/v1', path: '/appointments', body: { a: 1, b: 2 } }, keyA);
    req.headers['idempotency-key'] = 'idem-replay';
    return req;
  };
  const first = await runChain(mk(), makeRes(), [requireApiKey, idempotency()], (rq, r) => { runs += 1; return r.status(201).json({ created: true, seq: runs }); });
  assert(first.statusCode === 201 && runs === 1, 'primeira execução');
  const second = await runChain(mk(), makeRes(), [requireApiKey, idempotency()], (rq, r) => { runs += 1; return r.status(201).json({ created: true, seq: runs }); });
  assert(second.statusCode === 201 && runs === 1, 'replay não executa de novo');
  assert(second.body.seq === 1, 'replay devolve o corpo gravado');
});

test('idempotency: mesma chave com corpo diferente → 422', async () => {
  const req1 = authReq({ method: 'POST', baseUrl: '/api/v1', path: '/appointments', body: { a: 1 } }, keyA);
  req1.headers['idempotency-key'] = 'idem-diff';
  await runChain(req1, makeRes(), [requireApiKey, idempotency()], (rq, r) => r.status(201).json({ ok: true }));

  const req2 = authReq({ method: 'POST', baseUrl: '/api/v1', path: '/appointments', body: { a: 2 } }, keyA);
  req2.headers['idempotency-key'] = 'idem-diff';
  const res2 = await runChain(req2, makeRes(), [requireApiKey, idempotency()], (rq, r) => r.status(201).json({ ok: true }));
  assert(res2.statusCode === 422, `esperava 422, veio ${res2.statusCode}`);
});

test('idempotency: registro sem resposta (em andamento) → 409', async () => {
  core.insertApiIdempotencyKey({
    tenant_id: tenantA.id,
    api_key_id: keyA.row.id,
    idempotency_key: 'idem-inflight',
    method: 'POST',
    path: '/api/v1/appointments',
    request_sha: 'qualquer'
  });
  const req = authReq({ method: 'POST', baseUrl: '/api/v1', path: '/appointments', body: { a: 1 } }, keyA);
  req.headers['idempotency-key'] = 'idem-inflight';
  const res = await runChain(req, makeRes(), [requireApiKey, idempotency()], (rq, r) => r.status(201).json({ ok: true }));
  assert(res.statusCode === 409, `esperava 409, veio ${res.statusCode}`);
});

test('idempotency: chave com mais de 128 caracteres → 400', async () => {
  const req = authReq({ method: 'POST', body: {} }, keyA);
  req.headers['idempotency-key'] = 'x'.repeat(129);
  const res = await runChain(req, makeRes(), [requireApiKey, idempotency()], (rq, r) => r.json({ ok: true }));
  assert(res.statusCode === 400, `esperava 400, veio ${res.statusCode}`);
});

test('GET não exige Idempotency-Key e passa direto', async () => {
  let runs = 0;
  const res = await runChain(authReq({ method: 'GET', query: {} }, keyA), makeRes(),
    [requireApiKey, idempotency()], (rq, r) => { runs += 1; return r.json({ ok: true }); });
  assert(res.statusCode === 200 && runs === 1, 'GET sem header funciona');
});

test('multi-tenant: chave de A lê settings de A; chave de B lê settings de B', async () => {
  const ra = await apiCall(authReq({}, keyA), publicApiController.getSettings);
  assert(ra.statusCode === 200 && ra.body.company_name === tenantA.name, `settings de A (${ra.body && ra.body.company_name})`);

  const rb = await apiCall(authReq({}, keyB), publicApiController.getSettings);
  assert(rb.statusCode === 200 && rb.body.company_name === tenantB.name, `settings de B (${rb.body && rb.body.company_name})`);

  assert(ra.body.company_name !== rb.body.company_name, 'empresas diferentes');
});

test('endpoints públicos GET respondem com chave válida (units, modalities)', async () => {
  const units = await apiCall(authReq({}, keyA), publicApiController.listUnits);
  assert(units.statusCode === 200 && Array.isArray(units.body), 'listUnits responde array');
  const mods = await apiCall(authReq({}, keyA), publicApiController.listModalities);
  assert(mods.statusCode === 200 && Array.isArray(mods.body), 'listModalities responde array');
});

test('POST /appointments wrapper: validação rejeita body vazio sem disparar webhook', async () => {
  const writeKey = makeKey(tenantA.id, ['appointments:write']);
  const before = core.getCoreDb().prepare("SELECT COUNT(*) c FROM api_webhook_outbox WHERE event = 'appointment.created'").get().c;
  const res = await runChain(authReq({ method: 'POST', baseUrl: '/api/v1', path: '/appointments', body: {} }, writeKey), makeRes(),
    [requireApiKey, requireScope('appointments:write'), idempotency()],
    publicApiController.createAppointment);
  assert(res.statusCode >= 400 && res.statusCode < 500, `validação falha com 4xx, veio ${res.statusCode}`);
  const after = core.getCoreDb().prepare("SELECT COUNT(*) c FROM api_webhook_outbox WHERE event = 'appointment.created'").get().c;
  assert(after === before, 'falha de validação não enfileira webhook');
});

test('webhook: create + list sem expor o secret', () => {
  const wh = core.createApiWebhook({
    id: crypto.randomUUID(),
    tenant_id: tenantA.id,
    name: 'Webhook A',
    url: 'https://webhook.test/a',
    secret: 'secret-test-a',
    events: ['appointment.created', 'package.sold'],
    active: 1,
    created_by_user_id: null
  });
  assert(wh.secret === 'secret-test-a', 'create devolve o secret (mostra uma única vez)');
  const listed = core.listApiWebhooks({ tenantId: tenantA.id })[0];
  assert(listed.secret === 'secret-test-a', 'listagem interna tem o secret p/ assinar');
  const sanitized = core.listApiWebhooks({ tenantId: tenantB.id });
  assert(!sanitized.some((w) => w.id === wh.id), 'webhook de A não aparece no tenant B');
});

test('enqueueEvent: filtra por tenant, evento e webhook ativo', () => {
  const beforeA = core.countWebhookOutboxPending();

  const enqueued = webhookService.enqueueEvent(tenantA.id, 'appointment.created', { appointment_code: 'A-1' });
  assert(enqueued.enqueued === 1, `1 entrega para A (assinou appointment.created), veio ${enqueued.enqueued}`);

  const none = webhookService.enqueueEvent(tenantA.id, 'appointment.cancelled', { appointment_code: 'A-1' });
  assert(none.enqueued === 0, 'evento não assinado não enfileira');

  const b = webhookService.enqueueEvent(tenantB.id, 'appointment.created', { appointment_code: 'B-1' });
  assert(b.enqueued === 0, 'tenant B sem webhook não enfileira');

  assert(core.countWebhookOutboxPending() === beforeA + 1, 'outbox cresceu só com a entrega de A');
});

test('outbox: assinatura HMAC-SHA256 bate com o secret do webhook', () => {
  const rows = core.getCoreDb().prepare(
    "SELECT id, signature, payload FROM api_webhook_outbox WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(tenantA.id);
  const expected = webhookService.signPayload('secret-test-a', rows.payload);
  assert(rows.signature === expected, 'signature = HMAC-SHA256(secret, payload)');
  assert(rows.signature.length === 64, 'assinatura é hex de 64 chars');
});

test('dispatchDue: entrega com fetch mockado e cabeçalhos corretos', async () => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200 };
  };
  try {
    const stats = await webhookService.dispatchDue();
    assert(stats.delivered >= 1, `ao menos 1 entrega, veio ${JSON.stringify(stats)}`);
  } finally {
    global.fetch = originalFetch;
  }
  assert(captured, 'fetch foi chamado');
  assert(captured.opts.method === 'POST', 'método POST');
  assert(captured.opts.headers['X-PapiCore-Event'] === 'appointment.created', 'header de evento presente');
  assert(String(captured.opts.headers['X-PapiCore-Signature']).startsWith('sha256='), 'header de assinatura presente');
  assert(String(captured.opts.headers['X-PapiCore-Signature']).length === 'sha256='.length + 64, 'assinatura no header é hex de 64');
  const last = core.getCoreDb().prepare(
    "SELECT * FROM api_webhook_outbox WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(tenantA.id);
  assert(last.status === 'DELIVERED', `entregue e marcado DELIVERED (${last.status})`);
  assert(last.delivered_at, 'delivered_at gravado');
});

test('dispatchDue: falha HTTP → PENDING com backoff no futuro', async () => {
  const id = crypto.randomUUID();
  core.insertWebhookOutbox({ id, webhook_id: core.listApiWebhooks({ tenantId: tenantA.id })[0].id, tenant_id: tenantA.id, event: 'appointment.created', payload: '{}', signature: 'sig', next_attempt_at: new Date().toISOString() });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    await webhookService.dispatchDue();
  } finally {
    global.fetch = originalFetch;
  }
  const row = core.getWebhookOutboxById(id);
  assert(row.status === 'PENDING', `primeira falha vira PENDING, veio ${row.status}`);
  assert(row.attempts === 1, 'tentativa registrada');
  assert(row.next_attempt_at > new Date().toISOString(), 'backoff no futuro');
  assert(row.last_http_status === 500, 'HTTP status gravado');
});

test('dispatchDue: esgotou retries → FAILED', async () => {
  const wh = core.listApiWebhooks({ tenantId: tenantA.id })[0];
  const id = crypto.randomUUID();
  core.insertWebhookOutbox({ id, webhook_id: wh.id, tenant_id: tenantA.id, event: 'appointment.created', payload: '{}', signature: 'sig', next_attempt_at: new Date().toISOString() });
  core.getCoreDb().prepare('UPDATE api_webhook_outbox SET attempts = 2 WHERE id = ?').run(id);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  try {
    await webhookService.dispatchDue();
  } finally {
    global.fetch = originalFetch;
  }
  const row = core.getWebhookOutboxById(id);
  assert(row.status === 'FAILED', `tentativas esgotadas → FAILED, veio ${row.status}`);
  assert(row.last_error && /HTTP 500/.test(row.last_error), 'erro final registrado');
  assert(row.next_attempt_at === null, 'sem nova tentativa');
});

test('webhook desativado: enqueue não gera entrega', () => {
  const whId = crypto.randomUUID();
  core.createApiWebhook({ id: whId, tenant_id: tenantB.id, name: 'Webhook inativo', url: 'https://webhook.test/b', secret: 's', events: ['appointment.created'], active: 0, created_by_user_id: null });
  const r = webhookService.enqueueEvent(tenantB.id, 'appointment.created', { x: 1 });
  assert(r.enqueued === 0, 'webhook inativo não recebe evento');
});

test('redeliver: reenvia imediatamente após falha', async () => {
  const wh = core.listApiWebhooks({ tenantId: tenantA.id })[0];
  const id = crypto.randomUUID();
  core.insertWebhookOutbox({ id, webhook_id: wh.id, tenant_id: tenantA.id, event: 'appointment.created', payload: '{"a":1}', signature: webhookService.signPayload(wh.secret, '{"a":1}'), next_attempt_at: new Date().toISOString() });
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500 });
  await webhookService.dispatchDue();
  global.fetch = async () => ({ ok: true, status: 200 });
  try {
    const out = await webhookService.redeliver(id);
    assert(out.ok === true, `redeliver entrega, veio ${JSON.stringify(out)}`);
    assert(core.getWebhookOutboxById(id).status === 'DELIVERED', 'status final DELIVERED');
  } finally {
    global.fetch = originalFetch;
  }
});

test('sendTestDelivery: ping com assinatura e resultado ok', async () => {
  const wh = core.listApiWebhooks({ tenantId: tenantA.id })[0];
  const originalFetch = global.fetch;
  let gotHeader = null;
  global.fetch = async (url, opts) => {
    gotHeader = opts.headers['X-PapiCore-Signature'];
    return { ok: true, status: 200 };
  };
  try {
    const out = await webhookService.sendTestDelivery(wh);
    assert(out.ok === true, 'teste entrega');
  } finally {
    global.fetch = originalFetch;
  }
  assert(String(gotHeader).startsWith('sha256='), 'ping assinado');
});

test('fire: sem tenant na requisição → skipped (não lança)', () => {
  const out = webhookService.fire(makeReq(), 'appointment.created', { a: 1 });
  assert(out.skipped === true, 'sem tenant: skip silencioso');
});

test('fire: com tenant na requisição enfileira para os webhooks assinantes', () => {
  const req = makeReq({ tenant: tenantA, tenantId: tenantA.id });
  const out = webhookService.fire(req, 'package.sold', { package_name_snapshot: 'Pacote teste' });
  assert(out.enqueued === 1, 'fire encaminha o evento do fluxo de negócio');
});

test('webhook logs: listagem com tenant filtrado e sem payload', () => {
  const logs = core.listWebhookOutbox({ tenantId: tenantA.id });
  assert(logs.length > 0, 'há entregas para A');
  assert(logs.every((l) => l.payload === undefined), 'payload não vaza em listagens');
});

test('logs de requisição: cada chamada à API é registrada com status e duração', async () => {
  const before = core.listApiRequestLogsAll({ limit: 500 }).length;
  const res = await apiCall(authReq({}, keyA), publicApiController.listUnits);
  assert(res.statusCode === 200, 'chamada executada');
  const all = core.listApiRequestLogsAll({ limit: 500 });
  assert(all.length > before, 'log novo criado');
  const newest = all[0];
  assert(newest.method === 'GET' && newest.path === '/', `log gravou método/path (${newest.method} ${newest.path})`);
  assert(newest.status_code === 200, 'status registrado');
  assert(newest.tenant_id === tenantA.id, 'log vinculado ao tenant da chave');
  assert(newest.key_prefix === keyA.row.key_prefix, 'log guarda apenas o prefixo da chave');
  const filtered = core.listApiRequestLogs({ tenantId: tenantA.id });
  assert(filtered.every((l) => l.tenant_id === tenantA.id), 'filtro por tenant');
});

test('chamada não autenticada também gera log (com tenant nulo)', async () => {
  const before = core.listApiRequestLogsAll({ limit: 500 }).length;
  const res = await apiCall(makeReq(), (req, r) => r.json({ ok: true }));
  assert(res.statusCode === 401, '401 sem chave');
  assert(core.listApiRequestLogsAll({ limit: 500 }).length === before + 1, 'falha de autenticação é logada');
});

test('painel: createKeyHandler devolve a chave uma única vez e sem hash', async () => {
  let statusCode = 0;
  let body = null;
  const res = { status: (c) => { statusCode = c; return res; }, json: (d) => { body = d; return res; } };
  apiKeyController.createKeyHandler({ body: { tenant_id: tenantA.id, name: 'Chave do painel', scopes: ['customers:read'] }, user: { id: 1, name: 'Dev' } }, res);
  assert(statusCode === 201, `cria chave com 201, veio ${statusCode}`);
  assert(/^pk_live_/.test(body.api_key), 'retorna a chave pura (uma única vez)');
  assert(body.key && body.key.key_hash === undefined, 'registro sanitizado sem hash');
  assert(core.getApiKeyByHash(sha256hex(body.api_key)), 'hash persistido para autenticação');
});

test('painel: rotateKeyHandler gera novo par e invalida o antigo', () => {
  let body = null;
  const createRes = { status: (c) => { createRes.statusCode = c; return createRes; }, json: (d) => { body = d; return createRes; } };
  apiKeyController.createKeyHandler({ body: { tenant_id: tenantA.id, name: 'Chave p/ rotação', scopes: ['settings:read'] }, user: { id: 1 } }, createRes);
  assert(createRes.statusCode === 201, 'cria chave para rotação');
  const oldKey = body.api_key;
  const oldHash = sha256hex(oldKey);

  const rotRes = { json: (d) => { body = d; return rotRes; } };
  apiKeyController.rotateKeyHandler({ params: { id: body.key.id } }, rotRes);
  const newRaw = body.api_key;
  assert(newRaw !== oldKey, 'chave nova diferente da antiga');
  assert(core.getApiKeyByHash(oldHash) === undefined, 'hash antigo deixa de autenticar');
  assert(core.getApiKeyByHash(sha256hex(newRaw)), 'hash novo autentica');
});

test('painel: webhooks sanitizados nas listagens (sem secret)', () => {
  let body = null;
  const res = { json: (d) => { body = d; return res; } };
  apiKeyController.listWebhooksHandler({ query: {} }, res);
  assert(Array.isArray(body), 'lista de webhooks');
  assert(body.every((w) => w.secret === undefined), 'secret nunca aparece na listagem');
  assert(body.some((w) => w.has_secret === true), 'indica que há secret cadastrado');
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testPublicApi] DATA_DIR isolado: ${TEST_DIR}`);
  await run();
  try {
    if (dbA) closeTenantDatabase(tenantA.database_name);
    if (dbB) closeTenantDatabase(tenantB.database_name);
  } catch (err) {
    console.error('  aviso ao fechar bancos:', err.message);
  }
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  }
  process.exit(failures ? 1 : 0);
})();
