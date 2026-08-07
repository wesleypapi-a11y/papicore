#!/usr/bin/env node
/*
 * testServicePackages.js
 *
 * Testes da Fase 1 — Pacotes de Serviços:
 *   - migração (tabelas, colunas novas, marcos em schema_migrations);
 *   - CRUD de modelos de pacote (validações e itens);
 *   - venda a cliente: snapshots, saldos, transações PURCHASE e entrada
 *     financeira única (valor convertido de centavos para REAL);
 *   - reserva/consumo/liberação idempotentes e sem saldo negativo;
 *   - ajuste manual (débito/crédito) com motivo obrigatório;
 *   - cobertura: "Este pacote não cobre todos os serviços selecionados.";
 *   - expiração (novas reservas bloqueadas, reservas ativas preservadas);
 *   - cancelamento (bloqueado com saldo reservado; CANCEL_PACKAGE após);
 *   - integração com agendamentos: criação (RESERVED), conclusão (CONSUMED
 *     sem lançamento financeiro) e cancelamento (RELEASED).
 *
 * Roda em DATA_DIR temporário (não toca os dados reais):
 *   node scripts/testServicePackages.js
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
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-packages-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';

const core = require('../database/coreDatabase');
const { openTenantDatabase, closeTenantDatabase, runWithTenant } = require('../database/tenantDatabase');
const packageService = require('../services/packageService');
const customerService = require('../services/customerService');
const adminController = require('../controllers/adminController');
const webhookService = require('../services/webhookService');
const { todayStr, toDateStr, addDays, formatCurrencyFromCents, normalizeBrazilianPhone } = require('../utils/helpers');

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
let serviceA = null;
let serviceB = null;
let serviceC = null;

function withDb(fn) {
  try {
    return runWithTenant(db, fn);
  } catch (err) {
    throw err;
  }
}

/* Serviço do tenant para novos pacotes (catálogo Torque ou criado). */
function pickService() {
  const s = db.prepare(
    "SELECT * FROM services WHERE active = 1 AND price_type = 'fixed' AND available_at_unit = 1 ORDER BY id ASC LIMIT 1"
  ).get();
  assert(s, 'tenant precisa de ao menos 1 serviço fixo ativo');
  return s;
}

function tomorrow() {
  return toDateStr(addDays(new Date(), 1));
}

function dayPlus(n) {
  return toDateStr(addDays(new Date(), n));
}

function appointmentBody(pkgId, service, extra = {}) {
  const unit = db.prepare('SELECT * FROM units WHERE active = 1 ORDER BY id ASC LIMIT 1').get();
  return {
    modality_id: 1,
    unit_id: unit ? unit.id : null,
    service_ids: [service.id],
    customer_name: 'Cliente Pacote Teste',
    customer_phone: '(11) 98888-0000',
    customer_email: 'pacote@teste.com.br',
    customer_cpf: null,
    vehicle_model: 'Gol',
    vehicle_year: '2020',
    vehicle_plate: 'ABC1234',
    vehicle_category: 'passeio',
    appointment_date: tomorrow(),
    start_time: '09:00',
    ...extra
  };
}

function callController(fn, params, body, user) {
  let result;
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
  fn({ body: body || {}, params: params || {}, query: {}, user: user || { id: 999, name: 'Teste', role: 'owner' } }, res);
  return { result, status: res.statusCode };
}

/* ---------- Testes ---------- */

