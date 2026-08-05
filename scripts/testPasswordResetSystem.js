/*
 * testPasswordResetSystem.js
 *
 * Testes do fluxo de recuperação de senha do painel administrativo dos
 * tenants (forgot-password / reset-password/validate / reset-password).
 *
 * Roda em um DATA_DIR temporário (não toca os dados reais de desenvolvimento):
 *   node scripts/testPasswordResetSystem.js
 *
 * Controllers são chamados diretamente com req/res mockados (sem subir um
 * servidor HTTP) e a chamada à Brevo é interceptada substituindo
 * global.fetch — o e-mail "enviado" é inspecionado a partir do corpo dessa
 * chamada, exatamente como um destinatário real leria o link no e-mail.
 *
 * Saída: "N testes passaram" / "FALHA" com detalhe da primeira falha.
 * Código de saída: 0 (ok) ou 1 (falha).
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

/* Ambiente isolado ANTES de carregar qualquer módulo da plataforma. */
const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-password-reset-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-secret-password-reset';
process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES = '30';
process.env.PASSWORD_RESET_RATE_LIMIT_WINDOW_MINUTES = '15';
process.env.PASSWORD_RESET_RATE_LIMIT_MAX = '4';

const core = require('../database/coreDatabase');
const { resolveTenantByHost } = require('../middlewares/domainTenantMiddleware');
const { requireAuth } = require('../middlewares/auth');
const { signToken } = require('../controllers/authController');
const passwordResetController = require('../controllers/passwordResetController');
const { passwordResetIpRateLimit, passwordResetEmailRateLimit } = require('../middlewares/passwordResetRateLimit');
const { generateToken } = require('../services/passwordResetService');
const { AppError } = require('../utils/helpers');

