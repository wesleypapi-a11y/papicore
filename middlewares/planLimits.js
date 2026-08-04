/*
 * planLimits.js
 *
 * Middleware de limite de plano aplicado à criação de unidades no painel do
 * tenant. Usa o tenant já resolvido pelo tenantMiddleware (req.tenant) e as
 * regras de planService. Nunca confia no front: o limite é revalidado aqui.
 */

const planService = require('../services/planService');

function enforceUnitLimit(req, res, next) {
  try {
    const tenant = req.tenant;
    if (!tenant) {
      return res.status(403).json({
        error: 'Empresa não identificada.',
        code: 'TENANT_NOT_FOUND'
      });
    }
    planService.canTenantCreateUnit(tenant);
    return next();
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.extra || {})
      });
    }
    return next(err);
  }
}

module.exports = { enforceUnitLimit };
