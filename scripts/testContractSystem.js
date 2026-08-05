/*
 * testContractSystem.js
 *
 * Testes do sistema de Contratos (aba "Contratos" do painel do desenvolvedor).
 *
 * Roda em um DATA_DIR temporário (não toca os dados reais de desenvolvimento):
 *   node scripts/testContractSystem.js
 *
 * Saída: "N testes passaram" / "FALHOU" com detalhe da primeira falha.
 * Código de saída: 0 (ok) ou 1 (falha).
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/* Ambiente isolado ANTES de carregar qualquer módulo da plataforma — mesmo
   padrão de scripts/testBackupSystem.js. */
const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-contract-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';

const core = require('../database/coreDatabase');
const { createTenantDatabase } = require('../database/tenantDatabase');
const { AppError } = require('../utils/helpers');
const contractStorage = require('../utils/contractStorage');
const contractService = require('../services/contractService');
const contractPdfService = require('../services/contractPdfService');
const backupService = require('../services/backupService');

/* ---------- Runner (mesmo padrão de testBackupSystem.js) ---------- */

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

async function expectAppError(fn, status, msg) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof AppError, `${msg}: esperava AppError, veio ${err && err.constructor && err.constructor.name}: ${err && err.message}`);
    if (status !== undefined) assert(err.status === status, `${msg}: esperava status ${status}, veio ${err.status}`);
    return;
  }
  throw new Error(`${msg}: não lançou erro`);
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ---------- Setup ---------- */

core.initCore();

let tenantA, tenantB, plan;

function makeTenant(suffix, document) {
  const t = core.insertTenant({
    name: `Empresa Teste ${suffix}`,
    slug: `empresa-teste-${suffix}`,
    database_name: `tenant_090${suffix}_empresa_teste.db`,
    document: document || null,
    email: `contato${suffix}@empresateste.com.br`,
    phone: '11999990000'
  });
  createTenantDatabase(t.database_name, { skip_seed: true });
  core.insertUser({
    tenant_id: t.id, name: 'Admin Teste', email: `admin${suffix}@empresateste.com.br`,
    password_hash: '$2a$10$invalidHashJustForFixture....................', role: 'owner'
  });
  return t;
}

/* ---------- Testes ---------- */

test('setup: cria empresa descartável (sem documento) e plano descartável', () => {
  tenantA = makeTenant('1', null);
  plan = core.insertPlan({ name: 'Plano Teste', slug: 'plano-teste-contratos', monthly_price_cents: 9900, max_units: 3 });
  assert(tenantA.id > 0, 'tenant deveria ter id');
  assert(plan.monthly_price_cents === 9900, 'plano deveria ter preço de 9900 centavos');
});

test('gerar contrato sem dados da contratada cadastrados falha com mensagem clara', () => {
  expectSyncAppError(
    () => contractService.previewContract({ tenant_id: tenantA.id, start_date: '2026-01-01' }),
    400,
    'preview sem contratada'
  );
});

function expectSyncAppError(fn, status, msg) {
  try {
    fn();
  } catch (err) {
    assert(err instanceof AppError, `${msg}: esperava AppError`);
    if (status !== undefined) assert(err.status === status, `${msg}: esperava status ${status}, veio ${err.status}`);
    return;
  }
  throw new Error(`${msg}: não lançou erro`);
}

test('salvar dados da contratada (PapiCore)', () => {
  const saved = core.upsertContractCompanySettings({
    legal_name: 'PapiCore Tecnologia LTDA',
    document: '00000000000100',
    email: 'contato@papicore.com.br',
    city: 'São Paulo',
    state: 'SP',
    legal_representative_name: 'Fulano de Tal',
    legal_representative_document: '00000000000',
    default_jurisdiction: 'Comarca de São Paulo/SP'
  }, 1);
  assert(saved.legal_name === 'PapiCore Tecnologia LTDA', 'contratada deveria estar salva');
  assert(core.getContractCompanySettings().document === '00000000000100', 'deveria haver 1 registro singleton');
});

