#!/usr/bin/env node
/*
 * testNewTenantOnboarding.js
 *
 * Testes do onboarding de novas empresas (multi-tenant isolado):
 *   - duas empresas novas nascem em bancos SQLite distintos e independentes;
 *   - o seed genérico é NEUTRO: nenhuma marca/preço/endereço herdado de outro
 *     cliente (sem Torque, sem "Rua das Flores", sem e-mail como telefone);
 *   - empresas novas começam com setup_status PENDING (sem serviços) e passam
 *     a READY quando ganham serviços;
 *   - a primeira unidade é OPCIONAL no cadastro da empresa: uma empresa nova
 *     pode nascer com units vazia (PENDING por falta de unidade e serviços) e
 *     receber a unidade depois pelo painel administrativo (controller real);
 *   - o catálogo Torque existe APENAS no tenant legado (fullCatalog) — usado
 *     exclusivamente pela migração da Torque Detail;
 *   - branding das empresas novas é neutro (sem logo/favicon próprios).
 *
 * Roda em um DATA_DIR temporário (não toca os dados reais de desenvolvimento):
 *   node scripts/testNewTenantOnboarding.js
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
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-onboarding-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';

const core = require('../database/coreDatabase');
const { createTenantDatabase, openTenantDatabase, closeTenantDatabase, runWithTenant } = require('../database/tenantDatabase');
const { buildDatabaseName, tenantDatabaseExists } = require('../database/createTenantDatabase');
const { computeSetupStatus } = require('../database/tenantSchema');
const unitController = require('../controllers/unitController');

/* ---------- Runner ---------- */

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

/* ---------- Helpers ---------- */

const FORBIDDEN = [/torque/i, /Rua das Flores/i, /\(00\)\s*00000-0000/];

function assertNoForeignData(db, label) {
  const scan = (table) =>
    db.prepare(`SELECT * FROM ${table}`).all().filter((row) =>
      Object.values(row).some((v) => FORBIDDEN.some((re) => re.test(String(v || ''))))
    );
  const inUnits = scan('units');
  const inCategories = scan('service_categories');
  const inServices = scan('services');
  const inSettings = scan('company_settings');
  assert(inUnits.length === 0 && inCategories.length === 0 && inServices.length === 0 && inSettings.length === 0,
    `${label}: dados herdados de outro cliente encontrados (units=${inUnits.length}, categorias=${inCategories.length}, serviços=${inServices.length}, settings=${inSettings.length})`);
}

function createNewTenant(name, slug, unit, domain) {
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
    domain: domain || null
  });
  return { databaseName, tenant: bundle.tenant };
}

function withDb(databaseName, fn) {
  const db = openTenantDatabase(databaseName);
  try {
    return fn(db);
  } finally {
    closeTenantDatabase(databaseName);
  }
}

/* ---------- Dados do formulário "Nova empresa" ---------- */

const UNIT_A = {
  name: 'Alpha Detalhes — Matriz',
  phone: '(11) 99888-7777',
  address_street: 'Av. Paulista, 1000',
  address: 'Av. Paulista, 1000 — Bela Vista, São Paulo, SP',
  address_zipcode: '01310100',
  address_city: 'São Paulo',
  address_state: 'SP',
  opening_time: '08:00',
  closing_time: '18:00',
  lunch_start: '12:00',
  lunch_end: '13:00',
  appointment_interval: 30,
  capacity: 2,
  working_days: [1, 2, 3, 4, 5, 6],
  active: 1
};

const UNIT_B = {
  name: 'Beta Detalhes — Filial',
  phone: '(21) 97777-6666',
  address_street: 'Av. Atlântica, 500',
  address: 'Av. Atlântica, 500 — Copacabana, Rio de Janeiro, RJ',
  address_zipcode: '22021001',
  address_city: 'Rio de Janeiro',
  address_state: 'RJ',
  opening_time: '09:00',
  closing_time: '19:00',
  lunch_start: '12:30',
  lunch_end: '14:00',
  appointment_interval: 45,
  capacity: 3,
  working_days: [1, 2, 3, 4, 5],
  active: 1
};

/* Unidade cadastrada DEPOIS da criação da empresa, pelo painel administrativo
   (controller real de unidades) — não faz parte do formulário "Nova empresa". */
const UNIT_C = {
  name: 'Gama Detalhes — Matriz',
  phone: '(31) 98888-9999',
  address: 'Rua dos Pinheiros, 250 — Funcionários, Belo Horizonte, MG',
  address_street: 'Rua dos Pinheiros',
  address_number: '250',
  address_neighborhood: 'Funcionários',
  address_city: 'Belo Horizonte',
  address_state: 'MG',
  opening_time: '08:30',
  closing_time: '18:30',
  appointment_interval: 60,
  capacity: 2,
  working_days: [1, 2, 3, 4, 5, 6],
  active: 1
};

/* ---------- Testes ---------- */

let coreTenant;
let alpha = null;
let beta = null;
let gamma = null;

