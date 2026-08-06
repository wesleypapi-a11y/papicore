/*
 * packageController.js
 *
 * API da área administrativa para Pacotes de Serviços (Fase 1).
 *
 * Regras de acesso:
 *   - owner e admin: gestão completa (modelos, venda, ajustes manuais,
 *     cancelamento);
 *   - employee: visualiza e usa pacotes em agendamentos (reserva/liberação
 *     via endpoints de agendamento), sem gestão.
 *
 * O banco é sempre o do contexto (getDb). Nenhum tenant_id vem do frontend.
 */

const { getDb } = require('../database/tenantDatabase');
const packageService = require('../services/packageService');
const customerService = require('../services/customerService');
const { AppError, parseCurrencyToCents } = require('../utils/helpers');

const MANAGER_ROLES = ['owner', 'admin'];

function assertManager(req) {
  if (!MANAGER_ROLES.includes(req.user.role)) {
    throw new AppError(403, 'Acesso restrito a administradores da empresa.');
  }
}

/* -------------------------------------------------------------- Modelos */

function listPackages(req, res) {
  const db = getDb();
  const includeInactive = req.query.includeInactive === 'true' || req.query.includeInactive === '1';
  return res.json(packageService.listServicePackages(db, { includeInactive }));
}

function createPackage(req, res) {
  assertManager(req);
  const db = getDb();
  const pkg = packageService.createServicePackage(db, req.body, req.user.id);
  return res.status(201).json(pkg);
}

function updatePackage(req, res) {
  assertManager(req);
  const db = getDb();
  const pkg = packageService.updateServicePackage(db, req.params.id, req.body, req.user.id);
  return res.json(pkg);
}

function setPackageActive(req, res) {
  assertManager(req);
  const db = getDb();
  const pkg = packageService.setServicePackageActive(db, req.params.id, Boolean(req.body.active));
  return res.json(pkg);
}

/* ------------------------------------------------------ Pacotes vendidos */

function listCustomerPackages(req, res) {
  const db = getDb();
  return res.json(packageService.listCustomerPackages(db, {
    customer_id: req.query.customer_id,
    status: req.query.status,
    search: req.query.search
  }));
}

function getCustomerPackage(req, res) {
  const db = getDb();
  const cp = packageService.getCustomerPackage(db, req.params.id);
  if (!cp) throw new AppError(404, 'Pacote do cliente não encontrado.');
  return res.json(cp);
}

function getPackageStatement(req, res) {
  const db = getDb();
  return res.json(packageService.getPackageStatement(db, req.params.id));
}

/* Venda de pacote (owner/admin). */
function sellPackage(req, res) {
  assertManager(req);
  const db = getDb();

  const payload = { ...req.body };
  if (payload.discount !== undefined && payload.discount !== null && payload.discount !== '') {
    const discountCents = parseCurrencyToCents(payload.discount);
    if (discountCents === null) throw new AppError(400, 'Valor de desconto inválido.');
    payload.discount_cents = discountCents;
  } else {
    payload.discount_cents = 0;
  }

  const cp = packageService.sellPackage(db, payload, req.user.id);
  return res.status(201).json(cp);
}

/* Débito/crédito manual (owner/admin) — motivo obrigatório. */
function adjustCustomerPackage(req, res) {
  assertManager(req);
  const db = getDb();
  const cp = packageService.manualAdjustment(db, {
    customerPackageId: req.params.id,
    serviceId: req.body.service_id,
    quantity: req.body.quantity,
    type: req.body.type,
    reason: req.body.reason,
    userId: req.user.id
  });
  return res.json(cp);
}

function cancelCustomerPackage(req, res) {
  assertManager(req);
  const db = getDb();
  const cp = packageService.cancelCustomerPackage(db, req.params.id, req.body.reason, req.user.id);
  return res.json(cp);
}

/* -------------------------------------------------------------- Clientes */

function listCustomers(req, res) {
  const db = getDb();
  return res.json(customerService.searchCustomers(db, req.query.search));
}

function getCustomer(req, res) {
  const db = getDb();
  const customer = customerService.findCustomerById(db, req.params.id);
  if (!customer) throw new AppError(404, 'Cliente não encontrado.');
  return res.json({
    ...customer,
    vehicles: customerService.listCustomerVehicles(db, customer.id),
    packages: packageService.listCustomerPackages(db, { customer_id: customer.id })
  });
}

/* ------------------------------------------------- Reserva em agendamento */

/*
 * Reserva crédito do pacote para um agendamento existente. O usuário de cada
 * serviço do agendamento (services_json) precisa estar coberto pelo pacote.
 * Permitido a todos os usuários autenticados (o employee usa na agenda).
 */
function reserveForAppointment(req, res) {
  const db = getDb();
  const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appointment) throw new AppError(404, 'Agendamento não encontrado.');

  const customerPackageId = req.body.customer_package_id || appointment.customer_package_id;
  if (!customerPackageId) throw new AppError(400, 'Informe o pacote a ser utilizado.');

  const serviceIds = [];
  if (appointment.services_json) {
    const parsed = JSON.parse(appointment.services_json);
    if (Array.isArray(parsed)) serviceIds.push(...parsed.map((s) => s.id));
  }
  if (!serviceIds.length && appointment.service_id) serviceIds.push(appointment.service_id);

  packageService.validateCoverage(db, customerPackageId, serviceIds);

  const results = packageService.reserveForAppointment(db, {
    customerPackageId,
    serviceIds,
    appointmentId: appointment.id,
    reason: `Reserva no agendamento ${appointment.appointment_code}`,
    userId: req.user.id
  });
  const updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment.id);
  return res.json({ appointment: updated, reservations: results });
}

function releaseForAppointment(req, res) {
  const db = getDb();
  const released = packageService.releaseForAppointment(db, {
    appointmentId: req.params.id,
    reason: 'Liberação manual de crédito do agendamento',
    userId: req.user.id
  });
  const updated = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  return res.json({ appointment: updated, released });
}

module.exports = {
  listPackages,
  createPackage,
  updatePackage,
  setPackageActive,
  listCustomerPackages,
  getCustomerPackage,
  getPackageStatement,
  sellPackage,
  adjustCustomerPackage,
  cancelCustomerPackage,
  listCustomers,
  getCustomer,
  reserveForAppointment,
  releaseForAppointment
};
