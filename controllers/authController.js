/*
 * authController.js
 *
 * Autenticação da área administrativa (empresas).
 *
 * Os usuários vivem no banco central (papi_core.db). O login valida:
 *   - e-mail e senha;
 *   - domínio da requisição (req.tenantFromDomain, resolvido por
 *     resolveTenantByHost) deve corresponder à empresa do usuário;
 *   - empresa ativa e dentro do período de assinatura.
 *
 * Um usuário da empresa A NÃO consegue fazer login no domínio da empresa B.
 * O banco utilizado nas próximas requisições é sempre o do usuário autenticado.
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const {
  getUserByEmail,
  getUserById,
  getTenantById,
  isTenantExpired
} = require('../database/coreDatabase');
const { AppError, isValidEmail } = require('../utils/helpers');

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, tenant_id: user.tenant_id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function login(req, res) {
  const { email, password } = req.body || {};

  if (!isValidEmail(email) || !password) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const user = getUserByEmail(String(email).trim().toLowerCase());
  if (!user) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }
  if (!user.active) {
    throw new AppError(401, 'Usuário inativo. Entre em contato com o suporte.');
  }

  const ok = bcrypt.compareSync(String(password), user.password_hash);
  if (!ok) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  /* Desenvolvedores usam o painel exclusivo /desenvolvedor. */
  if (user.role === 'developer') {
    throw new AppError(403, 'Use o painel do desenvolvedor para acessar.');
  }

  /* O domínio determina em qual empresa o usuário pode entrar. */
  const domainTenant = req.tenantFromDomain;
  if (!domainTenant) {
    throw new AppError(404, 'Domínio não cadastrado nesta plataforma.');
  }
  if (user.tenant_id !== domainTenant.id) {
    throw new AppError(403, 'Estas credenciais não pertencem à empresa deste domínio.');
  }
  if (domainTenant.status !== 'ACTIVE') {
    throw new AppError(403, 'A empresa está suspensa. Entre em contato com o suporte.');
  }
  const tenant = getTenantById(domainTenant.id);
  if (isTenantExpired(tenant)) {
    throw new AppError(403, 'A assinatura desta empresa expirou.');
  }

  const token = signToken(user);
  return res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, tenant_id: user.tenant_id }
  });
}

function me(req, res) {
  const user = getUserById(req.user.id);
  if (!user) {
    throw new AppError(401, 'Usuário não encontrado.');
  }

  const tenant = user.tenant_id ? getTenantById(user.tenant_id) : null;
  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    tenant_id: user.tenant_id,
    active: user.active,
    created_at: user.created_at,
    tenant: tenant
      ? {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          database_name: tenant.database_name,
          plan: tenant.plan,
          status: tenant.status
        }
      : null
  });
}

module.exports = { login, me, signToken };