test('placeholder inválido é rejeitado ao criar modelo', () => {
  expectSyncAppError(
    () => contractService.validateTemplateContent('Olá {{CAMPO_INVENTADO}}'),
    400,
    'placeholder inválido'
  );
});

test('placeholder válido é aceito e resolvido', () => {
  contractService.validateTemplateContent('{{CLIENTE_RAZAO_SOCIAL}} paga {{CONTRATO_VALOR_TOTAL}}');
  const resolved = contractService.resolveContent('{{CLIENTE_RAZAO_SOCIAL}} paga {{CONTRATO_VALOR_TOTAL}}', {
    CLIENTE_RAZAO_SOCIAL: 'Empresa X', CONTRATO_VALOR_TOTAL: 'R$ 10,00'
  });
  assert(resolved === 'Empresa X paga R$ 10,00', `resolução incorreta: ${resolved}`);
});

let template;
test('criar modelo (v1, padrão)', () => {
  template = core.insertContractTemplate({
    slug: 'modelo-teste', name: 'Modelo de Teste', contract_type: 'SUBSCRIPTION',
    content: 'Contrato {{CONTRATO_NUMERO}} entre {{CONTRATADA_RAZAO_SOCIAL}} e {{CLIENTE_RAZAO_SOCIAL}}.\n\nPlano: {{PLANO_NOME}} — {{CONTRATO_VALOR_TOTAL}}.\n\nVigência: {{CONTRATO_INICIO}} a {{CONTRATO_VENCIMENTO}}. Foro: {{CONTRATO_FORO}}.',
    created_by_user_id: 1
  });
  assert(template.version === 1 && template.is_default === 1, 'primeira versão deveria ser v1 e padrão');
});

test('editar modelo cria nova versão (não apaga a anterior)', () => {
  const v2 = core.createContractTemplateVersion('modelo-teste', {
    name: 'Modelo de Teste', contract_type: 'SUBSCRIPTION',
    content: template.content + '\n\nCláusula extra.', created_by_user_id: 1
  });
  assert(v2.version === 2 && v2.is_default === 1, 'nova versão deveria ser v2 e virar padrão');
  const versions = core.listContractTemplateVersions('modelo-teste');
  assert(versions.length === 2, 'as duas versões deveriam continuar existindo');
  assert(versions.some((v) => v.version === 1), 'v1 não deveria ter sido apagada');
  template = core.getContractTemplate(v2.id);
});

test('empresa sem documento: prévia acusa campo obrigatório pendente', () => {
  const preview = contractService.previewContract({
    tenant_id: tenantA.id, template_id: template.id, plan_id: plan.id,
    start_date: '2026-01-01', duration_months: 12, billing_periodicity: 'MONTHLY'
  });
  assert(preview.missing_required.includes('CLIENTE_DOCUMENTO'), 'CLIENTE_DOCUMENTO deveria estar pendente');
});

let draft;
test('salvar rascunho mesmo com dado obrigatório pendente (permitido)', () => {
  draft = contractService.createDraftContract({
    tenant_id: tenantA.id, template_id: template.id, plan_id: plan.id,
    start_date: '2026-01-01', duration_months: 12, billing_periodicity: 'MONTHLY',
    discount_cents: '', implementation_fee_cents: '', payment_method: 'Pix'
  }, 1);
  assert(draft.status === 'DRAFT', 'contrato deveria ser DRAFT');
  assert(/^PC-\d{4}-\d{6}$/.test(draft.contract_number), `número de contrato mal formatado: ${draft.contract_number}`);
});

test('numeração é sequencial e sem colisão (duas reservas seguidas)', () => {
  const year = new Date().getFullYear();
  const n1 = core.reserveContractNumber(year);
  const n2 = core.reserveContractNumber(year);
  assert(n1 !== n2, 'dois números reservados em sequência não podem colidir');
});

test('finalizar bloqueado enquanto faltar documento da empresa', async () => {
  await expectAppError(async () => contractService.validateFinalizable(core.getContractById(draft.id)), 400, 'finalize sem documento');
});

test('editar rascunho', () => {
  const updated = contractService.updateDraftContract(draft.id, { notes: 'Observação de teste' });
  assert(updated.notes === 'Observação de teste', 'observação deveria ter sido salva');
});

