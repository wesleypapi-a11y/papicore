/*
 * publicApiRoutes.js
 *
 * API pública /api/v1 — autenticada por chave de API (apiKeyMiddleware).
 *
 * Montada em server.js ANTES de publicRoutes para não sofrer o
 * domainTenantMiddleware (o tenant vem da chave, não do domínio da
 * requisição). GET /openapi.json é público (documentação).
 */

'use strict';

const express = require('express');
const { requireApiKey, requireScope } = require('../middlewares/apiKeyMiddleware');
const { idempotency } = require('../middlewares/idempotencyMiddleware');
const publicApiController = require('../controllers/publicApiController');
const { spec } = require('../docs/openapi');

const router = express.Router();

/* Documentação: pública (sem chave) para integradores lerem o contrato. */
router.get('/openapi.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(spec);
});

router.use(requireApiKey);

/* Configurações */
router.get('/settings', requireScope('settings:read'), publicApiController.getSettings);

/* Catálogo */
router.get('/modalities', requireScope('catalog:read'), publicApiController.listModalities);
router.get('/units', requireScope('catalog:read'), publicApiController.listUnits);
router.get('/catalog', requireScope('catalog:read'), publicApiController.getCatalog);

/* Disponibilidade */
router.get('/availability', requireScope('availability:read'), publicApiController.checkAvailability);

/* Agendamentos — leitura */
router.get('/appointments', requireScope('appointments:read'), publicApiController.listAppointments);
router.get('/appointments/code/:code', requireScope('appointments:read'), publicApiController.getAppointmentByCode);
router.get('/appointments/:id', requireScope('appointments:read'), publicApiController.getAppointment);

/* Agendamentos — escrita (idempotente via Idempotency-Key) */
router.post('/appointments', requireScope('appointments:write'), idempotency(), publicApiController.createAppointment);
router.post('/appointments/:id/complete', requireScope('appointments:write'), idempotency(), publicApiController.completeAppointment);
router.post('/appointments/:id/cancel', requireScope('appointments:write'), idempotency(), publicApiController.cancelAppointment);

/* Clientes */
router.get('/customers', requireScope('customers:read'), publicApiController.listCustomers);
router.get('/customers/:id', requireScope('customers:read'), publicApiController.getCustomer);

/* Pacotes */
router.get('/packages', requireScope('packages:read'), publicApiController.listPackages);
router.get('/customer-packages', requireScope('packages:read'), publicApiController.listCustomerPackages);
router.get('/customer-packages/:id', requireScope('packages:read'), publicApiController.getCustomerPackage);

module.exports = router;