test('initCore + tenant Torque: migração de pacotes aplicada (tabelas, colunas, marcos)', () => {
  core.initCore();
  const coreTenant = core.getTenantById(1);
  assert(coreTenant, 'tenant padrão torque-detail existe');
  tenantName = coreTenant.database_name;
  db = openTenantDatabase(tenantName);

  withDb(() => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
       ('customers', 'vehicles', 'service_packages', 'service_package_items',
        'customer_packages', 'customer_package_balances', 'package_transactions')`
    ).all().map((r) => r.name);
    for (const t of ['customers', 'vehicles', 'service_packages', 'service_package_items', 'customer_packages', 'customer_package_balances', 'package_transactions']) {
      assert(tables.includes(t), `tabela ${t} deve existir`);
    }

    const cols = db.prepare(`PRAGMA table_info(appointments)`).all().map((c) => c.name);
    for (const c of ['payment_source', 'customer_package_id', 'package_balance_id', 'package_credit_status', 'package_quantity']) {
      assert(cols.includes(c), `appointments deve ter coluna ${c}`);
    }
    const finCols = db.prepare(`PRAGMA table_info(financial_entries)`).all().map((c) => c.name);
    assert(finCols.includes('customer_package_id'), 'financial_entries deve ter customer_package_id');

    const marker = db.prepare("SELECT name FROM schema_migrations WHERE name = 'service_packages_v1'").get();
    assert(marker, 'migração service_packages_v1 registrada em schema_migrations');
  });
});

test('cria modelo de pacote com 2 serviços + validade + vínculo a veículo', () => {
  withDb(() => {
    serviceA = pickService();
    serviceB = pickService();
    if (serviceB.id === serviceA.id) {
      serviceB = db.prepare(
        "SELECT * FROM services WHERE active = 1 AND price_type = 'fixed' AND available_at_unit = 1 AND id != ? ORDER BY id ASC LIMIT 1"
      ).get(serviceA.id);
    }
    const pkg = packageService.createServicePackage(db, {
      name: 'Lavagem Premium',
      description: 'Pacote completo de lavagem',
      price: 'R$ 149,90',
      validity_days: 90,
      is_vehicle_bound: true,
      items: [
        { service_id: serviceA.id, quantity: 4 },
        { service_id: serviceB.id, quantity: 2 }
      ]
    }, 1);

    assert(pkg && pkg.id > 0, 'pacote criado');
    assert(pkg.price_cents === 14990, `preço em centavos (veio ${pkg.price_cents})`);
    assert(pkg.validity_days === 90, 'validade de 90 dias');
    assert(pkg.items.length === 2, '2 itens no pacote');
    assert(pkg.items.some((i) => i.service_id === serviceA.id && i.quantity === 4), 'item do serviço A (4)');
    assert(pkg.items.some((i) => i.service_id === serviceB.id && i.quantity === 2), 'item do serviço B (2)');
  });
});

test('validações do modelo: preço inválido, itens vazios, serviço duplicado', () => {
  withDb(() => {
    let threw = null;
    try {
      packageService.createServicePackage(db, { name: 'Nome X', price: 'abc', items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    } catch (e) { threw = e; }
    assert(threw && /preço/i.test(threw.message), 'preço inválido deve falhar');

    threw = null;
    try {
      packageService.createServicePackage(db, { name: 'Nome X', price: '50', items: [] }, 1);
    } catch (e) { threw = e; }
    assert(threw && /serviço/i.test(threw.message), 'itens vazios devem falhar');

    threw = null;
    try {
      packageService.createServicePackage(db, {
        name: 'Nome X',
        price: '50',
        items: [{ service_id: serviceA.id, quantity: 1 }, { service_id: serviceA.id, quantity: 2 }]
      }, 1);
    } catch (e) { threw = e; }
    assert(threw && /duas vezes/i.test(threw.message), 'serviço duplicado deve falhar');
  });
});

test('venda: snapshots, saldos PURCHASE e entrada financeira única (cents → REAL)', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Kit Mensal',
      price: '300,00',
      validity_days: 30,
      items: [
        { service_id: serviceA.id, quantity: 2 },
        { service_id: serviceB.id, quantity: 1 }
      ]
    }, 1);

    const sold = packageService.sellPackage(db, {
      package_id: pkg.id,
      customer: { name: 'João Silva', phone: '(11) 97777-1234', email: 'joao@teste.com' },
      vehicle: { model: 'Argo', plate: 'XYZ-9876', year: '2021', category: 'passeio' },
      payment_method: 'pix',
      purchased_at: todayStr(),
      notes: 'Venda na loja'
    }, 1);

    assert(sold.id > 0, 'pacote vendido com id');
    assert(sold.package_name_snapshot === 'Kit Mensal', 'snapshot do nome');
    assert(sold.price_cents_snapshot === 30000, 'snapshot do preço');
    assert(sold.purchase_price_cents === 30000, 'preço de venda = preço do pacote');
    assert(sold.status === 'ACTIVE', 'status ACTIVE');
    assert(sold.expires_at === toDateStr(addDays(todayStr(), 30)), 'expira em 30 dias');
    assert(sold.customer && sold.customer.name === 'João Silva', 'cliente vinculado');
    assert(sold.vehicle && sold.vehicle.plate === 'XYZ9876', 'veículo vinculado');
    assert(sold.balances.length === 2, '2 saldos');
    const balA = sold.balances.find((b) => b.service_id === serviceA.id);
    assert(balA && balA.total === 2 && balA.available === 2, 'saldo A: total 2, disponível 2');

    const stmt = packageService.getPackageStatement(db, sold.id);
    const purchases = stmt.transactions.filter((t) => t.transaction_type === 'PURCHASE');
    assert(purchases.length === 2, 'uma transação PURCHASE por serviço');
    assert(purchases.every((t) => t.balance_before === 0 && t.balance_after === t.quantity), 'PURCHASE de 0 → quantity');

    const entries = db.prepare('SELECT * FROM financial_entries WHERE customer_package_id = ?').all(sold.id);
    assert(entries.length === 1, 'exatamente 1 entrada financeira (dedup)');
    assert(entries[0].amount === 300, `entrada = 300 REAL (veio ${entries[0].amount})`);
    assert(entries[0].type === 'entrada', 'tipo entrada');
    assert(entries[0].service_name.includes('Kit Mensal'), 'service_name descreve o pacote');

    /* venda repetida no MESMO customer_package não cria nova entrada */
    const before = db.prepare('SELECT COUNT(*) AS n FROM financial_entries WHERE customer_package_id = ?').get(sold.id).n;
    const second = packageService.sellPackage(db, { package_id: pkg.id, customer_id: sold.customer_id, payment_method: 'pix' }, 1);
    assert(second.id !== sold.id, 'nova venda gera novo customer_package');
    assert(second.customer_id === sold.customer_id, 'mesmo cliente reutilizado');
    assert(db.prepare('SELECT COUNT(*) AS n FROM financial_entries WHERE customer_package_id = ?').get(second.id).n === 1, 'nova entrada para o novo pacote');
    assert(before === 1, 'entrada da 1ª venda permanece única');
  });
});

test('venda com desconto: preço de venda e entrada corretos; zero reais não gera entrada', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Com Desconto',
      price: '200,00',
      items: [{ service_id: serviceA.id, quantity: 3 }]
    }, 1);

    const sold = packageService.sellPackage(db, {
      package_id: pkg.id,
      customer: { name: 'Maria Oliveira', phone: '(11) 96666-2222' },
      discount: '50,00',
      payment_method: 'local'
    }, 1);
    assert(sold.discount_cents === 5000 && sold.purchase_price_cents === 15000, 'desconto de R$ 50 aplicado');
    const entry = db.prepare('SELECT * FROM financial_entries WHERE customer_package_id = ?').get(sold.id);
    assert(entry.amount === 150, 'entrada = R$ 150 (cents → REAL)');

    const zeroPkg = packageService.createServicePackage(db, {
      name: 'Cortesia',
      price: '0,00',
      items: [{ service_id: serviceB.id, quantity: 1 }]
    }, 1);
    const soldZero = packageService.sellPackage(db, { package_id: zeroPkg.id, customer: { name: 'Cortesia', phone: '(11) 95555-3333' } }, 1);
    assert(soldZero.purchase_price_cents === 0, 'venda gratuita');
    const zeroEntries = db.prepare('SELECT COUNT(*) AS n FROM financial_entries WHERE customer_package_id = ?').get(soldZero.id).n;
    assert(zeroEntries === 0, 'valor zero não gera entrada financeira');
  });
});

test('reserva: incrementa reservado, é idempotente e recusa saldo insuficiente', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Reserva Teste',
      price: '100,00',
      items: [{ service_id: serviceA.id, quantity: 1 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Reserva', phone: '(11) 94444-1111' } }, 1);
    const balA = sold.balances.find((b) => b.service_id === serviceA.id);

    const r1 = packageService.reservePackageCredit(db, {
      customerPackageId: sold.id,
      serviceId: serviceA.id,
      quantity: 1,
      appointmentId: 1001,
      reason: 'Reserva de teste'
    }, 1);
    assert(r1.created === true, '1ª reserva criada');
    assert(r1.reservation.transaction_type === 'RESERVE' && r1.reservation.balance_before === 1 && r1.reservation.balance_after === 0,
      'RESERVE de available 1 → 0');

    const r2 = packageService.reservePackageCredit(db, {
      customerPackageId: sold.id,
      serviceId: serviceA.id,
      quantity: 1,
      appointmentId: 1001,
      reason: 'Repetida'
    }, 1);
    assert(r2.created === false, 'reserva repetida para o mesmo agendamento não duplica');

    const balAfter = db.prepare('SELECT * FROM customer_package_balances WHERE id = ?').get(balA.id);
    assert(Number(balAfter.reserved_quantity) === 1, `reservado = 1 (veio ${balAfter.reserved_quantity})`);

    let threw = null;
    try {
      packageService.reservePackageCredit(db, {
        customerPackageId: sold.id,
        serviceId: serviceA.id,
        quantity: 1,
        appointmentId: 1002
      }, 1);
    } catch (e) { threw = e; }
    assert(threw && /saldo insuficiente/i.test(threw.message), 'saldo esgotado deve recusar nova reserva');
  });
});

test('consumo: reserva → consume; duplicado é no-op; status EXHAUSTED no fim', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Consumo Teste',
      price: '100,00',
      items: [{ service_id: serviceA.id, quantity: 1 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Consumo', phone: '(11) 93333-2222' } }, 1);
    packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 2001, reason: 'reserva' }, 1);

    const c1 = packageService.consumePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 2001, reason: 'conclusão' }, 1);
    assert(c1.created === true, 'consumo criado');

    const bal = db.prepare('SELECT * FROM customer_package_balances WHERE customer_package_id = ? AND service_id = ?')
      .get(sold.id, serviceA.id);
    assert(Number(bal.reserved_quantity) === 0 && Number(bal.consumed_quantity) === 1, 'consumido 1, reservado 0');

    const c2 = packageService.consumePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 2001 }, 1);
    assert(c2.created === false, 'consumo duplicado é no-op');

    const refreshed = packageService.getCustomerPackage(db, sold.id);
    assert(refreshed.status === 'EXHAUSTED', `status EXHAUSTED após consumir tudo (veio ${refreshed.status})`);

    let threw = null;
    try {
      packageService.consumePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 2002 }, 1);
    } catch (e) { threw = e; }
    assert(threw && /reserva/i.test(threw.message), 'consumir sem reserva deve falhar');
  });
});

test('liberação: reserve → release devolve saldo; no-op quando já liberado/consumido', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Release Teste',
      price: '100,00',
      items: [{ service_id: serviceA.id, quantity: 2 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Release', phone: '(11) 92222-1111' } }, 1);
    const balA = sold.balances.find((b) => b.service_id === serviceA.id);

    packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 3001 }, 1);
    const rel = packageService.releasePackageCredit(db, { balanceId: balA.id, appointmentId: 3001, reason: 'cancelamento' }, 1);
    assert(rel.created === true, 'release criado');

    const bal = db.prepare('SELECT * FROM customer_package_balances WHERE id = ?').get(balA.id);
    assert(Number(bal.reserved_quantity) === 0, 'reservado zerado após release');
    assert(packageService.availableOf(bal) === 2, `disponível volta a 2 (veio ${packageService.availableOf(bal)})`);

    const rel2 = packageService.releasePackageCredit(db, { balanceId: balA.id, appointmentId: 3001 }, 1);
    assert(rel2.created === false, 'release duplicado é no-op');

    /* consumido não pode ser liberado */
    packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 3002 }, 1);
    packageService.consumePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 3002 }, 1);
    const relAfterConsume = packageService.releasePackageCredit(db, { balanceId: balA.id, appointmentId: 3002 }, 1);
    assert(relAfterConsume.created === false, 'crédito já consumido não é liberado');
  });
});

test('ajuste manual: motivo obrigatório, débito sem saldo falha, crédito soma', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Ajuste Teste',
      price: '100,00',
      items: [{ service_id: serviceA.id, quantity: 1 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Ajuste', phone: '(11) 91111-0000' } }, 1);

    let threw = null;
    try {
      packageService.manualAdjustment(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, type: 'MANUAL_DEBIT', reason: 'x', userId: 1 });
    } catch (e) { threw = e; }
    assert(threw && /motivo/i.test(threw.message), 'débito sem motivo válido falha');

    threw = null;
    try {
      packageService.manualAdjustment(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 5, type: 'MANUAL_DEBIT', reason: 'Débito indevido de teste' , userId: 1});
    } catch (e) { threw = e; }
    assert(threw && /saldo insuficiente/i.test(threw.message), 'débito acima do saldo falha');

    const credited = packageService.manualAdjustment(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 2, type: 'MANUAL_CREDIT', reason: 'Cortesia de teste', userId: 1 });
    const bal = credited.balances.find((b) => b.service_id === serviceA.id);
    assert(bal.adjusted === 2 && bal.available === 3, `crédito manual: ajustado 2, disponível 3 (veio ${bal.available})`);

    const debited = packageService.manualAdjustment(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, type: 'MANUAL_DEBIT', reason: 'Correção de saldo', userId: 1 });
    const bal2 = debited.balances.find((b) => b.service_id === serviceA.id);
    assert(bal2.consumed === 1 && bal2.available === 2, 'débito manual consumido e disponível reduzido');

    const stmt = packageService.getPackageStatement(db, sold.id);
    const manuals = stmt.transactions.filter((t) => ['MANUAL_DEBIT', 'MANUAL_CREDIT'].includes(t.transaction_type));
    assert(manuals.length === 2, 'transações MANUAL_* registradas no histórico');
  });
});

test('cobertura: pacote que não cobre todos os serviços selecionados é recusado', () => {
  withDb(() => {
    serviceC = db.prepare(
      "SELECT * FROM services WHERE active = 1 AND id NOT IN (?, ?) ORDER BY id ASC LIMIT 1"
    ).get(serviceA.id, serviceB.id);
    assert(serviceC, 'terceiro serviço disponível para o teste');

    const pkg = packageService.createServicePackage(db, {
      name: 'Cobertura Teste',
      price: '100,00',
      items: [{ service_id: serviceA.id, quantity: 5 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Cobertura', phone: '(11) 90000-9999' } }, 1);

    let threw = null;
    try {
      packageService.validateCoverage(db, sold.id, [serviceA.id, serviceC.id]);
    } catch (e) { threw = e; }
    assert(threw && /não cobre todos os serviços selecionados/i.test(threw.message),
      'mensagem "Este pacote não cobre todos os serviços selecionados."');

    const ok = packageService.validateCoverage(db, sold.id, [serviceA.id]);
    assert(ok && ok.balances.length === 1, 'cobertura total aceita');
  });
});

test('expiração: novas reservas bloqueadas, reservas ativas preservadas, status EXPIRED', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Expira Teste',
      price: '100,00',
      validity_days: 1,
      items: [{ service_id: serviceA.id, quantity: 2 }]
    }, 1);
    const sold = packageService.sellPackage(db, {
      package_id: pkg.id,
      customer: { name: 'Expira', phone: '(11) 98888-7777' }
    }, 1);

    /* reserva feita enquanto o pacote estava válido permanece */
    packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 4001 }, 1);
    assert(packageService.getCustomerPackage(db, sold.id).status === 'ACTIVE', 'pacote válido reserva normalmente');

    /* simula o vencimento (expira ontem) mantendo a reserva ativa */
    db.prepare("UPDATE customer_packages SET expires_at = ? WHERE id = ?")
      .run(toDateStr(addDays(new Date(), -1)), sold.id);

    const stillValid = packageService.getCustomerPackage(db, sold.id);
    assert(stillValid.status === 'ACTIVE' && stillValid.totals.reserved === 1,
      `com reserva ativa o pacote vencido segue ACTIVE (veio ${stillValid.status})`);

    /* nova reserva bloqueada */
    let threw = null;
    try {
      packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 4002 }, 1);
    } catch (e) { threw = e; }
    assert(threw && /expirado/i.test(threw.message), 'reserva nova em pacote vencido é bloqueada');

    /* libera a reserva → status EXPIRED */
    packageService.releasePackageCredit(db, { balanceId: stillValid.balances[0].id, appointmentId: 4001, reason: 'libera para expirar' }, 1);
    const expired = packageService.getCustomerPackage(db, sold.id);
    assert(expired.status === 'EXPIRED', `sem reservas o vencido vira EXPIRED (veio ${expired.status})`);

    let threwReserve = null;
    try {
      packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 4003 }, 1);
    } catch (e) { threwReserve = e; }
    assert(threwReserve && /expirado/i.test(threwReserve.message), 'EXPIRED não pode ser usado');
  });
});

test('cancelamento: bloqueado com reserva ativa; CANCEL_PACKAGE após liberar', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Cancela Teste',
      price: '100,00',
      items: [{ service_id: serviceA.id, quantity: 3 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Cancela', phone: '(11) 97777-6666' } }, 1);

    packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 5001 }, 1);
    let threw = null;
    try {
      packageService.cancelCustomerPackage(db, sold.id, 'Quero cancelar', 1);
    } catch (e) { threw = e; }
    assert(threw && /reservado/i.test(threw.message), 'cancelar com saldo reservado é bloqueado');

    const balA = sold.balances.find((b) => b.service_id === serviceA.id);
    packageService.releasePackageCredit(db, { balanceId: balA.id, appointmentId: 5001, reason: 'liberar antes de cancelar' }, 1);

    const cancelled = packageService.cancelCustomerPackage(db, sold.id, 'Cliente pediu cancelamento', 1);
    assert(cancelled.status === 'CANCELLED', 'status CANCELLED');

    const stmt = packageService.getPackageStatement(db, sold.id);
    const cancels = stmt.transactions.filter((t) => t.transaction_type === 'CANCEL_PACKAGE');
    assert(cancels.length === 1, 'uma transação CANCEL_PACKAGE');
    assert(cancels[0].balance_before === 3 && cancels[0].balance_after === 0, 'CANCEL_PACKAGE zera o saldo remanescente');

    let threwReserve = null;
    try {
      packageService.reservePackageCredit(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, appointmentId: 5002 }, 1);
    } catch (e) { threwReserve = e; }
    assert(threwReserve && /cancelado/i.test(threwReserve.message), 'CANCELLED não pode ser usado');
  });
});

test('agendamento com pacote: criação RESERVED; conclusão CONSUMED sem lançamento financeiro; cancelamento RELEASED', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Pacote Agenda',
      price: '120,00',
      items: [{ service_id: serviceA.id, quantity: 2 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Agenda', phone: '(11) 96666-5555' } }, 1);

    const created = callController(adminController.createAppointment, null,
      appointmentBody(sold.id, serviceA, { customer_package_id: sold.id, customer_phone: '(11) 96666-5555' }), { id: 1, name: 'Admin', role: 'owner' });
    const appt = created.result;
    assert(appt && appt.id, 'agendamento criado');
    assert(appt.payment_source === 'PACKAGE', `payment_source PACKAGE (veio ${appt.payment_source})`);
    assert(appt.customer_package_id === sold.id, 'customer_package_id vinculado');
    assert(appt.package_credit_status === 'RESERVED', `crédito RESERVED (veio ${appt.package_credit_status})`);
    assert(Number(appt.package_quantity) === 1, 'package_quantity = 1');
    assert(Number(appt.total_price) === 0, 'agendamento PACKAGE sem valor a receber');

    const afterReserve = packageService.getCustomerPackage(db, sold.id);
    assert(afterReserve.totals.reserved === 1, `reservado 1 (veio ${afterReserve.totals.reserved})`);

    /* conclusão */
    const done = callController(adminController.completeAppointment, { id: appt.id }, { payment_method: 'package', customer_package_id: sold.id }, { id: 1, name: 'Admin', role: 'owner' });
    assert(done.result.appointment.status === 'completed', 'concluído');
    assert(done.result.appointment.package_credit_status === 'CONSUMED', `crédito CONSUMED (veio ${done.result.appointment.package_credit_status})`);
    const entry = db.prepare('SELECT * FROM financial_entries WHERE appointment_id = ?').get(appt.id);
    assert(!entry, 'agendamento PACKAGE NÃO gera entrada financeira na conclusão');
    const afterConsume = packageService.getCustomerPackage(db, sold.id);
    assert(afterConsume.totals.consumed === 1, 'consumido 1');

    /* novo agendamento + cancelamento libera */
    const created2 = callController(adminController.createAppointment, null,
      appointmentBody(sold.id, serviceA, { customer_package_id: sold.id, customer_phone: '(11) 96666-5555', start_time: '10:00', appointment_date: dayPlus(3) }), { id: 1, name: 'Admin', role: 'owner' });
    const appt2 = created2.result;
    const cancelled = callController(adminController.updateStatus, { id: appt2.id }, { status: 'cancelled' }, { id: 1, name: 'Admin', role: 'owner' });
    assert(cancelled.result.package_credit_status === 'RELEASED', `crédito RELEASED (veio ${cancelled.result.package_credit_status})`);
    const afterRelease = packageService.getCustomerPackage(db, sold.id);
    assert(afterRelease.totals.reserved === 0, 'reservado zerado após cancelamento');
  });
});

test('agendamento com pacote: excluir agendamento libera o crédito', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, {
      name: 'Pacote Exclui',
      price: '80,00',
      items: [{ service_id: serviceA.id, quantity: 1 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Exclui', phone: '(11) 95555-4444' } }, 1);

    const created = callController(adminController.createAppointment, null,
      appointmentBody(sold.id, serviceA, { customer_package_id: sold.id, customer_phone: '(11) 95555-4444', start_time: '11:00' }), { id: 1, name: 'Admin', role: 'owner' });
    const appt = created.result;
    assert(appt.package_credit_status === 'RESERVED', 'reserva feita');

    const del = callController(adminController.deleteAppointment, { id: appt.id }, null, { id: 1, name: 'Admin', role: 'owner' });
    assert(del.result.success === true, 'agendamento excluído');

    const refreshed = packageService.getCustomerPackage(db, sold.id);
    assert(refreshed.totals.reserved === 0 && refreshed.totals.available === 1,
      'crédito devolvido após exclusão do agendamento');
    const gone = db.prepare('SELECT id FROM appointments WHERE id = ?').get(appt.id);
    assert(!gone, 'agendamento realmente removido');
  });
});

test('cliente reutilizado por telefone; busca por nome retorna o cliente', () => {
  withDb(() => {
    const found = customerService.findCustomerByPhone(db, '(11) 97777-1234');
    assert(found && found.name === 'João Silva', 'findCustomerByPhone encontra João (criado na venda)');

    const list = customerService.searchCustomers(db, 'João');
    assert(list.some((c) => c.name === 'João Silva'), 'busca por nome encontra João');
  });
});

test('telefone brasileiro canônico: formatos nacionais e +55 resolvem o mesmo customer', () => {
  withDb(() => {
    const variants = ['(12) 99999-8888', '12 99999-8888', '12999998888', '+55 12 99999-8888', '5512999998888'];
    assert(variants.every((phone) => normalizeBrazilianPhone(phone) === '5512999998888'), 'todos os formatos devem gerar E.164 canônico');
    const first = customerService.findOrCreateCustomer(db, { name: 'Telefone Canônico', phone: variants[0] }).customer;
    const second = customerService.findOrCreateCustomer(db, { name: 'Mesmo Cliente', phone: variants[3] }).customer;
    assert(first.id === second.id, 'mesmo telefone deve reutilizar customer_id');
    assert(first.phone === '5512999998888', 'telefone armazenado no padrão canônico');
  });
});

test('segurança: pacote de outro cliente é rejeitado', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, { name: 'Pacote Proprietário', price: '50', items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Proprietário', phone: '(13) 99999-1111' } }, 1);
    const created = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceA, { customer_phone: '(13) 99999-2222', start_time: '13:00' }), { id: 1, role: 'owner' }).result;
    let error = null;
    try { packageService.assertPackageBelongsToAppointment(db, created, sold.id); } catch (e) { error = e; }
    assert(error && error.status === 422 && /não pertence/i.test(error.message), 'pacote alheio deve retornar erro controlado');
  });
});

test('atomicidade: falha no segundo serviço desfaz a primeira reserva', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, { name: 'Pacote Atômico', price: '70', items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Atômico', phone: '(14) 99999-1111' } }, 1);
    let error = null;
    try {
      packageService.reserveForAppointment(db, { customerPackageId: sold.id, serviceIds: [serviceA.id, serviceC.id], appointmentId: 987654, userId: 1 });
    } catch (e) { error = e; }
    assert(error && /não inclui/i.test(error.message), 'segundo serviço deve falhar');
    const refreshed = packageService.getCustomerPackage(db, sold.id);
    assert(refreshed.totals.reserved === 0 && refreshed.totals.available === 1, 'rollback deve remover a reserva parcial');
    assert(!db.prepare("SELECT id FROM package_transactions WHERE appointment_id=? AND transaction_type='RESERVE'").get(987654), 'histórico parcial também deve sofrer rollback');
  });
});

test('conclusão automática: único pacote, consumo idempotente e evento no outbox', () => {
  withDb(() => {
    const pkg = packageService.createServicePackage(db, { name: 'Pacote Automático', price: '90', validity_days: 20, items: [{ service_id: serviceA.id, quantity: 2 }] }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Auto', phone: '(15) 99999-1111' } }, 1);
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceA, { customer_phone: '+55 15 99999-1111', start_time: '14:00', appointment_date: dayPlus(4) }), { id: 1, role: 'owner' }).result;
    const first = callController(adminController.completeAppointment, { id: appt.id }, { payment_method: 'package' }, { id: 1, role: 'owner' }).result;
    assert(first.appointment.status === 'completed' && first.appointment.customer_package_id === sold.id, 'único pacote deve ser selecionado automaticamente');
    assert(packageService.getCustomerPackage(db, sold.id).totals.consumed === 1, 'um crédito consumido');
    const outbox = db.prepare("SELECT * FROM whatsapp_outbox WHERE event_key='PACKAGE_CREDIT_USED' AND idempotency_key=?").get(`PACKAGE_CREDIT_USED:${appt.id}`);
    assert(outbox && outbox.status === 'PENDING', 'evento deve estar no outbox, sem envio direto');
    const second = callController(adminController.completeAppointment, { id: appt.id }, { payment_method: 'package' }, { id: 1, role: 'owner' }).result;
    assert(second.alreadyCompleted === true, 'segunda conclusão deve ser idempotente');
    assert(packageService.getCustomerPackage(db, sold.id).totals.consumed === 1, 'segunda conclusão não consome novamente');
  });
});

test('elegibilidade: expira primeiro vem primeiro e veículo diferente é excluído', () => {
  withDb(() => {
    const customer = { name: 'Múltiplos', phone: '(16) 99999-1111' };
    const latePkg = packageService.createServicePackage(db, { name: 'Vence Depois', price: '50', validity_days: 60, items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const earlyPkg = packageService.createServicePackage(db, { name: 'Vence Antes', price: '50', validity_days: 10, items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const late = packageService.sellPackage(db, { package_id: latePkg.id, customer }, 1);
    const early = packageService.sellPackage(db, { package_id: earlyPkg.id, customer }, 1);
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceA, { customer_phone: customer.phone, start_time: '15:00', appointment_date: dayPlus(5) }), { id: 1, role: 'owner' }).result;
    const eligible = packageService.listEligiblePackagesForAppointment(db, appt.id);
    assert(eligible.length >= 2 && eligible[0].id === early.id && eligible.some((p) => p.id === late.id), 'pacote com validade mais próxima deve ser sugerido primeiro');

    const vehiclePkg = packageService.createServicePackage(db, { name: 'Outro Veículo', price: '50', is_vehicle_bound: true, items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const bound = packageService.sellPackage(db, { package_id: vehiclePkg.id, customer_id: early.customer_id, vehicle: { model: 'Civic', plate: 'ZZZ9Z99' } }, 1);
    const afterBound = packageService.listEligiblePackagesForAppointment(db, appt.id);
    assert(!afterBound.some((p) => p.id === bound.id), 'pacote vinculado a outro veículo não pode ser elegível');
  });
});

test('elegibilidade por serviço: pacote ativo incompatível retorna diagnóstico e não pode ser forçado pela API', () => {
  withDb(() => {
    const phone = '(17) 99999-1111';
    const pkg = packageService.createServicePackage(db, { name: 'Somente A', price: '50', items: [{ service_id: serviceA.id, quantity: 2 }] }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Incompatível', phone } }, 1);
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceC, { customer_phone: phone, start_time: '09:00', appointment_date: dayPlus(6) }), { id: 1, role: 'owner' }).result;

    const availability = packageService.evaluateAppointmentPackages(db, appt.id);
    assert(!availability.packagePaymentAvailable && availability.packages.length === 0, 'pagamento por pacote deve ficar indisponível');
    assert(availability.reason === 'SERVICE_NOT_INCLUDED', `motivo deve ser SERVICE_NOT_INCLUDED (veio ${availability.reason})`);
    assert(availability.uncoveredServices.includes(serviceC.name), 'diagnóstico deve nomear o serviço não coberto');

    const txBefore = db.prepare('SELECT COUNT(*) AS n FROM package_transactions WHERE appointment_id = ?').get(appt.id).n;
    const outboxBefore = db.prepare("SELECT COUNT(*) AS n FROM whatsapp_outbox WHERE idempotency_key = ?").get(`PACKAGE_CREDIT_USED:${appt.id}`).n;
    let error = null;
    try {
      callController(adminController.completeAppointment, { id: appt.id }, { payment_method: 'package', customer_package_id: sold.id }, { id: 1, role: 'owner' });
    } catch (e) { error = e; }
    assert(error && error.status === 422 && error.extra && error.extra.code === 'PACKAGE_NOT_ELIGIBLE', 'API deve rejeitar pacote incompatível com erro controlado');
    assert(db.prepare('SELECT status FROM appointments WHERE id = ?').get(appt.id).status !== 'completed', 'atendimento não deve ser concluído');
    assert(db.prepare('SELECT COUNT(*) AS n FROM package_transactions WHERE appointment_id = ?').get(appt.id).n === txBefore, 'tentativa inválida não cria transação');
    assert(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_outbox WHERE idempotency_key = ?").get(`PACKAGE_CREDIT_USED:${appt.id}`).n === outboxBefore, 'tentativa inválida não enfileira WhatsApp');
  });
});

test('múltiplos serviços: cobertura parcial e soma de dois pacotes não habilitam pagamento', () => {
  withDb(() => {
    const phone = '(18) 99999-1111';
    const pkgA = packageService.createServicePackage(db, { name: 'A separado', price: '40', items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const pkgC = packageService.createServicePackage(db, { name: 'C separado', price: '40', items: [{ service_id: serviceC.id, quantity: 1 }] }, 1);
    packageService.sellPackage(db, { package_id: pkgA.id, customer: { name: 'Dois Pacotes', phone } }, 1);
    packageService.sellPackage(db, { package_id: pkgC.id, customer: { name: 'Dois Pacotes', phone } }, 1);
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceA, { service_ids: [serviceA.id, serviceC.id], customer_phone: phone, start_time: '09:00', appointment_date: dayPlus(7) }), { id: 1, role: 'owner' }).result;
    const availability = packageService.evaluateAppointmentPackages(db, appt.id);
    assert(!availability.packagePaymentAvailable && availability.reason === 'NO_SINGLE_PACKAGE', 'um único pacote deve cobrir todo o atendimento');
    assert(/único pacote/i.test(availability.message), 'mensagem deve explicar que pacotes separados não são somados');
  });
});

test('concorrência: saldo alterado após abrir modal é recalculado e sofre rollback total', () => {
  withDb(() => {
    const phone = '(19) 99999-1111';
    const pkg = packageService.createServicePackage(db, { name: 'Saldo Volátil', price: '60', items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Saldo Volátil', phone } }, 1);
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceA, { customer_phone: phone, start_time: '09:00', appointment_date: dayPlus(10) }), { id: 1, role: 'owner' }).result;
    assert(packageService.evaluateAppointmentPackages(db, appt.id).packagePaymentAvailable, 'modal inicialmente encontra pacote elegível');
    packageService.manualAdjustment(db, { customerPackageId: sold.id, serviceId: serviceA.id, quantity: 1, type: 'MANUAL_DEBIT', reason: 'Uso concorrente', userId: 1 });
    let error = null;
    try {
      packageService.completeAppointmentWithPackage(db, { appointmentId: appt.id, customerPackageId: sold.id, userId: 1 });
    } catch (e) { error = e; }
    assert(error && error.status === 422, 'conclusão deve recalcular e rejeitar saldo alterado');
    assert(db.prepare('SELECT status FROM appointments WHERE id = ?').get(appt.id).status !== 'completed', 'rollback mantém atendimento aberto');
    assert(!db.prepare("SELECT id FROM package_transactions WHERE appointment_id = ? AND transaction_type IN ('RESERVE','CONSUME')").get(appt.id), 'rollback não deixa consumo parcial');
  });
});

test('regressão crítica: editar Lavagem para Polimento invalida pacote antigo na conclusão', () => {
  withDb(() => {
    const phone = '(21) 99999-1111';
    const pkg = packageService.createServicePackage(db, {
      name: 'Somente Lavagem',
      price: '100',
      items: [{ service_id: serviceA.id, quantity: 1 }]
    }, 1);
    const sold = packageService.sellPackage(db, {
      package_id: pkg.id,
      customer: { name: 'Serviço Editado', phone }
    }, 1);
    const originalBody = appointmentBody(sold.id, serviceA, {
      customer_phone: phone,
      customer_package_id: sold.id,
      appointment_date: dayPlus(12),
      start_time: '09:00'
    });
    const appt = callController(adminController.createAppointment, null, originalBody, { id: 1, role: 'owner' }).result;

    const editedBody = appointmentBody(null, serviceC, {
      customer_phone: phone,
      appointment_date: dayPlus(12),
      start_time: '09:00',
      status: appt.status
    });
    callController(adminController.updateAppointment, { id: appt.id }, editedBody, { id: 1, role: 'owner' });

    const edited = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appt.id);
    const finalSnapshot = JSON.parse(edited.services_json);
    assert(edited.service_id === serviceC.id && finalSnapshot.length === 1 && finalSnapshot[0].id === serviceC.id,
      'service_id e services_json devem apontar para o serviço final');
    assert(edited.service_name === serviceC.name && Number(edited.total_price) > 0,
      'nome e total devem ser recalculados na edição');
    assert(edited.package_credit_status === 'NONE' && edited.customer_package_id === null,
      'reserva antiga deve ser removida do atendimento');
    assert(packageService.getCustomerPackage(db, sold.id).totals.reserved === 0,
      'crédito reservado de Lavagem deve ser liberado');

    let error = null;
    try {
      callController(adminController.completeAppointment, { id: appt.id }, {
        payment_method: 'package',
        customer_package_id: sold.id
      }, { id: 1, role: 'owner' });
    } catch (e) { error = e; }

    assert(error && error.status === 422, 'pacote antigo deve ser rejeitado após a troca do serviço');
    assert(db.prepare('SELECT status FROM appointments WHERE id = ?').get(appt.id).status !== 'completed',
      'atendimento editado não pode ser concluído com pacote incompatível');
    assert(packageService.getCustomerPackage(db, sold.id).totals.consumed === 0,
      'nenhum crédito pode ser consumido');
  });
});

test('edição para outro serviço coberto reserva e consome somente o serviço final', () => {
  withDb(() => {
    const phone = '(22) 99999-1111';
    const pkg = packageService.createServicePackage(db, {
      name: 'Lavagem e Higienização', price: '180',
      items: [{ service_id: serviceA.id, quantity: 1 }, { service_id: serviceC.id, quantity: 1 }]
    }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Troca Coberta', phone } }, 1);
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(sold.id, serviceA, { customer_phone: phone, customer_package_id: sold.id, appointment_date: dayPlus(13) }),
      { id: 1, role: 'owner' }).result;
    callController(adminController.updateAppointment, { id: appt.id },
      appointmentBody(sold.id, serviceC, { customer_phone: phone, customer_package_id: sold.id, appointment_date: dayPlus(13), status: appt.status }),
      { id: 1, role: 'owner' });

    const done = callController(adminController.completeAppointment, { id: appt.id },
      { payment_method: 'package', customer_package_id: sold.id }, { id: 1, role: 'owner' }).result;
    assert(done.appointment.status === 'completed', 'troca para serviço coberto deve concluir');
    const consumed = db.prepare("SELECT b.service_id FROM package_transactions pt JOIN customer_package_balances b ON b.id=pt.balance_id WHERE pt.appointment_id=? AND pt.transaction_type='CONSUME'").all(appt.id);
    assert(consumed.length === 1 && consumed[0].service_id === serviceC.id, 'somente o serviço final deve ser consumido');
  });
});

test('modal antigo e services_json legado não autorizam pacote após mudança concorrente', () => {
  withDb(() => {
    const phone = '(23) 99999-1111';
    const pkg = packageService.createServicePackage(db, { name: 'Snapshot Antigo', price: '80', items: [{ service_id: serviceA.id, quantity: 1 }] }, 1);
    const sold = packageService.sellPackage(db, { package_id: pkg.id, customer: { name: 'Concorrente', phone } }, 1);
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceA, { customer_phone: phone, appointment_date: dayPlus(14) }), { id: 1, role: 'owner' }).result;
    assert(packageService.evaluateAppointmentPackages(db, appt.id).packagePaymentAvailable, 'preview inicial deve estar elegível');

    db.prepare('UPDATE appointments SET service_id=?, service_name=? WHERE id=?').run(serviceC.id, serviceC.name, appt.id);
    const guarded = packageService.evaluateAppointmentPackages(db, appt.id);
    assert(!guarded.packagePaymentAvailable && guarded.uncoveredServices.includes(serviceC.name),
      'service_id mais recente deve neutralizar services_json legado divergente');
    let error = null;
    try { packageService.completeAppointmentWithPackage(db, { appointmentId: appt.id, customerPackageId: sold.id, userId: 1 }); } catch (e) { error = e; }
    assert(error && error.extra && error.extra.code === 'PACKAGE_NOT_ELIGIBLE', 'confirmação deve recalcular e rejeitar o modal antigo');
    assert(packageService.getCustomerPackage(db, sold.id).totals.consumed === 0, 'rejeição concorrente não consome crédito');
  });
});

test('serviços finais editados alimentam preview e webhook de conclusão', () => {
  withDb(() => {
    const appt = callController(adminController.createAppointment, null,
      appointmentBody(null, serviceA, { customer_phone: '(24) 99999-1111', appointment_date: dayPlus(15) }), { id: 1, role: 'owner' }).result;
    const edited = callController(adminController.updateAppointment, { id: appt.id },
      appointmentBody(null, serviceC, { customer_phone: '(24) 99999-1111', appointment_date: dayPlus(15), status: appt.status }),
      { id: 1, role: 'owner' }).result;
    const preview = callController(require('../controllers/packageController').availableForAppointment, { id: appt.id }, null, { id: 1, role: 'owner' }).result;
    const payload = webhookService.buildAppointmentPayload(edited);
    assert(preview.services.length === 1 && preview.services[0].service_id === serviceC.id, 'preview deve exibir o serviço final');
    assert(payload.services.length === 1 && payload.services[0].id === serviceC.id, 'webhook deve publicar o serviço final');
    assert(Number(preview.totalFinal) === Number(edited.total_price), 'preview e atendimento devem usar o mesmo total final');
  });
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testServicePackages] DATA_DIR isolado: ${TEST_DIR}`);
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