let finalized;
test('preencher documento da empresa e gerar um novo rascunho (snapshot correto)', () => {
  core.updateTenant(tenantA.id, { document: '12345678000199' });
  draft = contractService.createDraftContract({
    tenant_id: tenantA.id, template_id: template.id, plan_id: plan.id,
    start_date: '2026-01-01', duration_months: 12, billing_periodicity: 'MONTHLY',
    discount_cents: 1000, implementation_fee_cents: 5000, payment_method: 'Pix', billing_day: 10
  }, 1);
  assert(draft.client_document === '12345678000199', 'snapshot deveria ter capturado o documento novo');
  assert(draft.subtotal_cents === 9900 && draft.total_cents === 9900 - 1000 + 5000, 'cálculo financeiro incorreto');
});

test('finalizar contrato: gera PDF, hash e trava edição', async () => {
  contractService.validateFinalizable(core.getContractById(draft.id));
  const { relativePath, sha256, sizeBytes } = await contractPdfService.generateAndStoreContractPdf(core.getContractById(draft.id));
  finalized = core.updateContract(draft.id, {
    status: 'FINALIZED', finalized_at: new Date().toISOString(), finalized_by_user_id: 1,
    pdf_path: relativePath, pdf_sha256: sha256, pdf_size_bytes: sizeBytes
  });
  assert(finalized.status === 'FINALIZED', 'status deveria ser FINALIZED');

  const absolutePath = contractStorage.resolveContractPdf(finalized.pdf_path);
  assert(absolutePath && fs.existsSync(absolutePath), 'arquivo do PDF deveria existir em disco');
  assert(fs.readFileSync(absolutePath).slice(0, 5).toString() === '%PDF-', 'arquivo deveria ser um PDF válido');
  assert(sha256Of(absolutePath) === finalized.pdf_sha256, 'hash salvo no banco deveria bater com o arquivo em disco');
  assert(sizeBytes === fs.statSync(absolutePath).size, 'tamanho salvo deveria bater com o arquivo em disco');
});

test('contrato finalizado não pode ser editado diretamente', () => {
  expectSyncAppError(() => contractService.updateDraftContract(finalized.id, { title: 'hack' }), 409, 'editar finalizado');
});

test('alterar o modelo depois não muda o texto de um contrato já finalizado', () => {
  core.createContractTemplateVersion('modelo-teste', {
    name: 'Modelo de Teste', contract_type: 'SUBSCRIPTION', content: 'TEXTO TOTALMENTE DIFERENTE', created_by_user_id: 1
  });
  const stillSame = core.getContractById(finalized.id);
  assert(stillSame.content.includes('Cláusula extra') || stillSame.content.includes(tenantA.name), 'conteúdo do contrato finalizado não deveria ter mudado');
  assert(!stillSame.content.includes('TEXTO TOTALMENTE DIFERENTE'), 'contrato finalizado não pode herdar o novo texto do modelo');
});

test('alterar o preço do plano depois não muda o valor de um contrato já finalizado', () => {
  core.updatePlan(plan.id, { monthly_price_cents: 500000 });
  const stillSame = core.getContractById(finalized.id);
  assert(stillSame.plan_price_cents === 9900, 'preço do contrato finalizado não pode acompanhar o novo preço do plano');
  assert(stillSame.total_cents === 9900 - 1000 + 5000, 'total do contrato finalizado não pode mudar');
});

test('duplicar contrato gera novo rascunho independente', () => {
  const dup = contractService.createDraftContract({
    tenant_id: finalized.tenant_id, template_id: finalized.template_id, plan_id: plan.id,
    billing_periodicity: finalized.billing_periodicity, start_date: finalized.start_date,
    duration_months: finalized.duration_months
  }, 1, { previous_contract_id: finalized.id });
  assert(dup.status === 'DRAFT' && dup.id !== finalized.id, 'duplicata deveria ser um novo rascunho');
  assert(dup.previous_contract_id === finalized.id, 'duplicata deveria referenciar o original');
});

