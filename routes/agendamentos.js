const express = require('express');
const agendamentoController = require('../controllers/agendamentoController');

const router = express.Router();

router.get('/settings', agendamentoController.getPublicSettings);
router.get('/modalities', agendamentoController.listModalities);
router.get('/units', agendamentoController.listActiveUnits);
router.get('/catalog', agendamentoController.getCatalog);
router.get('/availability', agendamentoController.checkAvailability);
router.post('/appointments', agendamentoController.createAppointmentPublic);
router.get('/appointments/:code', agendamentoController.getByCode);

module.exports = router;
