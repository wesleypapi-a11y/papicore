/*
 * packageService.js
 *
 * Núcleo da Fase 1 — Pacotes de serviços.
 *
 * Responsabilidades:
 *   - CRUD de modelos de pacote (service_packages + service_package_items);
 *   - venda de pacote a um cliente (customer_packages + balances + entrada
 *     financeira única, deduplicada por customer_package_id);
 *   - reserva / consumo / liberação de créditos atrelados a agendamentos;
 *   - débito/crédito manual com motivo obrigatório;
 *   - cancelamento e expiração com histórico imutável (package_transactions).
 *
 * Regras invariantes:
 *   - disponível = total + ajustado - reservado - consumido (nunca salvo);
 *   - saldo nunca fica negativo (UPDATE condicional dentro de transação);
 *   - nunca reserva/consome/libera duas vezes o mesmo crédito;
 *   - pacote vencido bloqueia NOVAS reservas, mas mantém as já feitas;
 *   - dinheiro sempre em centavos (inteiros) aqui; a conversão para REAL só
 *     acontece na borda de financial_entries (que usa REAL por legado).
 *
 * O banco é sempre o do contexto (getDb via AsyncLocalStorage). Nenhum
 * tenant_id vem do frontend.
 */

const { getDb } = require('../database/tenantDatabase');
const {
  AppError,
  PAYMENT_METHODS,
  todayStr,
  addDays,
  toDateStr,
  isValidDateStr,
  isValidPhone,
  isValidEmail,
  normalizePhone,
  parseCurrencyToCents,
  formatCurrencyFromCents
} = require('../utils/helpers');
const customerService = require('./customerService');

const PACKAGE_STATUSES = ['ACTIVE', 'EXHAUSTED', 'EXPIRED', 'CANCELLED', 'SUSPENDED'];
const TX_TYPES = [
  'PURCHASE',
  'RESERVE',
  'CONSUME',
  'RELEASE',
  'MANUAL_DEBIT',
  'MANUAL_CREDIT',
  'CANCEL_PACKAGE',
  'EXPIRE',
  'TRANSFER'
];

/* Status que bloqueiam o uso (reserva) do pacote. */
const BLOCKED_USE_STATUSES = ['CANCELLED', 'SUSPENDED'];

function availableOf(balance) {
  return (
    Number(balance.total_quantity || 0) +
    Number(balance.adjusted_quantity || 0) -
    Number(balance.reserved_quantity || 0) -
    Number(balance.consumed_quantity || 0)
  );
}

function newTxId(type) {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TX-${type}-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

function centsToReal(cents) {
  return (Number(cents) || 0) / 100;
}

function isExpired(cp, today) {
  return Boolean(cp.expires_at) && cp.expires_at < (today || todayStr());
}

function computeExhausted(balances) {
  return balances.length > 0 && balances.every((b) => availableOf(b) <= 0);
}

function isReserved(balances) {
  return balances.some((b) => Number(b.reserved_quantity || 0) > 0);
}

/*
 * Recalcula o status armazenado do pacote (derivado). Não é agendado:
 * é chamado nas consultas (get/list) e após operações que alteram saldo.
 * CANCELLED e SUSPENDED são fixos.
 */
function refreshStatus(db, customerPackageId) {
  const cp = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(customerPackageId);
  if (!cp) return null;
  if (BLOCKED_USE_STATUSES.includes(cp.status)) return cp;

  const balances = db.prepare(
    'SELECT * FROM customer_package_balances WHERE customer_package_id = ?'
  ).all(customerPackageId);
  const today = todayStr();
  let next = 'ACTIVE';
  if (isExpired(cp, today)) {
    next = isReserved(balances) ? 'ACTIVE' : 'EXPIRED';
  } else if (computeExhausted(balances)) {
    next = 'EXHAUSTED';
  }
  if (next !== cp.status) {
    db.prepare("UPDATE customer_packages SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(next, customerPackageId);
    cp.status = next;
  }
  return cp;
}

/* Atualiza em lote os pacotes expirados sem reservas pendentes. */
function applyExpirations(db) {
  const today = todayStr();
  const candidates = db.prepare(
    `SELECT cp.id FROM customer_packages cp
     WHERE cp.expires_at IS NOT NULL AND cp.expires_at < ?
       AND cp.status NOT IN ('CANCELLED', 'SUSPENDED', 'EXPIRED')`
  ).all(today);
  let updated = 0;
  for (const row of candidates) {
    const cp = refreshStatus(db, row.id);
    if (cp && cp.status === 'EXPIRED') updated += 1;
  }
  return updated;
}

/* ---------------------------------------------------------------- Modelos */

function getServicePackage(db, id) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return null;
  const pkg = db.prepare('SELECT * FROM service_packages WHERE id = ?').get(Number(id));
  if (!pkg) return null;
  pkg.items = db.prepare(
    `SELECT pi.id, pi.service_id, pi.quantity, s.name AS service_name, s.active AS service_active
     FROM service_package_items pi
     JOIN services s ON s.id = pi.service_id
     WHERE pi.package_id = ?
     ORDER BY pi.id ASC`
  ).all(pkg.id);
  return pkg;
}

function listServicePackages(db, opts = {}) {
  const where = opts.includeInactive ? '' : ' WHERE active = 1';
  const rows = db.prepare(
    `SELECT sp.*,
            COALESCE(SUM(pi.quantity), 0) AS total_quantity,
            COUNT(pi.id) AS service_count
     FROM service_packages sp
     LEFT JOIN service_package_items pi ON pi.package_id = sp.id
     ${where}
     GROUP BY sp.id
     ORDER BY sp.active DESC, sp.name ASC`
  ).all();
  for (const pkg of rows) {
    pkg.items = db.prepare(
      `SELECT pi.id, pi.service_id, pi.quantity, s.name AS service_name, s.active AS service_active
       FROM service_package_items pi
       JOIN services s ON s.id = pi.service_id
       WHERE pi.package_id = ?
       ORDER BY pi.id ASC`
    ).all(pkg.id);
  }
  return rows;
}

function validatePackageItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new AppError(400, 'Adicione ao menos um serviço ao pacote.');
  }
  const seen = new Set();
  const validated = [];
  for (const item of items) {
    const serviceId = Number(item.service_id);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      throw new AppError(400, 'Selecione um serviço válido no pacote.');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new AppError(400, 'Quantidade de serviços deve ser maior que zero.');
    }
    if (seen.has(serviceId)) {
      throw new AppError(400, 'O mesmo serviço não pode aparecer duas vezes no pacote.');
    }
    seen.add(serviceId);
    const svc = db.prepare('SELECT id, name FROM services WHERE id = ?').get(serviceId);
    if (!svc) throw new AppError(400, `Serviço id ${serviceId} não encontrado.`);
    validated.push({ service_id: serviceId, service_name: svc.name, quantity });
  }
  return validated;
}

