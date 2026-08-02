const express = require('express');
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');
const unitController = require('../controllers/unitController');
const blockedScheduleController = require('../controllers/blockedScheduleController');
const settingsController = require('../controllers/settingsController');
const serviceController = require('../controllers/serviceController');
const modalityController = require('../controllers/modalityController');

const router = express.Router();

router.get('/me', authController.me);

router.get('/dashboard', adminController.dashboard);
router.get('/agenda', adminController.agenda);

router.get('/modalities', modalityController.list);
router.put('/modalities/:id', modalityController.update);

router.get('/units', unitController.listAll);
router.get('/units/:id', unitController.getOne);
router.post('/units', unitController.create);
router.put('/units/:id', unitController.update);
router.delete('/units/:id', unitController.remove);

router.get('/services', serviceController.list);
router.get('/services/:id', serviceController.getOne);
router.post('/services', serviceController.create);
router.put('/services/:id', serviceController.update);
router.delete('/services/:id', serviceController.remove);

router.get('/service-categories', serviceController.listCategories);
router.post('/service-categories', serviceController.createCategory);
router.put('/service-categories/:id', serviceController.updateCategory);

router.get('/appointments', adminController.listAppointments);
router.get('/appointments/:id', adminController.getAppointment);
router.post('/appointments', adminController.createAppointment);
router.put('/appointments/:id', adminController.updateAppointment);
router.patch('/appointments/:id/status', adminController.updateStatus);
router.patch('/appointments/:id/accept', adminController.acceptAppointment);
router.patch('/appointments/:id/reject', adminController.rejectAppointment);
router.delete('/appointments/:id', adminController.deleteAppointment);

router.get('/blocked-schedules', blockedScheduleController.list);
router.post('/blocked-schedules', blockedScheduleController.create);
router.delete('/blocked-schedules/:id', blockedScheduleController.remove);

router.get('/settings', settingsController.get);
router.put('/settings', settingsController.update);

module.exports = router;