test('initCore cria o core e o tenant padrão Torque Detail no DATA_DIR isolado', () => {
  core.initCore();
  coreTenant = core.getTenantById(1);
  assert(coreTenant && coreTenant.slug === 'torque-detail', 'tenant padrão torque-detail deve existir');
  assert(fs.existsSync(path.join(TEST_DIR, 'tenants', coreTenant.database_name)), 'banco do tenant padrão deve existir');
});

test('empresa nova A: seed neutro com dados reais do formulário, sem Torque e sem e-mail como telefone', () => {
  alpha = createNewTenant('Alpha Detalhes', 'alpha-detalhes', UNIT_A, 'alphadetalhes.com.br');
  assert(alpha.tenant && alpha.tenant.id >= 2, 'tenant A criado no core');
  assert(tenantDatabaseExists(alpha.databaseName), 'banco A existe');

  const domainA = core.getDomainRow('alphadetalhes.com.br');
  assert(domainA && domainA.tenant_id === alpha.tenant.id, 'domínio de A registrado no core');
  assert(domainA.verified === 1, 'domínio criado junto com a empresa já nasce VERIFICADO');

  withDb(alpha.databaseName, (db) => {
    const s = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
    assert(s.company_name === 'Alpha Detalhes', `company_name deve vir do cadastro ("${s.company_name}")`);
    assert(s.phone === UNIT_A.phone, 'phone deve ser o telefone real, nunca o e-mail do admin');

    const units = db.prepare('SELECT * FROM units').all();
    assert(units.length === 1, 'deve nascer com exatamente 1 unidade');
    assert(units[0].name === UNIT_A.name, 'nome da unidade vindo do formulário');
    assert(!/Rua das Flores/i.test(units[0].address), 'unidade sem endereço placeholder');
    assert(!/@/.test(units[0].phone), 'unidade sem e-mail no telefone');

    const modalities = db.prepare('SELECT * FROM service_modalities').all();
    assert(modalities.length === 3, '3 modalidades padrão');
    assert(modalities.every((m) => Number(m.fee) === 0), 'modalidades sem taxa herdada (fee 0)');

    const services = db.prepare('SELECT COUNT(*) AS n FROM services').get().n;
    assert(services === 0, 'empresa nova NÃO recebe serviços de catálogo');

    const categories = db.prepare('SELECT name FROM service_categories ORDER BY id ASC').all();
    const names = categories.map((c) => c.name);
    assert(names.some((n) => /lavagem/i.test(n)) && !names.some((n) => /torque/i.test(n)),
      'categorias neutras (sem marca Torque)');

    assertNoForeignData(db, 'empresa A');

    const setup = computeSetupStatus(db);
    assert(setup.status === 'PENDING', `A deve começar PENDING (veio ${setup.status})`);
    assert(setup.missing.includes('serviços'), 'A está PENDING por falta de serviços');
  });
});

test('empresa nova B: banco e dados totalmente independentes de A', () => {
  beta = createNewTenant('Beta Detalhes', 'beta-detalhes', UNIT_B, 'betadetalhes.com.br');
  assert(beta.databaseName !== alpha.databaseName, 'bancos A e B devem ser arquivos distintos');
  assert(fs.existsSync(path.join(TEST_DIR, 'tenants', beta.databaseName)), 'banco B existe');

  withDb(beta.databaseName, (db) => {
    const s = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
    assert(s.company_name === 'Beta Detalhes', `company_name de B independente (veio "${s.company_name}")`);
    assert(s.phone === UNIT_B.phone, 'phone de B = telefone de B');

    const units = db.prepare('SELECT name, address FROM units').all();
    assert(units.length === 1 && units[0].name === UNIT_B.name, 'unidade de B não pode ser a de A');
    assert(units[0].address.includes('Atlântica') && !units[0].address.includes('Paulista'), 'endereço de B não pode ser o de A');

    const services = db.prepare('SELECT COUNT(*) AS n FROM services').get().n;
    assert(services === 0, 'B também nasce sem serviços');

    assertNoForeignData(db, 'empresa B');
    const setup = computeSetupStatus(db);
    assert(setup.status === 'PENDING', 'B deve começar PENDING');
  });
});

test('add de serviço em A não vaza para B; A vira READY e B continua PENDING', () => {
  withDb(alpha.databaseName, (db) => {
    const catId = db.prepare('SELECT id FROM service_categories ORDER BY id ASC LIMIT 1').get().id;
    db.prepare(
      `INSERT INTO services
         (category_id, name, slug, description, price_type, fixed_price, duration_minutes, available_at_unit, available_pickup_delivery, available_mobile_delivery, active, display_order)
       VALUES (?, ?, ?, ?, 'fixed', 100, 60, 1, 1, 1, 1, 1)`
    ).run(catId, 'Lavagem Neutra', 'lavagem-neutra', 'Serviço exclusivo de A');
    const setup = computeSetupStatus(db);
    assert(setup.status === 'READY', `A deve virar READY com unidade+modalidades+serviço+horários (veio ${setup.status})`);
  });

  withDb(beta.databaseName, (db) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM services').get().n;
    assert(n === 0, `B não pode ver o serviço de A (encontrados ${n})`);
    const setup = computeSetupStatus(db);
    assert(setup.status === 'PENDING', 'B continua PENDING');
  });
});