function validatePackageBase(db, body) {
  const name = body.name ? String(body.name).trim() : '';
  if (name.length < 2) throw new AppError(400, 'Informe o nome do pacote.');

  const priceCents = parseCurrencyToCents(body.price);
  if (priceCents === null || priceCents === undefined) {
    throw new AppError(400, 'Informe o preço do pacote (em R$).');
  }

  let validityDays = null;
  if (body.validity_days !== undefined && body.validity_days !== null && body.validity_days !== '') {
    validityDays = Number(body.validity_days);
    if (!Number.isInteger(validityDays) || validityDays <= 0) {
      throw new AppError(400, 'Validade deve ser um número inteiro de dias.');
    }
  }

  const items = validatePackageItems(db, body.items);

  return {
    name,
    description: body.description ? String(body.description).trim() : null,
    price_cents: priceCents,
    validity_days: validityDays,
    is_vehicle_bound: body.is_vehicle_bound ? 1 : 0,
    is_transferable: body.is_transferable ? 1 : 0,
    items
  };
}

function createServicePackage(db, body, userId) {
  const data = validatePackageBase(db, body);
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO service_packages
        (name, description, price_cents, validity_days, is_vehicle_bound, is_transferable)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      data.name,
      data.description,
      data.price_cents,
      data.validity_days,
      data.is_vehicle_bound,
      data.is_transferable
    );
    const insertItem = db.prepare(
      'INSERT INTO service_package_items (package_id, service_id, quantity) VALUES (?, ?, ?)'
    );
    for (const item of data.items) {
      insertItem.run(info.lastInsertRowid, item.service_id, item.quantity);
    }
    return info.lastInsertRowid;
  });
  return getServicePackage(db, tx());
}

function updateServicePackage(db, id, body, userId) {
  const existing = getServicePackage(db, id);
  if (!existing) throw new AppError(404, 'Pacote não encontrado.');

  const data = validatePackageBase(db, body);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE service_packages SET
         name = ?, description = ?, price_cents = ?, validity_days = ?,
         is_vehicle_bound = ?, is_transferable = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(
      data.name,
      data.description,
      data.price_cents,
      data.validity_days,
      data.is_vehicle_bound,
      data.is_transferable,
      id
    );
    db.prepare('DELETE FROM service_package_items WHERE package_id = ?').run(id);
    const insertItem = db.prepare(
      'INSERT INTO service_package_items (package_id, service_id, quantity) VALUES (?, ?, ?)'
    );
    for (const item of data.items) {
      insertItem.run(id, item.service_id, item.quantity);
    }
  });
  tx();
  return getServicePackage(db, id);
}

