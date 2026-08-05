/*
 * passwordResetController.js
 *
 * Recuperação de senha do painel administrativo dos tenants
 * (POST /api/auth/forgot-password, /reset-password/validate, /reset-password).
 *
 * Sempre isolado por tenant: o usuário é procurado só dentro da empresa do
 * domínio da requisição (req.tenantFromDomain, resolvido por
 * resolveTenantByHost em routes/authRoutes.js) via getUserByEmailAndTenant —
 * nunca uma busca global por e-mail. A resposta de "esqueci minha senha" é
 * sempre a mesma mensagem genérica, exista ou não o e-mail naquele tenant,
 * para não permitir enumeração de usuários.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const {
  getUserByEmailAndTenant,
  getUserById,
  getTenantById,
  isTenantExpired,
  insertPasswordResetToken,
  getPasswordResetTokenByHash,
  invalidateActivePasswordResetTokensForUser,
  finalizePasswordReset,
  cleanupExpiredPasswordResetTokens,
  logActivity
} = require('../database/coreDatabase');
const { AppError, isValidEmail, isStrongPassword } = require('../utils/helpers');
const { generateToken, hashToken, tokenExpiresAt, isTokenExpired, buildResetUrl } = require('../services/passwordResetService');
const { sendPasswordResetEmail } = require('../services/brevoEmailService');

const GENERIC_MESSAGE = 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.';
const INVALID_TOKEN_MESSAGE = 'Link inválido ou expirado.';
const MIN_RESPONSE_MS = 300;

function auditDetails(req) {
  return JSON.stringify({ ip: req.ip || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) });
}

/* Piso de tempo mínimo de resposta, aplicado nos mesmos moldes em todos os
   ramos de forgot-password (e-mail existente/inexistente/inativo/outro
   tenant), para reduzir diferença de timing entre eles. */
async function respondGeneric(res, startedAt) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_RESPONSE_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_RESPONSE_MS - elapsed));
  }
  return res.json({ message: GENERIC_MESSAGE });
}

/* Um usuário só é elegível para recuperação se: existir e estiver ativo
   dentro do tenant do domínio atual, e a empresa estiver ativa/não
   expirada. Usuários developer nunca batem aqui (tenant_id deles é NULL, e
   domainTenant.id é sempre um id de empresa). */
function findEligibleUser(email, domainTenant) {
  if (!email || !domainTenant) return null;
  const user = getUserByEmailAndTenant(email, domainTenant.id);
  if (!user || !user.active) return null;
  const tenant = getTenantById(domainTenant.id);
  if (!tenant || tenant.status !== 'ACTIVE' || isTenantExpired(tenant)) return null;
  return user;
}

async function forgotPassword(req, res) {
  const startedAt = Date.now();
  const domainTenant = req.tenantFromDomain;
  if (!domainTenant) {
    throw new AppError(404, 'Domínio não cadastrado nesta plataforma.');
  }

  const emailInput = req.body && req.body.email;
  const email = isValidEmail(emailInput) ? String(emailInput).trim().toLowerCase() : null;
  const user = findEligibleUser(email, domainTenant);

  logActivity(user ? user.id : null, domainTenant.id, 'PASSWORD_RESET_REQUESTED', auditDetails(req));

  if (user) {
    invalidateActivePasswordResetTokensForUser(user.id);

    const { token, tokenHash } = generateToken();
    insertPasswordResetToken({
      id: crypto.randomUUID(),
      user_id: user.id,
      tenant_id: domainTenant.id,
      token_hash: tokenHash,
      expires_at: tokenExpiresAt(),
      requested_ip: req.ip || null,
      requested_user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
    });
    cleanupExpiredPasswordResetTokens();

    const resetUrl = buildResetUrl(req, token);
    const result = await sendPasswordResetEmail({
      to: user.email,
      toName: user.name,
      tenantName: domainTenant.name,
      resetUrl
    });

    if (result && result.ok) {
      logActivity(user.id, domainTenant.id, 'PASSWORD_RESET_EMAIL_SENT', auditDetails(req));
    } else if (!result || !result.skipped) {
      logActivity(user.id, domainTenant.id, 'PASSWORD_RESET_EMAIL_FAILED', auditDetails(req));
    }
  }

  return respondGeneric(res, startedAt);
}

/*
 * Resolve e valida um token recebido (usado por validateResetToken e
 * resetPassword — o segundo nunca confia na validação feita pelo primeiro,
 * revalida tudo de novo). Retorna { ok:false, logAction } ou
 * { ok:true, row, user }.
 */
function resolveTokenRow(req, domainTenant) {
  const token = req.body && req.body.token;
  if (!token || !domainTenant) {
    return { ok: false, logAction: 'PASSWORD_RESET_INVALID_TOKEN' };
  }

  const row = getPasswordResetTokenByHash(hashToken(token));
  if (!row || row.used_at) {
    return { ok: false, logAction: 'PASSWORD_RESET_INVALID_TOKEN' };
  }
  if (isTokenExpired(row)) {
    return { ok: false, logAction: 'PASSWORD_RESET_EXPIRED_TOKEN' };
  }
  /* Token pertence a outro tenant (domínio diferente do que o gerou). */
  if (row.tenant_id !== domainTenant.id) {
    return { ok: false, logAction: 'PASSWORD_RESET_INVALID_TOKEN' };
  }

  const user = getUserById(row.user_id);
  if (!user || !user.active) {
    return { ok: false, logAction: 'PASSWORD_RESET_INVALID_TOKEN' };
  }
  const tenant = getTenantById(row.tenant_id);
  if (!tenant || tenant.status !== 'ACTIVE' || isTenantExpired(tenant)) {
    return { ok: false, logAction: 'PASSWORD_RESET_INVALID_TOKEN' };
  }

  return { ok: true, row, user };
}

function validateResetToken(req, res) {
  const domainTenant = req.tenantFromDomain;
  const result = resolveTokenRow(req, domainTenant);

  if (!result.ok) {
    logActivity(null, domainTenant ? domainTenant.id : null, result.logAction, auditDetails(req));
    return res.json({ valid: false, message: INVALID_TOKEN_MESSAGE });
  }

  logActivity(result.user.id, domainTenant.id, 'PASSWORD_RESET_TOKEN_VALIDATED', auditDetails(req));
  return res.json({ valid: true });
}

function resetPassword(req, res) {
  const domainTenant = req.tenantFromDomain;
  const result = resolveTokenRow(req, domainTenant);

  if (!result.ok) {
    logActivity(null, domainTenant ? domainTenant.id : null, result.logAction, auditDetails(req));
    throw new AppError(400, INVALID_TOKEN_MESSAGE);
  }

  const { password, password_confirmation: passwordConfirmation } = req.body || {};
  if (!password || String(password) !== String(passwordConfirmation)) {
    throw new AppError(400, 'A confirmação de senha não confere.');
  }
  if (!isStrongPassword(String(password))) {
    throw new AppError(400, 'A senha deve ter pelo menos 8 caracteres, com letra maiúscula, minúscula e número.');
  }

  const passwordHash = bcrypt.hashSync(String(password), 10);
  finalizePasswordReset({ userId: result.user.id, tokenId: result.row.id, passwordHash });

  logActivity(result.user.id, domainTenant.id, 'PASSWORD_RESET_SUCCESS', auditDetails(req));
  return res.json({ success: true });
}

module.exports = { forgotPassword, validateResetToken, resetPassword };
