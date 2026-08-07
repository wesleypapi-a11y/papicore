/*
 * adminRoutes.js
 *
 * Rotas da área administrativa da empresa (painel).
 * Protegidas por requireAuth + tenantMiddleware: o banco aberto é sempre o da
 * empresa do usuário autenticado.
 */

const express = require('express');
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');
const unitController = require('../controllers/unitController');
const blockedScheduleController = require('../controllers/blockedScheduleController');
const settingsController = require('../controllers/settingsController');
const serviceController = require('../controllers/serviceController');
const modalityController = require('../controllers/modalityController');
const financialController = require('../controllers/financialController');
const brandingController = require('../controllers/brandingController');
const pixController = require('../controllers/pixController');
const adminContractController = require('../controllers/adminContractController');
const legalDocumentController = require('../controllers/legalDocumentController');
const packageController = require('../controllers/packageController');
const whatsappController = require('../controllers/whatsappController');

const router = express.Router();

const { enforceUnitLimit } = require('../middlewares/planLimits');
const { whatsappRateLimit } = require('../middlewares/whatsappRateLimit');

router.get('/me', authController.me);

router.get('/dashboard', adminController.dashboard);
router.get('/agenda', adminController.agenda);

router.get('/modalities', modalityController.list);
router.put('/modalities/:id', modalityController.update);

router.get('/plan', unitController.getPlanInfo);
router.get('/units', unitController.listAll);
router.get('/units/:id', unitController.getOne);
router.post('/units', enforceUnitLimit, unitController.create);
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
router.post('/appointments/:id/complete', adminController.completeAppointment);
router.patch('/appointments/:id/accept', adminController.acceptAppointment);
router.patch('/appointments/:id/reject', adminController.rejectAppointment);
router.delete('/appointments/:id', adminController.deleteAppointment);

/* Pacotes de serviços (Fase 1). */
router.get('/packages', packageController.listPackages);
router.post('/packages', packageController.createPackage);
router.put('/packages/:id', packageController.updatePackage);
router.patch('/packages/:id/active', packageController.setPackageActive);

router.get('/customer-packages', packageController.listCustomerPackages);
router.get('/customer-packages/:id', packageController.getCustomerPackage);
router.get('/customer-packages/:id/statement', packageController.getPackageStatement);
router.post('/customer-packages', packageController.sellPackage);
router.post('/customer-packages/:id/adjust', packageController.adjustCustomerPackage);
router.post('/customer-packages/:id/cancel', packageController.cancelCustomerPackage);

router.get('/customers', packageController.listCustomers);
router.get('/customers/:id', packageController.getCustomer);

/* Reserva/liberação de crédito do pacote em um agendamento. */
router.post('/appointments/:id/package/reserve', packageController.reserveForAppointment);
router.post('/appointments/:id/package/release', packageController.releaseForAppointment);
router.get('/appointments/:id/packages/available', packageController.availableForAppointment);

router.get('/blocked-schedules', blockedScheduleController.list);
router.post('/blocked-schedules', blockedScheduleController.create);
router.delete('/blocked-schedules/:id', blockedScheduleController.remove);

router.get('/settings', settingsController.get);
router.put('/settings', settingsController.update);
router.post('/settings/pix-qr', pixController.uploadPixQr);
router.delete('/settings/pix-qr', pixController.removePixQr);

/* Configurações > Documentos e privacidade: somente leitura nesta primeira
   implementação (ver services/legalDocumentService.js). */
router.get('/legal-documents', legalDocumentController.list);
router.get('/legal-documents/:id', legalDocumentController.getOne);

/* Aba Aparência (Configurações > Aparência): logo, favicon, ícone do Admin e
   tema de cores do próprio tenant. O tenant nunca vem da URL/body — sempre de
   req.tenant, resolvido pelo tenantMiddleware a partir do usuário autenticado. */
router.get('/branding', brandingController.getAdminBranding);
router.put('/branding/theme', brandingController.updateAdminTheme);
router.get('/branding/logo', brandingController.serveAdminLogo);
router.get('/branding/favicon', brandingController.serveAdminFavicon);
router.get('/branding/admin-icon', brandingController.serveAdminAdminIcon);
router.post('/branding/logo', brandingController.uploadAdminLogo);
router.post('/branding/favicon', brandingController.uploadAdminFavicon);
router.post('/branding/admin-icon', brandingController.uploadAdminAdminIcon);
router.delete('/branding/logo', brandingController.removeAdminLogo);
router.delete('/branding/favicon', brandingController.removeAdminFavicon);
router.delete('/branding/admin-icon', brandingController.removeAdminAdminIcon);

/* Contrato da própria empresa com a PapiCore (somente leitura/download —
   quem cria e finaliza contratos é o painel do desenvolvedor). */
router.get('/contracts', adminContractController.listMyContracts);
router.get('/contracts/:id/download', adminContractController.downloadMyContract);

router.get('/financials/summary', financialController.summary);
router.get('/financials/entries', financialController.list);
router.post('/financials/entries', financialController.create);
router.put('/financials/entries/:id', financialController.update);
router.delete('/financials/entries/:id', financialController.remove);

/* WhatsApp — mensagens automáticas e histórico. */
router.get('/whatsapp/status', whatsappController.getStatus);
router.get('/whatsapp/templates', whatsappController.listTemplates);
router.put('/whatsapp/templates/:eventKey', whatsappController.updateTemplate);
router.post('/whatsapp/templates/:eventKey/restore', whatsappController.restoreTemplate);
router.get('/whatsapp/outbox', whatsappController.listOutbox);
router.post('/whatsapp/outbox/:id/resend', whatsappController.resendOutbox);
router.get('/whatsapp/history', whatsappController.getHistory);

/* WhatsApp — conexão (Evolution API). */
router.get('/whatsapp/connection', whatsappRateLimit('refresh', { max: 30 }), whatsappController.getConnection);
router.post('/whatsapp/connection/connect', whatsappRateLimit('connect', { max: 5 }), whatsappController.connectConnection);
router.post('/whatsapp/connection/reconnect', whatsappRateLimit('connect', { max: 5 }), whatsappController.reconnectConnection);
router.post('/whatsapp/connection/disconnect', whatsappController.disconnectConnection);

module.exports = router;