function setServicePackageActive(db, id, active) {
  const existing = getServicePackage(db, id);
  if (!existing) throw new AppError(404, 'Pacote não encontrado.');
  db.prepare("UPDATE service_packages SET active = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
    .run(active ? 1 : 0, id);
  return getServicePackage(db, id);
}

/* ---------------------------------------------------------------- Venda */

/*
 * Efetua a venda de um pacote. Retorna o customer_package completo.
 * O lançamento financeiro (receita) é criado uma única vez, vinculado por
 * customer_package_id (dedup), apenas quando o valor de venda é > 0.
 */
function sellPackage(db, payload, userId) {
  const pkg = getServicePackage(db, payload.package_id);
  if (!pkg) throw new AppError(404, 'Pacote não encontrado.');
  if (!pkg.active) throw new AppError(400, 'Este pacote está inativo e não pode ser vendido.');

  let customer = null;
  if (payload.customer_id) {
    customer = customerService.findCustomerById(db, payload.customer_id);
    if (!customer) throw new AppError(404, 'Cliente não encontrado.');
  } else {
    const result = customerService.findOrCreateCustomer(db, payload.customer || {});
    customer = result.customer;
  }

  let discountCents = 0;
  if (payload.discount_cents !== undefined && payload.discount_cents !== null) {
    discountCents = Number.isFinite(Number(payload.discount_cents))
      ? Math.max(0, Math.trunc(Number(payload.discount_cents)))
      : 0;
  } else if (payload.discount !== undefined && payload.discount !== null && payload.discount !== '') {
    const parsed = parseCurrencyToCents(payload.discount);
    if (parsed === null) throw new AppError(400, 'Valor de desconto inválido.');
    discountCents = parsed;
  }
  if (discountCents > pkg.price_cents) {
    throw new AppError(400, 'O desconto não pode ser maior que o preço do pacote.');
  }
  const purchasePrice = pkg.price_cents - discountCents;

  let paymentMethod = null;
  if (payload.payment_method) {
    paymentMethod = String(payload.payment_method).toLowerCase();
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new AppError(400, 'Forma de pagamento inválida.');
    }
  }

  const purchasedAt = payload.purchased_at || todayStr();
  if (!isValidDateStr(purchasedAt)) throw new AppError(400, 'Data de compra inválida.');

  /* Veículo: obrigatório quando o pacote é vinculado a veículo. */
  let vehicle = null;
  if (payload.vehicle_id) {
    vehicle = customerService.getVehicleById(db, payload.vehicle_id);
    if (!vehicle || vehicle.customer_id !== customer.id) {
      throw new AppError(400, 'O veículo informado não pertence a este cliente.');
    }
  } else if (payload.vehicle && (payload.vehicle.model || payload.vehicle.plate)) {
    vehicle = customerService.findOrCreateVehicle(db, customer.id, payload.vehicle).vehicle;
  } else if (pkg.is_vehicle_bound) {
    throw new AppError(400, 'Este pacote é vinculado a um veículo. Informe o veículo do cliente.');
  }

  const expiresAt = pkg.validity_days ? toDateStr(addDays(purchasedAt, pkg.validity_days)) : null;

  const cpId = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO customer_packages
        (customer_id, vehicle_id, package_id, package_name_snapshot, price_cents_snapshot,
         purchase_price_cents, discount_cents, payment_method, purchased_at, starts_at, expires_at,
         status, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      customer.id,
      vehicle ? vehicle.id : null,
      pkg.id,
      pkg.name,
      pkg.price_cents,
      purchasePrice,
      discountCents,
      paymentMethod,
      purchasedAt,
      purchasedAt,
      expiresAt,
      'ACTIVE',
      payload.notes ? String(payload.notes).trim() : null,
      userId || null
    );
    const cpIdValue = info.lastInsertRowid;

    const insertBalance = db.prepare(
      `INSERT INTO customer_package_balances
        (customer_package_id, service_id, service_name_snapshot, total_quantity)
       VALUES (?, ?, ?, ?)`
    );
    const insertTx = db.prepare(
      `INSERT INTO package_transactions
        (id, customer_package_id, balance_id, service_id, appointment_id,
         transaction_type, quantity, balance_before, balance_after, reason, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, NULL, 'PURCHASE', ?, 0, ?, ?, ?, ?)`
    );
    const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const item of pkg.items) {
      const b = insertBalance.run(cpIdValue, item.service_id, item.service_name, item.quantity);
      insertTx.run(
        newTxId('PURCHASE'),
        cpIdValue,
        b.lastInsertRowid,
        item.service_id,
        item.quantity,
        item.quantity,
        'Compra do pacote',
        userId || null,
        createdAt
      );
    }

    if (purchasePrice > 0) {
      const existing = db.prepare('SELECT id FROM financial_entries WHERE customer_package_id = ?').get(cpIdValue);
      if (!existing) {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        db.prepare(
          `INSERT INTO financial_entries
            (customer_name, service_id, service_name, amount, type, entry_date, entry_time,
             payment_method, notes, appointment_id, customer_package_id)
           VALUES (?, NULL, ?, ?, 'entrada', ?, ?, ?, ?, NULL, ?)`
        ).run(
          customer.name,
          `Pacote: ${pkg.name}`,
          centsToReal(purchasePrice),
          purchasedAt,
          time,
          paymentMethod,
          `Venda de pacote ${pkg.name} — ${formatCurrencyFromCents(purchasePrice)}`,
          cpIdValue
        );
      }
    }

    return cpIdValue;
  })();

  return getCustomerPackage(db, cpId);
}

/* --------------------------------------------------------- Pacotes vendidos */

function getCustomerPackage(db, id) {
  const cp = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(Number(id));
  if (!cp) return null;

  const refreshed = refreshStatus(db, cp.id);
  Object.assign(cp, refreshed);

  cp.balances = db.prepare(
    'SELECT * FROM customer_package_balances WHERE customer_package_id = ? ORDER BY id ASC'
  ).all(cp.id).map((b) => ({
    id: b.id,
    service_id: b.service_id,
    service_name: b.service_name_snapshot,
    total: Number(b.total_quantity),
    reserved: Number(b.reserved_quantity),
    consumed: Number(b.consumed_quantity),
    adjusted: Number(b.adjusted_quantity),
    available: availableOf(b)
  }));

  cp.totals = cp.balances.reduce((acc, b) => {
    acc.total += b.total;
    acc.reserved += b.reserved;
    acc.consumed += b.consumed;
    acc.adjusted += b.adjusted;
    acc.available += b.available;
    return acc;
  }, { total: 0, reserved: 0, consumed: 0, adjusted: 0, available: 0 });

  cp.customer = db.prepare('SELECT id, name, phone, email, cpf FROM customers WHERE id = ?').get(cp.customer_id) || null;
  cp.vehicle = cp.vehicle_id ? customerService.getVehicleById(db, cp.vehicle_id) : null;
  cp.package = db.prepare('SELECT id, name, description, validity_days, is_vehicle_bound, is_transferable FROM service_packages WHERE id = ?').get(cp.package_id) || null;
  cp.expired = isExpired(cp);
  cp.can_reserve = !BLOCKED_USE_STATUSES.includes(cp.status) && !isExpired(cp);
  return cp;
}