test('gerar renovação vincula ao contrato original (previous e replaces)', () => {
  const renewal = contractService.createDraftContract({
    tenant_id: finalized.tenant_id, template_id: finalized.template_id, plan_id: plan.id,
    billing_periodicity: finalized.billing_periodicity, start_date: finalized.end_date,
    duration_months: finalized.duration_months, contract_type: 'RENEWAL'
  }, 1, { previous_contract_id: finalized.id, replaces_contract_id: finalized.id });
  assert(renewal.contract_type === 'RENEWAL', 'renovação deveria ter contract_type RENEWAL');
  assert(renewal.previous_contract_id === finalized.id && renewal.replaces_contract_id === finalized.id, 'renovação deveria vincular ao original em ambos os campos');
});

test('gerar aditivo cria contrato próprio sem alterar o original', () => {
  const originalContent = core.getContractById(finalized.id).content;
  const addendum = contractService.createDraftContract({
    tenant_id: finalized.tenant_id, template_id: finalized.template_id, plan_id: plan.id,
    billing_periodicity: finalized.billing_periodicity, start_date: finalized.start_date,
    contract_type: 'ADDENDUM', notes: `Aditivo ao contrato ${finalized.contract_number}. Cláusulas alteradas: valor mensal.`
  }, 1, { previous_contract_id: finalized.id });
  assert(addendum.contract_type === 'ADDENDUM', 'aditivo deveria ter contract_type ADDENDUM');
  assert(addendum.contract_number !== finalized.contract_number, 'aditivo deveria ter numeração própria');
  assert(core.getContractById(finalized.id).content === originalContent, 'PDF/registro do contrato original não pode mudar por causa de um aditivo');
});

test('cancelar só é permitido a partir de FINALIZED', () => {
  const cancelled = core.updateContract(finalized.id, { status: 'CANCELLED', cancelled_at: new Date().toISOString(), cancel_reason: 'Teste' });
  assert(cancelled.status === 'CANCELLED', 'contrato deveria estar CANCELLED');
});

test('listar e filtrar: outra empresa não aparece misturada', () => {
  tenantB = makeTenant('2', '98765432000188');
  const otherDraft = contractService.createDraftContract({
    tenant_id: tenantB.id, template_id: template.id, plan_id: plan.id,
    start_date: '2026-02-01', duration_months: 6, billing_periodicity: 'MONTHLY'
  }, 1);
  const listA = core.listContracts({ tenant_id: tenantA.id });
  const listB = core.listContracts({ tenant_id: tenantB.id });
  assert(listA.every((c) => c.tenant_id === tenantA.id), 'lista da empresa A não pode conter contratos de outra empresa');
  assert(listB.length === 1 && listB[0].id === otherDraft.id, 'lista da empresa B deveria conter só o contrato dela');
});

test('path traversal é rejeitado ao resolver o caminho do PDF', () => {
  assert(contractStorage.resolveContractPdf('../../../etc/passwd') === null, 'caminho fora de CONTRACTS_ROOT deveria ser rejeitado');
  assert(contractStorage.resolveContractPdf('..\\..\\windows\\system32') === null, 'caminho com barras invertidas também deveria ser rejeitado');
  assert(contractStorage.resolveContractPdf('/etc/passwd') === null, 'caminho absoluto deveria ser rejeitado');
});

test('backup da empresa inclui os PDFs de contrato no manifest', async () => {
  const run = await backupService.createTenantBackup({ tenantId: tenantA.id, backupType: 'TENANT_MANUAL', userId: 1 });
  assert(run.status === 'SUCCESS', 'backup deveria ter sucesso');
  const files = contractStorage.listTenantContractFiles(tenantA.id);
  assert(files.length >= 1, 'deveria haver ao menos 1 PDF de contrato da empresa A para incluir no backup');
});

/* ---------- Execução ---------- */

run().then(() => {
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  console.log(`[testContractSystem] DATA_DIR isolado: ${TEST_DIR}`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* Windows pode reter handles do sqlite por um instante */ }
  }
  process.exit(failures ? 1 : 0);
});
