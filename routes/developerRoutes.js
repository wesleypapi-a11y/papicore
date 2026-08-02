/*
 * developerRoutes.js
 *
 * Rotas do painel do desenvolvedor (Papi Core).
 * Exclusivas para usuários com role = developer.
 *
 * Apenas /login fica público (sem token ainda). Todas as demais rotas
 * exigem requireDeveloper (JWT válido + role = developer) — aplicado aqui,
 * rota a rota, em vez de no server.js, pois lá o middleware bloquearia o
 * próprio /login (que precisa ser acessível sem token).
 */

const express = require('express');
const developerController = require('../controllers/developerController');
const { requireDeveloper } = require('../middlewares/auth');

const router = express.Router();

/* Autenticação do desenvolvedor (pública apenas o login) */
router.post('/login', developerController.login);
router.get('/me', requireDeveloper, developerController.me);
router.post('/change-password', requireDeveloper, developerController.changePassword);

router.use(requireDeveloper);

router.get('/dashboard', developerController.dashboard);

/* Configurações da plataforma */
router.get('/settings', developerController.platformSettings);

/* Empresas */
router.get('/tenants', developerController.listTenantsHandler);
router.post('/tenants', developerController.createTenant);
router.get('/tenants/:id', developerController.getTenantHandler);
router.put('/tenants/:id', developerController.updateTenantHandler);
router.patch('/tenants/:id/status', developerController.setTenantStatusHandler);
router.post('/tenants/:id/reset-password', developerController.resetTenantPassword);
router.post('/tenants/:id/impersonate', developerController.impersonate);
router.get('/tenants/:id/backup', developerController.backupTenant);
router.delete('/tenants/:id', developerController.deleteTenantHandler);

/* Domínios por empresa */
router.get('/tenants/:id/domains', developerController.listDomainsHandler);
router.post('/tenants/:id/domains', developerController.addDomain);
router.patch('/domains/:domainId', developerController.updateDomainHandler);
router.delete('/domains/:domainId', developerController.removeDomainHandler);
router.get('/domains/:domainId/dns', developerController.dnsInstructions);

/* Usuários da plataforma */
router.get('/users', developerController.listUsersHandler);
router.post('/users', developerController.createUser);
router.put('/users/:id', developerController.updateUserHandler);
router.delete('/users/:id', developerController.deleteUserHandler);

/* Planos */
router.get('/plans', developerController.listPlansHandler);
router.post('/plans', developerController.createPlan);
router.put('/plans/:id', developerController.updatePlanHandler);
router.delete('/plans/:id', developerController.deletePlanHandler);

/* Logs */
router.get('/logs', developerController.logsHandler);

module.exports = router;
