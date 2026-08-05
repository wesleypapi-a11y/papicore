/*
 * auth.js
 *
 * Autenticação JWT. O usuário é recarregado do banco central (papi_core.db)
 * a cada requisição para garantir que dados frescos (status, role, tenant_id)
 * sejam usados — nunca confiamos em informações do token em si.
 */

const jwt = require('jsonwebtoken');

const { AppError } = require('../utils/helpers');
const { getUserById } = require('../database/coreDatabase');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new AppError(401, 'Acesso negado. Faça login para continuar.'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = getUserById(payload.id);
    if (!user || !user.active) {
      return next(new AppError(401, 'Usuário não encontrado ou inativo.'));
    }
    /* Token emitido antes da senha atual: a senha foi trocada (reset ou
       redefinição) depois deste login, então a sessão antiga é encerrada. */
    if ((payload.pwd || null) !== (user.password_changed_at || null)) {
      return next(new AppError(401, 'Sessão expirada ou inválida. Faça login novamente.'));
    }
    req.user = user;
    req.token = payload;
    return next();
  } catch {
    return next(new AppError(401, 'Sessão expirada ou inválida. Faça login novamente.'));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'Acesso restrito a usuários autorizados.'));
    }
    return next();
  };
}

/* Apenas usuários com role = developer acessam o painel do desenvolvedor. */
const requireDeveloper = [requireAuth, requireRole('developer')];

module.exports = { requireAuth, requireRole, requireDeveloper };
