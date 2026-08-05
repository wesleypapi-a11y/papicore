/*
 * authRoutes.js
 *
 * Autenticação da área administrativa (empresas).
 * resolveTenantByHost identifica a empresa pelo domínio para validar o login.
 */

const express = require('express');
const authController = require('../controllers/authController');
const passwordResetController = require('../controllers/passwordResetController');
const { requireAuth } = require('../middlewares/auth');
const { resolveTenantByHost } = require('../middlewares/domainTenantMiddleware');
const { passwordResetIpRateLimit, passwordResetEmailRateLimit } = require('../middlewares/passwordResetRateLimit');

const router = express.Router();

router.use(resolveTenantByHost);

router.post('/login', authController.login);
router.get('/me', requireAuth, authController.me);

/* Recuperação de senha do painel administrativo dos tenants — públicas,
   sempre isoladas pelo domínio atual (req.tenantFromDomain, resolvido
   acima). Ver controllers/passwordResetController.js. */
router.post('/forgot-password', passwordResetIpRateLimit, passwordResetEmailRateLimit, passwordResetController.forgotPassword);
router.post('/reset-password/validate', passwordResetController.validateResetToken);
router.post('/reset-password', passwordResetController.resetPassword);

module.exports = router;
