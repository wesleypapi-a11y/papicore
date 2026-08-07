/*
 * Diagnosticos temporarios e estritamente read-only para suporte em producao.
 * Todas as rotas deste controller sao registradas depois de requireDeveloper.
 */

const Database = require('better-sqlite3');

const { getTenantById } = require('../database/coreDatabase');
const { tenantFilePath } = require('../database/tenantDatabase');
const packageService = require('../services/packageService');
const { AppError, normalizeBrazilianPhone, todayStr } = require('../utils/helpers');

const FIXED_PACKAGE_STATUSES = new Set(['CANCELLED', 'SUSPENDED']);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new AppError(400, `${label} invalido.`);
  return parsed;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  const visible = digits.slice(-4);
  return `${'*'.repeat(Math.max(0, digits.length - visible.length))}${visible}`;
}

function openReadonlyTenant(req) {
  const tenantId = positiveInteger(req.query.tenantId, 'tenantId');
  const tenant = getTenantById(tenantId);
  if (!tenant) throw new AppError(404, 'Empresa nao encontrada.');
  if (!/^tenant_\d{4}_[a-z0-9_-]+\.db$/.test(String(tenant.database_name || ''))) {
    throw new AppError(500, 'Banco da empresa possui nome invalido.');
  }
  const db = new Database(tenantFilePath(tenant.database_name), {
    readonly: true,
    fileMustExist: true
  });
  db.pragma('query_only = ON');
  return { db, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } };
}

function appointmentItems(appointment) {
  let items = [];
  try {
    const parsed = JSON.parse(appointment.services_json || '[]');
    if (Array.isArray(parsed)) items = parsed;
  } catch { items = []; }
  if (!items.length && appointment.service_id) {
    items = [{ id: appointment.service_id, name: appointment.service_name }];
  }
  return [...new Map(items.map((item) => [Number(item.id), {
    service_id: Number(item.id),
    snapshot_name: item.name || item.service_name || null,
    quantity: 1
  }]).filter(([id]) => Number.isInteger(id) && id > 0)).values()];
}

function effectiveStatus(cp, balances) {
  if (FIXED_PACKAGE_STATUSES.has(cp.status)) return cp.status;
  const expired = Boolean(cp.expires_at) && cp.expires_at < todayStr();
  const reserved = balances.some((balance) => balance.reserved > 0);
  if (expired && !reserved) return 'EXPIRED';
  const exhausted = balances.length > 0 && balances.every((balance) => balance.available <= 0);
  return exhausted ? 'EXHAUSTED' : 'ACTIVE';
}

function loadPackage(db, row) {
  const rawBalances = db.prepare(
    `SELECT id, service_id, service_name_snapshot, total_quantity,
            adjusted_quantity, reserved_quantity, consumed_quantity
       FROM customer_package_balances
      WHERE customer_package_id = ?
      ORDER BY id ASC`
  ).all(row.id);
  const balances = rawBalances.map((balance) => ({
    id: balance.id,
    service_id: Number(balance.service_id),
    service_name: balance.service_name_snapshot,
    total: Number(balance.total_quantity),
    adjusted: Number(balance.adjusted_quantity),
    reserved: Number(balance.reserved_quantity),
    consumed: Number(balance.consumed_quantity),
    available: Number(balance.total_quantity) + Number(balance.adjusted_quantity)
      - Number(balance.reserved_quantity) - Number(balance.consumed_quantity)
  }));
  return { ...row, status: effectiveStatus(row, balances), balances };
}

function resolveCustomerReadonly(db, appointment) {
  if (appointment.customer_id) {
    const byId = db.prepare('SELECT id, name, phone, phone_normalized FROM customers WHERE id = ?')
      .get(appointment.customer_id);
    if (byId) return byId;
  }
  const normalized = normalizeBrazilianPhone(appointment.customer_phone);
  if (!normalized) return null;
  return db.prepare(
    'SELECT id, name, phone, phone_normalized FROM customers WHERE phone_normalized = ? LIMIT 1'
  ).get(normalized) || null;
}