function listCustomerPackages(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.customer_id) {
    where.push('cp.customer_id = ?');
    params.push(Number(filters.customer_id));
  }
  if (filters.status && filters.status !== 'all' && filters.status !== '') {
    where.push('cp.status = ?');
    params.push(filters.status);
  }
  if (filters.search && String(filters.search).trim()) {
    const term = `%${String(filters.search).trim()}%`;
    where.push('(cp.package_name_snapshot LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(term, term, term);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT cp.*, c.name AS customer_name, c.phone AS customer_phone
     FROM customer_packages cp
     JOIN customers c ON c.id = cp.customer_id
     ${whereSql}
     ORDER BY cp.created_at DESC, cp.id DESC`
  ).all(...params);

  return rows.map((cp) => {
    const full = getCustomerPackage(db, cp.id);
    return {
      id: cp.id,
      customer_id: cp.customer_id,
      customer_name: cp.customer_name,
      customer_phone: cp.customer_phone,
      package_name: cp.package_name_snapshot,
      purchase_price_cents: cp.purchase_price_cents,
      discount_cents: cp.discount_cents,
      payment_method: cp.payment_method,
      purchased_at: cp.purchased_at,
      expires_at: cp.expires_at,
      status: full.status,
      expired: full.expired,
      can_reserve: full.can_reserve,
      totals: full.totals,
      balances: full.balances,
      vehicle: full.vehicle ? { id: full.vehicle.id, plate: full.vehicle.plate, brand: full.vehicle.brand, model: full.vehicle.model } : null
    };
  });
}

function getPackageStatement(db, customerPackageId) {
  const cp = getCustomerPackage(db, customerPackageId);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  const rows = db.prepare(
    `SELECT pt.id, pt.service_id, b.service_name_snapshot AS service_name, pt.appointment_id,
            pt.transaction_type, pt.quantity, pt.balance_before, pt.balance_after,
            pt.reason, pt.created_by_user_id, pt.created_at,
            a.appointment_code
     FROM package_transactions pt
     JOIN customer_package_balances b ON b.id = pt.balance_id
     LEFT JOIN appointments a ON a.id = pt.appointment_id
     WHERE pt.customer_package_id = ?
     ORDER BY pt.created_at DESC, pt.id DESC`
  ).all(customerPackageId);
  return { package: cp, transactions: rows };
}

/* --------------------------------------------------- Reserva / consumo / liberação */

function getBalance(db, customerPackageId, serviceId) {
  return db.prepare(
    'SELECT * FROM customer_package_balances WHERE customer_package_id = ? AND service_id = ?'
  ).get(customerPackageId, serviceId);
}

function assertUsable(db, customerPackageId) {
  const cp = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(customerPackageId);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  if (BLOCKED_USE_STATUSES.includes(cp.status)) {
    throw new AppError(400, `Pacote ${cp.status === 'CANCELLED' ? 'cancelado' : 'suspenso'} não pode ser utilizado.`);
  }
  if (isExpired(cp)) {
    throw new AppError(400, 'Este pacote está expirado. Não é possível reservar novos agendamentos.');
  }
  return cp;
}

function hasReserve(db, balanceId, appointmentId) {
  return db.prepare(
    `SELECT * FROM package_transactions
     WHERE balance_id = ? AND appointment_id = ? AND transaction_type = 'RESERVE'`
  ).get(balanceId, appointmentId);
}

function hasConsume(db, balanceId, appointmentId) {
  return db.prepare(
    `SELECT * FROM package_transactions
     WHERE balance_id = ? AND appointment_id = ? AND transaction_type = 'CONSUME'`
  ).get(balanceId, appointmentId);
}

function hasRelease(db, balanceId, appointmentId) {
  return db.prepare(
    `SELECT * FROM package_transactions
     WHERE balance_id = ? AND appointment_id = ? AND transaction_type = 'RELEASE'`
  ).get(balanceId, appointmentId);
}

/*
 * Reserva crédito do pacote para um agendamento.
 * Idempotente: se já existe RESERVE para balance+appointment, retorna o
 * registro existente sem reservar novamente.
 */
function reservePackageCredit(db, { customerPackageId, serviceId, quantity = 1, appointmentId, reason, userId }) {
  assertUsable(db, customerPackageId);
  const balance = getBalance(db, customerPackageId, serviceId);
  if (!balance) {
    throw new AppError(400, 'O pacote não inclui este serviço.');
  }

  const existing = appointmentId != null ? hasReserve(db, balance.id, appointmentId) : null;
  if (existing) return { reservation: existing, created: false };

  const before = availableOf(balance);
  if (before < quantity) {
    throw new AppError(409, 'Saldo insuficiente no pacote para este serviço.');
  }

  const tx = db.transaction(() => {
    const res = db.prepare(
      `UPDATE customer_package_balances
       SET reserved_quantity = reserved_quantity + ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ? AND (total_quantity + adjusted_quantity - reserved_quantity - consumed_quantity) >= ?`
    ).run(quantity, balance.id, quantity);
    if (res.changes === 0) {
      throw new AppError(409, 'Saldo insuficiente no pacote para este serviço.');
    }
    const afterBalance = db.prepare('SELECT * FROM customer_package_balances WHERE id = ?').get(balance.id);
    const after = availableOf(afterBalance);
    db.prepare(
      `INSERT INTO package_transactions
        (id, customer_package_id, balance_id, service_id, appointment_id, transaction_type,
         quantity, balance_before, balance_after, reason, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'RESERVE', ?, ?, ?, ?, ?, ?)`
    ).run(
      newTxId('RESERVE'),
      customerPackageId,
      balance.id,
      serviceId,
      appointmentId || null,
      quantity,
      before,
      after,
      reason || 'Reserva para agendamento',
      userId || null,
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    );
    if (appointmentId != null) {
      db.prepare(
        `UPDATE appointments SET customer_package_id = ?, package_credit_status = 'RESERVED'
         WHERE id = ? AND package_credit_status = 'NONE'`
      ).run(customerPackageId, appointmentId);
    }
    return { reservation: hasReserve(db, balance.id, appointmentId), created: true };
  });
  return tx();
}

/*
 * Consome o crédito reservado (na conclusão do agendamento).
 * Requer RESERVE prévia para o mesmo balance+appointment e é idempotente.
 */
function consumePackageCredit(db, { customerPackageId, serviceId, quantity = 1, appointmentId, reason, userId }) {
  const balance = getBalance(db, customerPackageId, serviceId);
  if (!balance) throw new AppError(400, 'O pacote não inclui este serviço.');

  const reserve = appointmentId != null ? hasReserve(db, balance.id, appointmentId) : null;
  if (!reserve) {
    throw new AppError(400, 'Nenhuma reserva de crédito encontrada para este agendamento.');
  }
  if (appointmentId != null && hasConsume(db, balance.id, appointmentId)) {
    const consumed = hasConsume(db, balance.id, appointmentId);
    return { consume: consumed, created: false };
  }

  const before = availableOf(balance);
  const tx = db.transaction(() => {
    const res = db.prepare(
      `UPDATE customer_package_balances
       SET reserved_quantity = reserved_quantity - ?,
           consumed_quantity = consumed_quantity + ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ? AND reserved_quantity >= ?`
    ).run(quantity, quantity, balance.id, quantity);
    if (res.changes === 0) {
      throw new AppError(409, 'Crédito reservado insuficiente para consumir.');
    }
    const afterBalance = db.prepare('SELECT * FROM customer_package_balances WHERE id = ?').get(balance.id);
    const after = availableOf(afterBalance);
    db.prepare(
      `INSERT INTO package_transactions
        (id, customer_package_id, balance_id, service_id, appointment_id, transaction_type,
         quantity, balance_before, balance_after, reason, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'CONSUME', ?, ?, ?, ?, ?, ?)`
    ).run(
      newTxId('CONSUME'),
      customerPackageId,
      balance.id,
      serviceId,
      appointmentId || null,
      quantity,
      before,
      after,
      reason || 'Consumo na conclusão do agendamento',
      userId || null,
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    );
    if (appointmentId != null) {
      db.prepare("UPDATE appointments SET package_credit_status = 'CONSUMED' WHERE id = ? AND package_credit_status = 'RESERVED'")
        .run(appointmentId);
    }
    const consumed = hasConsume(db, balance.id, appointmentId);
    return { consume: consumed, created: true };
  });
  const result = tx();
  refreshStatus(db, customerPackageId);
  return result;
}

/*
 * Libera (devolve) o crédito reservado (cancelamento/exclusão de agendamento).
 * No-op se não houver reserva ou se o crédito já foi consumido/liberado.
 */
function releasePackageCredit(db, { balanceId, appointmentId, reason, userId }) {
  if (appointmentId == null) throw new AppError(400, 'Informe o agendamento para liberar o crédito.');
  const balance = db.prepare('SELECT * FROM customer_package_balances WHERE id = ?').get(balanceId);
  if (!balance) throw new AppError(404, 'Saldo do pacote não encontrado.');

  const reserve = hasReserve(db, balanceId, appointmentId);
  if (!reserve) return { released: null, created: false };
  if (hasConsume(db, balanceId, appointmentId)) return { released: null, created: false };
  if (hasRelease(db, balanceId, appointmentId)) {
    return { released: hasRelease(db, balanceId, appointmentId), created: false };
  }

  const quantity = Number(reserve.quantity) || 1;
  const before = availableOf(balance);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE customer_package_balances
       SET reserved_quantity = reserved_quantity - ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ? AND reserved_quantity >= ?`
    ).run(quantity, balanceId, quantity);
    const afterBalance = db.prepare('SELECT * FROM customer_package_balances WHERE id = ?').get(balanceId);
    const after = availableOf(afterBalance);
    db.prepare(
      `INSERT INTO package_transactions
        (id, customer_package_id, balance_id, service_id, appointment_id, transaction_type,
         quantity, balance_before, balance_after, reason, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'RELEASE', ?, ?, ?, ?, ?, ?)`
    ).run(
      newTxId('RELEASE'),
      balance.customer_package_id,
      balanceId,
      balance.service_id,
      appointmentId,
      quantity,
      before,
      after,
      reason || 'Liberação de crédito por cancelamento do agendamento',
      userId || null,
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    );
    db.prepare("UPDATE appointments SET package_credit_status = 'RELEASED' WHERE id = ? AND package_credit_status = 'RESERVED'")
      .run(appointmentId);
    const released = hasRelease(db, balanceId, appointmentId);
    return { released, created: true };
  });
  const result = tx();
  refreshStatus(db, balance.customer_package_id);
  return result;
}

