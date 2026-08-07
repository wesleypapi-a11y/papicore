/*
 * publicRoutes.js
 *
 * Rotas públicas de agendamento (área pública).
 * O banco da empresa é determinado pelo domínio da requisição
 * (domainTenantMiddleware) — nunca por parâmetros do frontend.
 */

const express = require('express');
const agendamentoController = require('../controllers/agendamentoController');
const brandingController = require('../controllers/brandingController');
const pixController = require('../controllers/pixController');
const { domainTenantMiddleware } = require('../middlewares/domainTenantMiddleware');

const router = express.Router();

router.use(domainTenantMiddleware);

/* Identidade visual pública (logo/favicon/ícone do Admin por domínio) */
router.get('/branding', brandingController.publicBranding);
router.get('/branding/logo', brandingController.publicLogo);
router.get('/branding/favicon', brandingController.publicFavicon);
router.get('/branding/admin-icon', brandingController.publicAdminIcon);
router.get('/branding/manifest', brandingController.publicManifest);
router.get('/branding/admin-manifest', brandingController.adminManifest);

/* Pagamento via Pix: imagem do QR Code final configurada no admin */
router.get('/payment/pix-qr', pixController.publicPixQr);

/* Documentos legais (Termos de Uso / Aviso de Privacidade) do tenant atual —
   usados nos modais do agendamento e nas páginas públicas permanentes
   /termos-de-uso e /aviso-de-privacidade. */
router.get('/legal/documents/:key', agendamentoController.getPublicLegalDocument);

router.get('/settings', agendamentoController.getPublicSettings);
router.get('/modalities', agendamentoController.listModalities);
router.get('/units', agendamentoController.listActiveUnits);
router.get('/catalog', agendamentoController.getCatalog);
router.get('/availability/calendar', agendamentoController.getCalendarAvailability);
router.get('/availability', agendamentoController.checkAvailability);
router.post('/appointments', agendamentoController.createAppointmentPublic);
router.get('/appointments/:code', agendamentoController.getByCode);

module.exports = router;