test('catálogo Torque só existe no tenant legado (fullCatalog) — a migração da Torque Detail', () => {
  withDb(coreTenant.database_name, (db) => {
    const services = db.prepare('SELECT name FROM services').all();
    assert(services.some((s) => /torque/i.test(s.name)), 'tenant legado deve ter o catálogo Torque');
  });
  withDb(alpha.databaseName, (db) => {
    const services = db.prepare('SELECT COUNT(*) AS n FROM services').get().n;
    assert(services === 1, `A deve ter apenas o próprio serviço (${services})`);
    const withTorque = db.prepare("SELECT COUNT(*) AS n FROM services WHERE name LIKE '%Torque%'").get().n;
    assert(withTorque === 0, 'A não pode ter serviços Torque');
  });
});

test('empresa nova C: criada SEM unidade — units vazia e PENDING; unidade adicionada depois pelo admin vira READY', () => {
  gamma = createNewTenant('Gama Detalhes', 'gama-detalhes', null, 'gamadetalhes.com.br');
  assert(gamma.tenant && gamma.tenant.id >= 2, 'tenant C criado no core');
  assert(tenantDatabaseExists(gamma.databaseName), 'banco C existe');

  withDb(gamma.databaseName, (db) => {
    const units = db.prepare('SELECT COUNT(*) AS n FROM units').get().n;
    assert(units === 0, `empresa nova SEM unidade nasce com units vazia (encontradas ${units})`);

    const setup = computeSetupStatus(db);
    assert(setup.status === 'PENDING', 'C deve começar PENDING sem unidade');
    assert(setup.missing.includes('unidade'), `C falta 'unidade' (veio: ${setup.missing.join(', ')})`);
    assert(setup.missing.includes('serviços'), `C também falta 'serviços' (veio: ${setup.missing.join(', ')})`);
  });

  /* Admin cadastra a primeira unidade pelo controller REAL de unidades
     (mesma validação do painel /admin), dentro do contexto do banco de C. */
  withDb(gamma.databaseName, (db) => {
    let unitId = null;
    runWithTenant(db, () => {
      const res = { status: () => res, json: (d) => { unitId = d.id; return res; } };
      unitController.create({ body: UNIT_C }, res);
    });
    assert(unitId != null, 'controller de unidades retornou a unidade criada');

    const units = db.prepare('SELECT * FROM units ORDER BY id ASC').all();
    assert(units.length === 1, `após cadastrar unidade: exatamente 1 unidade (tem ${units.length})`);
    assert(units[0].name === UNIT_C.name, 'nome da unidade vindo do cadastro do admin');
    assert(units[0].phone === UNIT_C.phone, 'telefone real da unidade (nunca e-mail)');
    assert(units[0].working_days.includes('1'), 'dias de funcionamento salvos');

    const setup = computeSetupStatus(db);
    assert(setup.status === 'PENDING' && setup.missing.includes('serviços'), 'C segue PENDING apenas por falta de serviços');
  });

  /* Admin cadastra o primeiro serviço → C fica READY. */
  withDb(gamma.databaseName, (db) => {
    const catId = db.prepare('SELECT id FROM service_categories ORDER BY id ASC LIMIT 1').get().id;
    db.prepare(
      `INSERT INTO services
         (category_id, name, slug, description, price_type, fixed_price, duration_minutes, available_at_unit, available_pickup_delivery, available_mobile_delivery, active, display_order)
       VALUES (?, ?, ?, ?, 'fixed', 120, 75, 1, 1, 1, 1, 1)`
    ).run(catId, 'Polimento Completo', 'polimento-completo', 'Serviço exclusivo de C');
    const setup = computeSetupStatus(db);
    assert(setup.status === 'READY', `C vira READY com unidade+modalidades+serviço+horários (veio ${setup.status})`);
  });
});

test('branding das empresas novas é neutro (sem logo/favicon próprios)', () => {
  for (const t of [alpha, beta]) {
    const row = core.getTenantBranding(t.tenant.id);
    assert(!row || (!row.logo_path && !row.favicon_path),
      `empresa ${t.tenant.slug} não deve ter logo/favicon próprios`);
  }
});

test('nome de banco é seguro e previsível (tenant_XXXX_slug.db)', () => {
  assert(/^tenant_\d{4}_alpha_detalhes\.db$/.test(alpha.databaseName), `padrão de nome do banco A (veio "${alpha.databaseName}")`);
  assert(/^tenant_\d{4}_beta_detalhes\.db$/.test(beta.databaseName), `padrão de nome do banco B (veio "${beta.databaseName}")`);
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testNewTenantOnboarding] DATA_DIR isolado: ${TEST_DIR}`);
  await run();
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  }
  process.exit(failures ? 1 : 0);
})();