/* ----------------------------------------------------- Ajuste manual (admin) */

function manualAdjustment(db, { customerPackageId, serviceId, quantity, type, reason, userId }) {
  if (!['MANUAL_DEBIT', 'MANUAL_CREDIT'].includes(type)) {
    throw new AppError(400, 'Tipo de ajuste manual inválido.');
  }
  if (!reason || String(reason).trim().length < 5) {
    throw new AppError(400, 'Informe o motivo do ajuste manual (mínimo 5 caracteres).');
  }
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new AppError(400, 'Quantidade do ajuste deve ser um inteiro positivo.');
  }

  const cp = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(customerPackageId);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  const balance = getBalance(db, customerPackageId, serviceId);
  if (!balance) throw new AppError(400, 'O pacote não inclui este serviço.');

  const before = availableOf(balance);
  const tx = db.transaction(() => {
    if (type === 'MANUAL_DEBIT') {
      const res = db.prepare(
        `UPDATE customer_package_balances
         SET consumed_quantity = consumed_quantity + ?,
             updated_at = datetime('now', 'localtime')
         WHERE id = ? AND (total_quantity + adjusted_quantity - reserved_quantity - consumed_quantity) >= ?`
      ).run(qty, balance.id, qty);
      if (res.changes === 0) {
        throw new AppError(409, 'Saldo insuficiente para o débito manual.');
      }
    } else {
      db.prepare(
        `UPDATE customer_package_balances
         SET adjusted_quantity = adjusted_quantity + ?,
             updated_at = datetime('now', 'localtime')
         WHERE id = ?`
      ).run(qty, balance.id);
    }
    const afterBalance = db.prepare('SELECT * FROM customer_package_balances WHERE id = ?').get(balance.id);
    const after = availableOf(afterBalance);
    db.prepare(
      `INSERT INTO package_transactions
        (id, customer_package_id, balance_id, service_id, appointment_id, transaction_type,
         quantity, balance_before, balance_after, reason, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newTxId(type),
      customerPackageId,
      balance.id,
      serviceId,
      type,
      qty,
      before,
      after,
      String(reason).trim(),
      userId || null,
      new Date().toISOString().slice(0, 19).replace('T', ' ')
    );
  });
  tx();
  refreshStatus(db, customerPackageId);
  return getCustomerPackage(db, customerPackageId);
}

/* -------------------------------------------------------------- Cancelamento */

function cancelCustomerPackage(db, customerPackageId, reason, userId) {
  const cp = getCustomerPackage(db, customerPackageId);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  if (BLOCKED_USE_STATUSES.includes(cp.status)) {
    throw new AppError(400, 'Pacote já está cancelado ou suspenso.');
  }
  if (cp.totals.reserved > 0) {
    throw new AppError(
      400,
      'Não é possível cancelar o pacote enquanto houver agendamentos com saldo reservado. Cancele ou conclua os agendamentos primeiro.'
    );
  }

  const reasonText = reason && String(reason).trim().length >= 5
    ? String(reason).trim()
    : 'Cancelamento do pacote';

  const tx = db.transaction(() => {
    db.prepare("UPDATE customer_packages SET status = 'CANCELLED', notes = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(reasonText, customerPackageId);
    for (const b of cp.balances) {
      if (b.available <= 0) continue;
      db.prepare(
        `INSERT INTO package_transactions
          (id, customer_package_id, balance_id, service_id, appointment_id, transaction_type,
           quantity, balance_before, balance_after, reason, created_by_user_id, created_at)
         VALUES (?, ?, ?, ?, NULL, 'CANCEL_PACKAGE', ?, ?, 0, ?, ?, ?)`
      ).run(
        newTxId('CANCEL_PACKAGE'),
        customerPackageId,
        b.id,
        b.service_id,
        b.available,
        b.available,
        reasonText,
        userId || null,
        new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
    }
  });
  tx();
  return getCustomerPackage(db, customerPackageId);
}

/* ---------------------------------------------------- Auxiliares p/ agenda */

/*
 * Dado um agendamento (com services_ids) e um customer_package_id, valida se
 * TODOS os serviços selecionados são cobertos pelo mesmo pacote e devolve o
 * total de créditos necessários (quantidade por serviço, 1 por padrão).
 * Usada na criação/edição de agendamento.
 */
function validateCoverage(db, customerPackageId, serviceIds) {
  if (!customerPackageId) return null;
  const cp = getCustomerPackage(db, customerPackageId);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  if (!cp.can_reserve) {
    throw new AppError(400, 'Este pacote não pode ser utilizado no momento (inativo, expirado ou sem saldo).');
  }
  const ids = serviceIds.map(Number);
  const covered = new Set(cp.balances.map((b) => b.service_id));
  const missing = ids.filter((id) => !covered.has(id));
  if (missing.length) {
    throw new AppError(400, 'Este pacote não cobre todos os serviços selecionados.');
  }
  for (const b of cp.balances) {
    if (ids.includes(b.service_id) && b.available <= 0) {
      throw new AppError(409, `O saldo do pacote para "${b.service_name}" está esgotado.`);
    }
  }
  return {
    customer_package_id: cp.id,
    balances: cp.balances.filter((b) => ids.includes(b.service_id))
  };
}

/* Reserva créditos para todos os serviços de um agendamento recém-criado. */
function reserveForAppointmentUnsafe(db, { customerPackageId, serviceIds, appointmentId, reason, userId }) {
  const cp = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(customerPackageId);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  const ids = [...new Set(serviceIds.map(Number))];
  const results = [];
  let quantityTotal = 0;
  for (const serviceId of ids) {
    const r = reservePackageCredit(db, {
      customerPackageId,
      serviceId,
      quantity: 1,
      appointmentId,
      reason,
      userId
    });
    results.push(r);
    quantityTotal += 1;
  }
  const balanceId = results[0] && results[0].reservation ? results[0].reservation.balance_id : null;
  db.prepare(
    `UPDATE appointments SET
       payment_source = 'PACKAGE',
       customer_package_id = ?,
       package_balance_id = ?,
       package_credit_status = 'RESERVED',
       package_quantity = ?,
       total_price = 0
     WHERE id = ?`
  ).run(customerPackageId, balanceId, quantityTotal, appointmentId);
  return results;
}

/* Libera (no cancelamento/exclusão) os créditos reservados de um agendamento. */
function releaseForAppointmentUnsafe(db, { appointmentId, reason, userId }) {
  const dbCurrent = db;
  const appointment = dbCurrent.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appointment) return 0;
  if (appointment.package_credit_status !== 'RESERVED') return 0;

  const balances = dbCurrent.prepare(
    `SELECT DISTINCT balance_id FROM package_transactions
     WHERE appointment_id = ? AND transaction_type = 'RESERVE'`
  ).all(appointmentId);
  let released = 0;
  for (const row of balances) {
    const r = releasePackageCredit(dbCurrent, {
      balanceId: row.balance_id,
      appointmentId,
      reason,
      userId
    });
    if (r.created) released += 1;
  }
  return released;
}

/* Consome (na conclusão) os créditos reservados de um agendamento. */
function consumeForAppointmentUnsafe(db, { appointmentId, reason, userId }) {
  const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appointment) return 0;
  if (!['RESERVED', 'PACKAGE'].includes(appointment.package_credit_status)) return 0;

  const rows = db.prepare(
    `SELECT DISTINCT balance_id, service_id FROM package_transactions
     WHERE appointment_id = ? AND transaction_type = 'RESERVE'`
  ).all(appointmentId);
  let consumed = 0;
  for (const row of rows) {
    const r = consumePackageCredit(db, {
      customerPackageId: appointment.customer_package_id,
      serviceId: row.service_id,
      quantity: 1,
      appointmentId,
      reason,
      userId
    });
    if (r.created) consumed += 1;
  }
  return consumed;
}

function runAtomic(db, fn) {
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}

function reserveForAppointment(db, args) {
  return runAtomic(db, () => reserveForAppointmentUnsafe(db, args));
}

function releaseForAppointment(db, args) {
  return runAtomic(db, () => releaseForAppointmentUnsafe(db, args));
}

function consumeForAppointment(db, args) {
  return runAtomic(db, () => consumeForAppointmentUnsafe(db, args));
}

/* Pacifica/limpa vínculos de pacote ao reverter um agendamento (edição de serviço). */
function resetAppointmentPackage(db, { appointmentId, reason, userId }) {
  releaseForAppointment(db, { appointmentId, reason, userId });
  db.prepare(
    `UPDATE appointments SET
       payment_source = 'NORMAL',
       customer_package_id = NULL,
       package_balance_id = NULL,
       package_credit_status = 'NONE',
       package_quantity = 0
     WHERE id = ?`
  ).run(appointmentId);
}

function appointmentServiceIds(appointment) {
  let ids = [];
  try {
    const parsed = JSON.parse(appointment.services_json || '[]');
    if (Array.isArray(parsed)) ids = parsed.map((item) => Number(item.id)).filter(Boolean);
  } catch { ids = []; }
  if (!ids.length && appointment.service_id) ids = [Number(appointment.service_id)];
  return [...new Set(ids)];
}

function resolveAppointmentCustomer(db, appointment) {
  if (appointment.customer_id) {
    const customer = customerService.findCustomerById(db, appointment.customer_id);
    if (customer) return customer;
  }
  const result = customerService.ensureCustomerFromAppointment(db, appointment);
  db.prepare('UPDATE appointments SET customer_id = ?, customer_phone = ? WHERE id = ?')
    .run(result.customer.id, result.customer.phone, appointment.id);
  appointment.customer_id = result.customer.id;
  return result.customer;
}

function vehicleMatches(db, appointment, customerPackage) {
  if (!customerPackage.vehicle_id) return true;
  if (appointment.vehicle_id) return Number(appointment.vehicle_id) === Number(customerPackage.vehicle_id);
  if (!appointment.vehicle_plate) return false;
  const vehicle = customerService.findVehicleByPlate(db, appointment.customer_id, appointment.vehicle_plate);
  if (!vehicle) return false;
  db.prepare('UPDATE appointments SET vehicle_id = ? WHERE id = ?').run(vehicle.id, appointment.id);
  appointment.vehicle_id = vehicle.id;
  return Number(vehicle.id) === Number(customerPackage.vehicle_id);
}

function listEligiblePackagesForAppointment(db, appointmentId) {
  const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appointment) throw new AppError(404, 'Agendamento não encontrado.');
  const customer = resolveAppointmentCustomer(db, appointment);
  const serviceIds = appointmentServiceIds(appointment);
  return listCustomerPackages(db, { customer_id: customer.id })
    .map((summary) => getCustomerPackage(db, summary.id))
    .filter((cp) => cp && cp.can_reserve && cp.customer_id === customer.id)
    .filter((cp) => vehicleMatches(db, appointment, cp))
    .filter((cp) => serviceIds.every((id) => {
      const balance = cp.balances.find((item) => Number(item.service_id) === id);
      return balance && (balance.available >= 1 || Boolean(hasReserve(db, balance.id, appointment.id)));
    }))
    .sort((a, b) => {
      if (a.expires_at && b.expires_at) return a.expires_at.localeCompare(b.expires_at) || a.id - b.id;
      if (a.expires_at) return -1;
      if (b.expires_at) return 1;
      return a.id - b.id;
    })
    .map((cp) => ({
      ...cp,
      usage: cp.balances.filter((b) => serviceIds.includes(Number(b.service_id))).map((b) => {
        const reservedHere = Boolean(hasReserve(db, b.id, appointment.id));
        return {
          service_id: b.service_id,
          service_name: b.service_name,
          quantity: 1,
          before: b.available + (reservedHere ? 1 : 0),
          after: b.available - (reservedHere ? 0 : 1)
        };
      })
    }));
}

function assertPackageBelongsToAppointment(db, appointment, customerPackageId) {
  const customer = resolveAppointmentCustomer(db, appointment);
  const cp = getCustomerPackage(db, customerPackageId);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  if (Number(cp.customer_id) !== Number(customer.id)) {
    throw new AppError(422, 'Este pacote não pertence ao cliente deste agendamento.');
  }
  if (!vehicleMatches(db, appointment, cp)) {
    throw new AppError(422, 'Este pacote está vinculado a outro veículo.');
  }
  return cp;
}

function completeAppointmentWithPackage(db, { appointmentId, customerPackageId, userId }) {
  const operation = db.transaction(() => {
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appointment) throw new AppError(404, 'Agendamento não encontrado.');
    if (appointment.status === 'completed') return { appointment, alreadyCompleted: true, usage: [] };
    const eligible = listEligiblePackagesForAppointment(db, appointment.id);
    let selectedId = customerPackageId ? Number(customerPackageId) : null;
    if (!selectedId && eligible.length === 1) selectedId = eligible[0].id;
    if (!selectedId && eligible.length > 1) throw new AppError(409, 'Escolha qual pacote será utilizado.');
    if (!selectedId) throw new AppError(422, 'Este cliente não possui créditos suficientes para todos os serviços deste atendimento.');
    assertPackageBelongsToAppointment(db, appointment, selectedId);
    const selected = eligible.find((cp) => Number(cp.id) === selectedId);
    if (!selected) throw new AppError(422, 'O pacote selecionado não possui créditos válidos para todos os serviços deste atendimento.');

    const serviceIds = appointmentServiceIds(appointment);
    reserveForAppointment(db, {
      customerPackageId: selectedId,
      serviceIds,
      appointmentId: appointment.id,
      reason: `Reserva na conclusão do agendamento ${appointment.appointment_code}`,
      userId
    });
    consumeForAppointment(db, {
      appointmentId: appointment.id,
      reason: 'Consumo na conclusão do atendimento',
      userId
    });
    db.prepare(`UPDATE appointments SET status='completed', completion_payment_method='package',
      payment_source='PACKAGE', payment_method=NULL, completed_by_user_id=?,
      completed_at=datetime('now', 'localtime'), updated_at=datetime('now', 'localtime') WHERE id=? AND status!='completed'`)
      .run(userId || null, appointment.id);
    return {
      appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id),
      package: getCustomerPackage(db, selectedId),
      usage: selected.usage,
      alreadyCompleted: false
    };
  });
  return operation.immediate();
}

module.exports = {
  PACKAGE_STATUSES,
  TX_TYPES,
  availableOf,
  getServicePackage,
  listServicePackages,
  createServicePackage,
  updateServicePackage,
  setServicePackageActive,
  sellPackage,
  getCustomerPackage,
  listCustomerPackages,
  getPackageStatement,
  reservePackageCredit,
  consumePackageCredit,
  releasePackageCredit,
  manualAdjustment,
  cancelCustomerPackage,
  applyExpirations,
  validateCoverage,
  reserveForAppointment,
  releaseForAppointment,
  consumeForAppointment,
  resetAppointmentPackage,
  listEligiblePackagesForAppointment,
  assertPackageBelongsToAppointment,
  completeAppointmentWithPackage,
  centsToReal
};
