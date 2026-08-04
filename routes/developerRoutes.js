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
const brandingController = require('../controllers/brandingController');
const { requireDeveloper } = require('../middlewares/auth');

const router = express.Router();

const loginAttempts = new Map();
function developerLoginRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  recent.push(now);
  loginAttempts.set(key, recent);
  next();
}

/* Autenticação do desenvolvedor (pública apenas o login) */
router.post('/login', developerLoginRateLimit, developerController.login);
router.get('/me', requireDeveloper, developerController.me);
router.post('/change-password', requireDeveloper, developerController.changePassword);

/* Logo e favicon da tela de login do desenvolvedor: públicos, pois são
   exibidos antes de qualquer autenticação (fallback automático para os
   arquivos padrão da plataforma). */
router.get('/login-logo', brandingController.serveLoginLogo);
router.get('/login-favicon', brandingController.serveLoginFavicon);

router.use(requireDeveloper);

router.get('/dashboard', developerController.dashboard);
router.get('/backups', developerController.listBackupsHandler);
router.get('/backups/storage', developerController.storageInfoHandler);
router.get('/backups/:backupId', developerController.getBackupHandler);
router.get('/backups/:backupId/download', developerController.downloadBackupHandler);
router.delete('/backups/:backupId', developerController.deleteBackupHandler);
router.post('/backups/:backupId/restore', developerController.restoreBackupHandler);

/* Restaurações e manutenção por empresa */
router.get('/restores', developerController.listRestoresHandler);
router.get('/restores/:restoreId', developerController.getRestoreHandler);
router.post('/restores/:restoreId', developerController.retryRestoreHandler);
router.get('/tenants/:tenantId/maintenance', developerController.getMaintenanceHandler);

/* Configurações da plataforma */
router.get('/settings', developerController.platformSettings);
router.get('/settings/login-logo', brandingController.getLoginLogoHandler);
router.post('/settings/login-logo', brandingController.uploadLoginLogo);
router.delete('/settings/login-logo', brandingController.removeLoginLogo);
router.get('/settings/login-favicon', brandingController.getLoginFaviconHandler);
router.post('/settings/login-favicon', brandingController.uploadLoginFavicon);
router.delete('/settings/login-favicon', brandingController.removeLoginFavicon);

/* Empresas */
router.get('/tenants', developerController.listTenantsHandler);
router.post('/tenants', developerController.createTenant);
router.get('/tenants/:id', developerController.getTenantHandler);
router.put('/tenants/:id', developerController.updateTenantHandler);
router.patch('/tenants/:id/status', developerController.setTenantStatusHandler);
router.post('/tenants/:id/suspend', developerController.suspendTenant);
router.post('/tenants/:id/reactivate', developerController.reactivateTenant);
router.post('/tenants/:id/reset-password', developerController.resetTenantPassword);
router.patch('/tenants/:id/owner', developerController.updateTenantOwner);
router.post('/tenants/:id/impersonate', developerController.impersonate);
router.post('/tenants/:id/backup', developerController.backupTenant);
router.delete('/tenants/:id', developerController.deleteTenantHandler);

/* Identidade visual por empresa */
router.get('/tenants/:id/branding', brandingController.getDeveloperBranding);
router.get('/tenants/:id/branding/logo', brandingController.serveLogo);
router.get('/tenants/:id/branding/favicon', brandingController.serveFavicon);
router.post('/tenants/:id/branding/logo', brandingController.uploadLogo);
router.post('/tenants/:id/branding/favicon', brandingController.uploadFavicon);
router.delete('/tenants/:id/branding/logo', brandingController.removeLogo);
router.delete('/tenants/:id/branding/favicon', brandingController.removeFavicon);

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
router.put('/plans/:id/status', developerController.setPlanStatusHandler);

/* Assinaturas */
router.get('/subscriptions', developerController.listSubscriptionsHandler);
router.get('/tenants/:id/subscription', developerController.getSubscriptionHandler);
router.put('/tenants/:id/subscription', developerController.updateSubscriptionHandler);

/* Financeiro */
router.get('/financial', developerController.listFinancialHandler);
router.post('/financial', developerController.createFinancialEntry);
router.put('/financial/:id', developerController.updateFinancialEntryHandler);
router.delete('/financial/:id', developerController.deleteFinancialEntryHandler);

/* Leads comerciais (site institucional papicore.com.br) */
router.get('/leads', developerController.listLeadsHandler);
router.patch('/leads/:id/status', developerController.updateLeadStatusHandler);

/* Logs */
router.get('/logs', developerController.logsHandler);

module.exports = router;
