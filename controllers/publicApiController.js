/*
 * publicApiController.js
 *
 * Handlers da API pública /api/v1 (autenticada por chave de API).
 *
 * Reutiliza a lógica de negócio EXISTENTE — nunca duplica. Os controllers do
 * painel (adminController, agendamentoController, packageController) fazem o
 * trabalho pesado; este módulo apenas:
 *   - encaminha a requisição dentro do contexto de tenant já aberto pelo
 *     apiKeyMiddleware (getDb() resolve o banco correto);
 *   - dispara eventos de webhook após operações de escrita;
 *   - expõe apenas campos/scopes apropriados à API pública.
 */

'use strict';

const adminController = require('./adminController');
const agendamentoController = require('./agendamentoController');
const packageController = require('./packageController');
const webhookService = require('../services/webhookService');

/* Intercepta res.json para disparar o webhook com o corpo da resposta.
   Encadeia com o capture do middleware de idempotência (a ordem de chamada
   garante que o webhook dispara antes do registro idempotente). */
function afterJson(req, res, fn) {
  const original = res.json.bind(res);
  res.json = (body) => {
    try {
      fn(body);
    } catch (err) {
      console.error('[api] Erro ao disparar webhook:', err.message);
    }
    return original(body);
  };
  return res;
}

/* Os handlers do painel usam req.user para quem realizou a operação.
   Na API o chamador é a própria chave — registra como Sistema. */
function asApiCaller(req) {
  req.user = { id: null, name: 'API' };
  return req;
}

/* --------------------------------------------------------- Leitura (GET) */

function getSettings(req, res) {
  return agendamentoController.getPublicSettings(req, res);
}

function listModalities(req, res) {
  return agendamentoController.listModalities(req, res);
}

function listUnits(req, res) {
  return agendamentoController.listActiveUnits(req, res);
}

function getCatalog(req, res) {
  return agendamentoController.getCatalog(req, res);
}

function checkAvailability(req, res) {
  return agendamentoController.checkAvailability(req, res);
}

function listAppointments(req, res) {
  return adminController.listAppointments(req, res);
}

function getAppointment(req, res) {
  return adminController.getAppointment(req, res);
}

function getAppointmentByCode(req, res) {
  return agendamentoController.getByCode(req, res);
}

function listCustomers(req, res) {
  return packageController.listCustomers(req, res);
}

function getCustomer(req, res) {
  return packageController.getCustomer(req, res);
}

function listPackages(req, res) {
  return packageController.listPackages(req, res);
}

function listCustomerPackages(req, res) {
  return packageController.listCustomerPackages(req, res);
}

function getCustomerPackage(req, res) {
  return packageController.getCustomerPackage(req, res);
}

/* -------------------------------------------------------- Escrita (POST) */

function createAppointment(req, res) {
  asApiCaller(req);
  const wrapped = afterJson(req, res, (appointment) => {
    if (appointment && appointment.id) {
      webhookService.fire(req, webhookService.WEBHOOK_EVENTS.APPOINTMENT_CREATED,
        webhookService.buildAppointmentPayload(appointment));
    }
  });
  return adminController.createAppointment(req, wrapped);
}

function completeAppointment(req, res) {
  asApiCaller(req);
  const body = { ...req.body, status: 'completed' };
  req.body = body;
  const wrapped = afterJson(req, res, (appointment) => {
    if (appointment && appointment.id && appointment.status === 'completed') {
      webhookService.fire(req, webhookService.WEBHOOK_EVENTS.APPOINTMENT_COMPLETED,
        webhookService.buildAppointmentPayload(appointment));
    }
  });
  return adminController.updateStatus(req, wrapped);
}

function cancelAppointment(req, res) {
  asApiCaller(req);
  const body = { ...req.body, status: 'cancelled' };
  req.body = body;
  const wrapped = afterJson(req, res, (appointment) => {
    if (appointment && appointment.id && appointment.status === 'cancelled') {
      webhookService.fire(req, webhookService.WEBHOOK_EVENTS.APPOINTMENT_CANCELLED,
        webhookService.buildAppointmentPayload(appointment));
    }
  });
  return adminController.updateStatus(req, wrapped);
}

module.exports = {
  getSettings,
  listModalities,
  listUnits,
  getCatalog,
  checkAvailability,
  listAppointments,
  getAppointment,
  getAppointmentByCode,
  listCustomers,
  getCustomer,
  listPackages,
  listCustomerPackages,
  getCustomerPackage,
  createAppointment,
  completeAppointment,
  cancelAppointment
};