function prepareAppointmentForEvaluation(db, appointment, customer) {
  const copy = { ...appointment, customer_id: customer ? customer.id : appointment.customer_id };
  if (!copy.vehicle_id && copy.vehicle_plate && copy.customer_id) {
    const plate = String(copy.vehicle_plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const vehicle = db.prepare(
      `SELECT id FROM vehicles
        WHERE customer_id = ? AND REPLACE(UPPER(plate), ' ', '') = ?
        ORDER BY id ASC LIMIT 1`
    ).get(copy.customer_id, plate);
    // -1 preserva o resultado "nao encontrado" e impede a funcao compartilhada
    // de tentar persistir vehicle_id durante este diagnostico read-only.
    copy.vehicle_id = vehicle ? vehicle.id : -1;
  }
  return copy;
}

function overallReason(evaluations, serviceIds) {
  if (!evaluations.length) return 'NO_CUSTOMER_PACKAGES';
  const oneIncludesAll = evaluations.some(({ eligibility }) =>
    !eligibility.reasons.includes('SERVICE_NOT_INCLUDED'));
  const collectivelyCovered = serviceIds.every((serviceId) => evaluations.some(({ internalPackage }) =>
    internalPackage.balances.some((balance) => balance.service_id === serviceId)));
  if (!oneIncludesAll && collectivelyCovered && serviceIds.length > 1) return 'NO_SINGLE_PACKAGE';
  const preferred = evaluations.find(({ eligibility }) =>
    !eligibility.reasons.includes('SERVICE_NOT_INCLUDED')) || evaluations[0];
  return preferred.eligibility.reasons[0] || 'NO_ELIGIBLE_PACKAGE';
}

function packageEligibilityDiagnostic(req, res) {
  const appointmentId = positiveInteger(req.params.appointmentId, 'appointmentId');
  const { db, tenant } = openReadonlyTenant(req);
  try {
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appointment) throw new AppError(404, 'Agendamento nao encontrado nesta empresa.');

    const resolvedCustomer = resolveCustomerReadonly(db, appointment);
    const evaluationAppointment = prepareAppointmentForEvaluation(db, appointment, resolvedCustomer);
    const items = appointmentItems(appointment);
    const serviceRows = new Map();
    if (items.length) {
      const placeholders = items.map(() => '?').join(',');
      for (const service of db.prepare(
        `SELECT id, name, slug FROM services WHERE id IN (${placeholders})`
      ).all(...items.map((item) => item.service_id))) serviceRows.set(Number(service.id), service);
    }
    const services = items.map((item) => {
      const service = serviceRows.get(item.service_id);
      return {
        service_id: item.service_id,
        name: service ? service.name : item.snapshot_name,
        slug: service ? service.slug : null,
        quantity: item.quantity
      };
    });

    const packageRows = resolvedCustomer ? db.prepare(
      `SELECT id, package_name_snapshot, customer_id, vehicle_id, status, starts_at, expires_at
         FROM customer_packages WHERE customer_id = ? ORDER BY expires_at ASC, id ASC`
    ).all(resolvedCustomer.id) : [];
    const evaluated = packageRows.map((row) => {
      const internalPackage = loadPackage(db, row);
      const eligibility = packageService.evaluatePackageEligibility(db, {
        appointment: evaluationAppointment,
        customerPackage: internalPackage
      });
      return { internalPackage, eligibility };
    });
    const accepted = evaluated.filter(({ eligibility }) => eligibility.eligible);
    const selected = accepted.length === 1 ? accepted[0].internalPackage.id : null;

    return res.json({
      tenant,
      diagnosticReadOnly: true,
      backendDate: todayStr(),
      appointment: {
        id: appointment.id,
        code: appointment.appointment_code,
        customer_id: appointment.customer_id,
        customer_name: appointment.customer_name,
        customer_phone: maskPhone(appointment.customer_phone),
        normalized_phone: maskPhone(normalizeBrazilianPhone(appointment.customer_phone)),
        vehicle_id: appointment.vehicle_id,
        status: appointment.status
      },
      resolvedCustomer: resolvedCustomer ? {
        id: resolvedCustomer.id,
        name: resolvedCustomer.name,
        phone: maskPhone(resolvedCustomer.phone),
        phone_normalized: maskPhone(resolvedCustomer.phone_normalized)
      } : null,
      services,
      customerPackages: evaluated.map(({ internalPackage, eligibility }) => ({
        id: internalPackage.id,
        name: internalPackage.package_name_snapshot,
        customer_id: internalPackage.customer_id,
        vehicle_id: internalPackage.vehicle_id,
        stored_status: packageRows.find((row) => row.id === internalPackage.id).status,
        status: internalPackage.status,
        starts_at: internalPackage.starts_at,
        expires_at: internalPackage.expires_at,
        balances: internalPackage.balances.map((balance) => ({
          balance_id: balance.id,
          service_id: balance.service_id,
          service_name: balance.service_name,
          total_quantity: balance.total,
          adjusted_quantity: balance.adjusted,
          reserved_quantity: balance.reserved,
          consumed_quantity: balance.consumed,
          available_quantity: balance.available
        })),
        eligibility,
        decision: eligibility.eligible ? 'ACCEPTED' : 'REJECTED'
      })),
      packagePaymentAvailable: accepted.length > 0,
      autoSelectedPackageId: selected,
      reason: accepted.length ? null : overallReason(evaluated, services.map((service) => service.service_id))
    });
  } finally {
    db.close();
  }
}

function searchAppointmentsDiagnostic(req, res) {
  const code = String(req.query.code || '').trim();
  const name = String(req.query.name || '').trim();
  const phoneLast4 = String(req.query.phoneLast4 || '').replace(/\D/g, '');
  if (!code && !name && !phoneLast4) {
    throw new AppError(400, 'Informe code, name ou phoneLast4.');
  }
  if (phoneLast4 && phoneLast4.length !== 4) {
    throw new AppError(400, 'phoneLast4 deve conter exatamente 4 digitos.');
  }
  const { db, tenant } = openReadonlyTenant(req);
  try {
    const where = [];
    const params = [];
    if (code) { where.push('appointment_code LIKE ?'); params.push(`%${code}%`); }
    if (name) { where.push('customer_name LIKE ?'); params.push(`%${name}%`); }
    if (phoneLast4) { where.push("REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(customer_phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?"); params.push(`%${phoneLast4}`); }
    const appointments = db.prepare(
      `SELECT id, appointment_code, customer_name, appointment_date, status
         FROM appointments WHERE ${where.join(' AND ')}
        ORDER BY appointment_date DESC, id DESC LIMIT 50`
    ).all(...params).map((row) => ({
      appointmentId: row.id,
      code: row.appointment_code,
      customer_name: row.customer_name,
      date: row.appointment_date,
      status: row.status
    }));
    return res.json({ tenant, diagnosticReadOnly: true, appointments });
  } finally {
    db.close();
  }
}

module.exports = { packageEligibilityDiagnostic, searchAppointmentsDiagnostic };
