/*
 * publicRoutes.js
 *
 * Rotas públicas de agendamento (área pública).
 * O banco da empresa é determinado pelo domínio da requisição
 * (domainTenantMiddleware) — nunca por parâmetros do frontend.
 */

const express = require('express');
const agendamentoController = require('../controllers/agendamentoController');
const { domainTenantMiddleware } = require('../middlewares/domainTenantMiddleware');

const router = express.Router();

router.use(domainTenantMiddleware);

router.get('/settings', agendamentoController.getPublicSettings);
router.get('/modalities', agendamentoController.listModalities);
router.get('/units', agendamentoController.listActiveUnits);
router.get('/catalog', agendamentoController.getCatalog);
router.get('/availability', agendamentoController.checkAvailability);
router.post('/appointments', agendamentoController.createAppointmentPublic);
router.get('/appointments/:code', agendamentoController.getByCode);

module.exports = router;