/* ---------- Runner (mesmo padrão de scripts/testBackupSystem.js) ---------- */

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
      console.error(`  FALHA ${t.name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : err}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function expectAppError(fn, status) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof AppError, `esperava AppError, veio ${err && err.constructor && err.constructor.name}`);
    assert(err.status === status, `esperava status ${status}, veio ${err.status}`);
    return err;
  }
  throw new Error(`esperava que lançasse AppError ${status}, mas não lançou`);
}

/* ---------- Mock da Brevo (substitui global.fetch) ---------- */

let fetchCalls = [];
let fetchMode = 'ok'; /* 'ok' | 'http-error' | 'network-error' */
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  if (fetchMode === 'network-error') throw new Error('simulated network error');
  if (fetchMode === 'http-error') {
    return { ok: false, status: 401, json: async () => ({ message: 'Unauthorized (chave inválida)' }) };
  }
  return { ok: true, status: 201, json: async () => ({ messageId: 'test-message-id' }) };
};

function extractTokenFromLastEmail() {
  const call = fetchCalls[fetchCalls.length - 1];
  assert(call, 'nenhuma chamada à Brevo foi capturada');
  const payload = JSON.parse(call.opts.body);
  const match = String(payload.textContent || '').match(/token=([a-f0-9]+)/);
  assert(match, 'não encontrou o token no corpo do e-mail capturado');
  return match[1];
}

/* ---------- Helpers de req/res (sem subir servidor HTTP) ---------- */

function buildReq({ domain, body = {}, ip = '10.0.0.1' } = {}) {
  const req = {
    headers: { host: domain, 'user-agent': 'password-reset-test-agent' },
    body,
    ip,
    protocol: 'http'
  };
  resolveTenantByHost(req, {}, () => {});
  return req;
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

async function callForgotPassword(email, { domain, ip = '10.0.0.1' } = {}) {
  const req = buildReq({ domain, ip, body: { email } });
  const res = mockRes();
  await passwordResetController.forgotPassword(req, res);
  return { req, res };
}

async function callValidate(token, { domain } = {}) {
  const req = buildReq({ domain, body: { token } });
  const res = mockRes();
  await passwordResetController.validateResetToken(req, res);
  return { req, res };
}

async function callReset(token, password, passwordConfirmation, { domain } = {}) {
  const req = buildReq({ domain, body: { token, password, password_confirmation: passwordConfirmation } });
  const res = mockRes();
  await passwordResetController.resetPassword(req, res);
  return { req, res };
}

function lastActivityLogs(tenantId, limit = 10) {
  return core.getCoreDb()
    .prepare('SELECT * FROM activity_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
    .all(tenantId, limit);
}

function countTokensForUser(userId) {
  return core.getCoreDb().prepare('SELECT COUNT(*) AS total FROM password_reset_tokens WHERE user_id = ?').get(userId).total;
}

/* ---------- Fixtures ---------- */

core.initCore();

const TENANT_DOMAIN = 'reset-test.example.com';
const OTHER_DOMAIN = 'other-reset-test.example.com';
const UNKNOWN_DOMAIN = 'totally-unknown-domain.example.com';
const OLD_PASSWORD = 'OldPass123';

const tenant = core.insertTenant({ name: 'Reset Test Co', slug: 'reset-test-co', database_name: 'tenant_9101_reset_test.db' });
core.insertDomain(tenant.id, TENANT_DOMAIN, true);

const user = core.insertUser({
  tenant_id: tenant.id,
  name: 'Usuário Teste',
  email: 'user@reset-test.example.com',
  password_hash: bcrypt.hashSync(OLD_PASSWORD, 10),
  role: 'owner',
  active: 1
});

const inactiveUser = core.insertUser({
  tenant_id: tenant.id,
  name: 'Usuário Inativo',
  email: 'inativo@reset-test.example.com',
  password_hash: bcrypt.hashSync('Whatever123', 10),
  role: 'admin',
  active: 0
});

const otherTenant = core.insertTenant({ name: 'Other Co', slug: 'other-co-reset-test', database_name: 'tenant_9102_other_test.db' });
core.insertDomain(otherTenant.id, OTHER_DOMAIN, true);

const otherUser = core.insertUser({
  tenant_id: otherTenant.id,
  name: 'Outro Usuário',
  email: 'other@reset-test.example.com',
  password_hash: bcrypt.hashSync('Whatever123', 10),
  role: 'owner',
  active: 1
});

/* ---------- Testes ---------- */

test('initCore cria password_reset_tokens e platform_email_settings (idempotente)', () => {
  const db = core.getCoreDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert(tables.includes('password_reset_tokens'), 'tabela password_reset_tokens deveria existir');
  assert(tables.includes('platform_email_settings'), 'tabela platform_email_settings deveria existir');
  core.initCore(); /* chamar de novo não deve quebrar nada */
});

test('forgotPassword com Brevo desabilitada: mensagem genérica, token criado, sem chamada de rede', async () => {
  fetchCalls = [];
  const before = countTokensForUser(user.id);
  const { res } = await callForgotPassword(user.email, { domain: TENANT_DOMAIN });
  assert(res.body && res.body.message, 'deveria responder com { message }');
  assert(fetchCalls.length === 0, 'não deveria chamar a Brevo com o envio desabilitado');
  assert(countTokensForUser(user.id) === before + 1, 'deveria ter criado um token mesmo sem enviar e-mail');
});

test('habilita a Brevo (config no banco, painel do desenvolvedor)', () => {
  core.upsertPlatformEmailSettings({
    enabled: 1,
    brevo_api_key: 'fake-brevo-api-key-1234',
    brevo_sender_email: 'nao-responda@papicore.com.br',
    brevo_sender_name: 'PapiCore'
  }, null);
  const settings = core.getPlatformEmailSettings();
  assert(settings.enabled === 1, 'enabled deveria estar salvo como 1');
  assert(settings.brevo_api_key === 'fake-brevo-api-key-1234');
});

let genericMessages = [];

test('forgotPassword: e-mail existente no tenant correto envia e-mail e salva só o hash do token', async () => {
  fetchCalls = [];
  const { res } = await callForgotPassword(user.email, { domain: TENANT_DOMAIN });
  genericMessages.push(res.body.message);
  assert(fetchCalls.length === 1, 'deveria ter chamado a Brevo uma vez');

  const row = core.getCoreDb().prepare('SELECT * FROM password_reset_tokens WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user.id);
  assert(row, 'deveria existir um token para o usuário');
  assert(/^[a-f0-9]{64}$/.test(row.token_hash), 'token_hash deveria ser um SHA-256 hex (64 chars), nunca o token puro');
});

test('forgotPassword: e-mail inexistente responde igual, sem token nem e-mail', async () => {
  fetchCalls = [];
  const before = countTokensForUser(user.id);
  const { res } = await callForgotPassword('ninguem-cadastrado@reset-test.example.com', { domain: TENANT_DOMAIN });
  genericMessages.push(res.body.message);
  assert(fetchCalls.length === 0, 'não deveria chamar a Brevo para e-mail inexistente');
  assert(countTokensForUser(user.id) === before, 'não deveria criar token para e-mail inexistente');
});

test('forgotPassword: e-mail existente em OUTRO tenant não é encontrado (isolamento)', async () => {
  fetchCalls = [];
  const before = countTokensForUser(otherUser.id);
  const { res } = await callForgotPassword(otherUser.email, { domain: TENANT_DOMAIN });
  genericMessages.push(res.body.message);
  assert(fetchCalls.length === 0, 'não deveria enviar e-mail: usuário pertence a outro tenant');
  assert(countTokensForUser(otherUser.id) === before, 'não deveria criar token para usuário de outro tenant');
});

test('as respostas de forgotPassword são idênticas nos três casos acima', () => {
  assert(genericMessages.length === 3, 'deveriam ter sido coletadas 3 mensagens');
  const [a, b, c] = genericMessages;
  assert(a === b && b === c, 'a mensagem genérica deveria ser idêntica em todos os cenários (evita enumeração de e-mail)');
});

test('forgotPassword: usuário inativo não recebe recuperação funcional', async () => {
  fetchCalls = [];
  const before = countTokensForUser(inactiveUser.id);
  const { res } = await callForgotPassword(inactiveUser.email, { domain: TENANT_DOMAIN });
  assert(res.body && res.body.message, 'deveria responder com a mensagem genérica mesmo assim');
  assert(fetchCalls.length === 0, 'usuário inativo não deveria receber e-mail');
  assert(countTokensForUser(inactiveUser.id) === before, 'usuário inativo não deveria ganhar token');
});

test('forgotPassword: domínio desconhecido retorna erro controlado (404)', async () => {
  await expectAppError(
    () => callForgotPassword('qualquer@example.com', { domain: UNKNOWN_DOMAIN }),
    404
  );
});

test('rate limit por IP bloqueia após o máximo de solicitações', () => {
  const ip = '10.10.10.10';
  const max = Number(process.env.PASSWORD_RESET_RATE_LIMIT_MAX);
  for (let i = 0; i < max; i += 1) {
    const req = buildReq({ domain: TENANT_DOMAIN, ip, body: { email: `probe${i}@nowhere.example.com` } });
    const res = mockRes();
    passwordResetIpRateLimit(req, res, () => {});
    assert(res.statusCode !== 429, `solicitação ${i + 1} de ${max} não deveria ser bloqueada`);
  }
  const req = buildReq({ domain: TENANT_DOMAIN, ip, body: { email: 'probe-final@nowhere.example.com' } });
  const res = mockRes();
  passwordResetIpRateLimit(req, res, () => {});
  assert(res.statusCode === 429, 'deveria bloquear após exceder o limite por IP');
  assert(res.body && res.body.error && !res.body.error.toLowerCase().includes('nowhere'), 'a mensagem de rate limit não pode mencionar o e-mail');
});

test('rate limit por e-mail + tenant bloqueia após o máximo (3 a cada 30min)', () => {
  const email = 'rate-limit-email-test@reset-test.example.com';
  for (let i = 0; i < 3; i += 1) {
    const req = buildReq({ domain: TENANT_DOMAIN, ip: `10.20.30.${i}`, body: { email } });
    const res = mockRes();
    passwordResetEmailRateLimit(req, res, () => {});
    assert(res.statusCode !== 429, `solicitação ${i + 1} de 3 não deveria ser bloqueada`);
  }
  const req = buildReq({ domain: TENANT_DOMAIN, ip: '10.20.30.99', body: { email } });
  const res = mockRes();
  passwordResetEmailRateLimit(req, res, () => {});
  assert(res.statusCode === 429, 'deveria bloquear após exceder o limite por e-mail, mesmo variando o IP');
});

let tokenForUser = null;

test('captura o token gerado para o usuário de teste (via corpo do e-mail mockado)', async () => {
  fetchCalls = [];
  await callForgotPassword(user.email, { domain: TENANT_DOMAIN });
  tokenForUser = extractTokenFromLastEmail();
  assert(typeof tokenForUser === 'string' && tokenForUser.length === 64, 'token puro deveria ter 64 chars hex (32 bytes)');
});

test('validateResetToken: token válido retorna valid:true', async () => {
  const { res } = await callValidate(tokenForUser, { domain: TENANT_DOMAIN });
  assert(res.body.valid === true, 'token recém-gerado deveria ser válido');
});

test('validateResetToken: token inexistente/garbage retorna valid:false', async () => {
  const { res } = await callValidate('token-que-nunca-existiu-0000', { domain: TENANT_DOMAIN });
  assert(res.body.valid === false, 'token garbage deveria ser inválido');
  assert(!('user_id' in res.body) && !('tenant_id' in res.body), 'a resposta nunca deve incluir user_id/tenant_id');
});

test('validateResetToken: token expirado retorna valid:false', async () => {
  const { token, tokenHash } = generateToken();
  core.insertPasswordResetToken({
    id: crypto.randomUUID(),
    user_id: user.id,
    tenant_id: tenant.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    requested_ip: '1.1.1.1',
    requested_user_agent: 'test'
  });
  const { res } = await callValidate(token, { domain: TENANT_DOMAIN });
  assert(res.body.valid === false, 'token expirado deveria ser inválido');
});

test('validateResetToken: token já usado retorna valid:false', async () => {
  const { token, tokenHash } = generateToken();
  const row = core.insertPasswordResetToken({
    id: crypto.randomUUID(),
    user_id: user.id,
    tenant_id: tenant.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    requested_ip: '1.1.1.1',
    requested_user_agent: 'test'
  });
  core.getCoreDb().prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  const { res } = await callValidate(token, { domain: TENANT_DOMAIN });
  assert(res.body.valid === false, 'token já usado deveria ser inválido (proteção contra replay)');
});

test('validateResetToken: token de OUTRO tenant retorna valid:false', async () => {
  const { token, tokenHash } = generateToken();
  core.insertPasswordResetToken({
    id: crypto.randomUUID(),
    user_id: otherUser.id,
    tenant_id: otherTenant.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    requested_ip: '1.1.1.1',
    requested_user_agent: 'test'
  });
  /* o token pertence a otherTenant, mas a validação é feita no domínio do tenant "reset-test" */
  const { res } = await callValidate(token, { domain: TENANT_DOMAIN });
  assert(res.body.valid === false, 'token de outro tenant nunca deveria validar por este domínio');
});

test('resetPassword: token de OUTRO tenant é rejeitado e não altera a senha alheia', async () => {
  const { token, tokenHash } = generateToken();
  core.insertPasswordResetToken({
    id: crypto.randomUUID(),
    user_id: otherUser.id,
    tenant_id: otherTenant.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    requested_ip: '1.1.1.1',
    requested_user_agent: 'test'
  });
  const beforeHash = core.getUserById(otherUser.id).password_hash;
  await expectAppError(() => callReset(token, 'NovaSenha123', 'NovaSenha123', { domain: TENANT_DOMAIN }), 400);
  assert(core.getUserById(otherUser.id).password_hash === beforeHash, 'a senha do usuário de outro tenant não pode mudar');
});

const NEW_PASSWORD = 'NewPass456';

test('resetPassword: sucesso — senha atualizada, token usado, sessão marcada trocada', async () => {
  const { res } = await callReset(tokenForUser, NEW_PASSWORD, NEW_PASSWORD, { domain: TENANT_DOMAIN });
  assert(res.body && res.body.success === true, 'deveria responder { success: true }');
  assert(!('password_hash' in (res.body || {})), 'a resposta nunca deve incluir password_hash');

  const fresh = core.getUserById(user.id);
  assert(bcrypt.compareSync(NEW_PASSWORD, fresh.password_hash), 'a nova senha deveria funcionar');
  assert(!bcrypt.compareSync(OLD_PASSWORD, fresh.password_hash), 'a senha antiga não deveria funcionar mais');
  assert(fresh.password_changed_at, 'password_changed_at deveria estar preenchido após a troca');
});

test('resetPassword: o mesmo token não pode ser reutilizado (replay)', async () => {
  await expectAppError(() => callReset(tokenForUser, 'OutraSenha789', 'OutraSenha789', { domain: TENANT_DOMAIN }), 400);
});

let tokenC = null;

test('gera um novo token válido para os testes de validação de senha', async () => {
  fetchCalls = [];
  await callForgotPassword(user.email, { domain: TENANT_DOMAIN });
  tokenC = extractTokenFromLastEmail();
});

test('resetPassword: confirmação diferente é rejeitada e não consome o token', async () => {
  await expectAppError(() => callReset(tokenC, 'SenhaForte123', 'SenhaDiferente456', { domain: TENANT_DOMAIN }), 400);
  const { res } = await callValidate(tokenC, { domain: TENANT_DOMAIN });
  assert(res.body.valid === true, 'uma tentativa com confirmação errada não deveria consumir o token');
});

test('resetPassword: senha curta/fraca é rejeitada', async () => {
  await expectAppError(() => callReset(tokenC, 'weak', 'weak', { domain: TENANT_DOMAIN }), 400);
  await expectAppError(() => callReset(tokenC, 'semmaiuscula1', 'semmaiuscula1', { domain: TENANT_DOMAIN }), 400);
});

test('nova solicitação invalida qualquer token anterior ainda ativo do mesmo usuário', async () => {
  fetchCalls = [];
  await callForgotPassword(user.email, { domain: TENANT_DOMAIN });
  const tokenD = extractTokenFromLastEmail();

  const oldStillValid = await callValidate(tokenC, { domain: TENANT_DOMAIN });
  assert(oldStillValid.res.body.valid === false, 'tokenC deveria ter sido invalidado pela nova solicitação (tokenD)');

  const newValid = await callValidate(tokenD, { domain: TENANT_DOMAIN });
  assert(newValid.res.body.valid === true, 'tokenD (o mais recente) deveria estar válido');
});

test('Brevo retorna erro: resposta ao cliente continua genérica, falha registrada no log', async () => {
  fetchMode = 'http-error';
  fetchCalls = [];
  const { res } = await callForgotPassword(user.email, { domain: TENANT_DOMAIN });
  assert(res.body && res.body.message, 'a resposta continua sendo a mensagem genérica mesmo com falha no envio');
  assert(fetchCalls.length === 1, 'deveria ter tentado enviar (e falhado)');

  const logs = lastActivityLogs(tenant.id, 5);
  assert(logs.some((l) => l.action === 'PASSWORD_RESET_EMAIL_FAILED'), 'deveria registrar PASSWORD_RESET_EMAIL_FAILED');
  fetchMode = 'ok';
});

test('sessão antiga (JWT) é invalidada após troca de senha; sessão nova continua válida', async () => {
  const beforeUser = core.getUserById(user.id);
  const oldJwt = signToken(beforeUser);

  fetchCalls = [];
  await callForgotPassword(user.email, { domain: TENANT_DOMAIN });
  const tokenG = extractTokenFromLastEmail();
  await callReset(tokenG, 'FinalPass000', 'FinalPass000', { domain: TENANT_DOMAIN });

  const oldReq = { headers: { authorization: `Bearer ${oldJwt}` } };
  const oldRes = mockRes();
  const oldErr = await new Promise((resolve) => requireAuth(oldReq, oldRes, (err) => resolve(err || null)));
  assert(oldErr instanceof AppError && oldErr.status === 401, 'o JWT emitido antes da troca deveria parar de funcionar');

  const freshUser = core.getUserById(user.id);
  const freshJwt = signToken(freshUser);
  const freshReq = { headers: { authorization: `Bearer ${freshJwt}` } };
  const freshRes = mockRes();
  const freshErr = await new Promise((resolve) => requireAuth(freshReq, freshRes, (err) => resolve(err || null)));
  assert(freshErr === null, 'um JWT emitido depois da troca deveria continuar funcionando');
  assert(freshReq.user && freshReq.user.id === user.id, 'requireAuth deveria popular req.user');
});

test('limpeza remove tokens usados/expirados há mais de 24h e preserva os demais', () => {
  const oldIso = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const recentIso = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

  const expiredOld = generateToken();
  core.insertPasswordResetToken({
    id: crypto.randomUUID(), user_id: user.id, tenant_id: tenant.id,
    token_hash: expiredOld.tokenHash, expires_at: oldIso, requested_ip: '1.1.1.1', requested_user_agent: 'test'
  });

  const usedOld = generateToken();
  const usedOldRow = core.insertPasswordResetToken({
    id: crypto.randomUUID(), user_id: user.id, tenant_id: tenant.id,
    token_hash: usedOld.tokenHash, expires_at: recentIso, requested_ip: '1.1.1.1', requested_user_agent: 'test'
  });
  core.getCoreDb().prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(oldIso, usedOldRow.id);

  const stillActive = generateToken();
  core.insertPasswordResetToken({
    id: crypto.randomUUID(), user_id: user.id, tenant_id: tenant.id,
    token_hash: stillActive.tokenHash, expires_at: recentIso, requested_ip: '1.1.1.1', requested_user_agent: 'test'
  });

  core.cleanupExpiredPasswordResetTokens();

  assert(!core.getPasswordResetTokenByHash(expiredOld.tokenHash), 'token expirado há mais de 24h deveria ser removido');
  assert(!core.getPasswordResetTokenByHash(usedOld.tokenHash), 'token usado há mais de 24h deveria ser removido');
  assert(core.getPasswordResetTokenByHash(stillActive.tokenHash), 'token ainda dentro da validade não deveria ser removido');
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testPasswordResetSystem] DATA_DIR isolado: ${TEST_DIR}`);
  await run();
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  }
  process.exit(failures ? 1 : 0);
})();
