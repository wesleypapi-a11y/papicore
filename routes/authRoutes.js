/*
 * authRoutes.js
 *
 * Autenticação da área administrativa (empresas).
 * resolveTenantByHost identifica a empresa pelo domínio para validar o login.
 */

const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middlewares/auth');
const { resolveTenantByHost } = require('../middlewares/domainTenantMiddleware');

const router = express.Router();

router.use(resolveTenantByHost);

router.post('/login', authController.login);
router.get('/me', requireAuth, authController.me);

module.exports = router;
