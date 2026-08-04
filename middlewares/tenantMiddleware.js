/*
 * tenantMiddleware.js
 *
 * Middleware da área administrativa. Descobre o banco da empresa SEMPRE
 * através do usuário autenticado (req.user.tenant_id) — nunca por parâmetros
 * vindos do frontend.
 *
 * Fluxo:
 *   Usuário logado → tenant_id → papi_core.db → database_name →
 *   abre banco da empresa → req.tenantDb
 *
 * Depois de aberto, todas as consultas da rota usam req.tenantDb via
 * getTenantDb() (AsyncLocalStorage).
 */

const { AppError, todayStr } = require('../utils/helpers');
const { getTenantById, isTenantInMaintenance } = require('../database/coreDatabase');
const { openTenantDatabase, runWithTenant } = require('../database/tenantDatabase');

function tenantMiddleware(req, res, next) {
  const user = req.user;
  if (!user) {
    return next(new AppError(401, 'Acesso negado. Faça login para continuar.'));
  }

  /* Desenvolvedores usam o painel próprio, não painéis de empresa. */
  if (user.role === 'developer') {
    return next(new AppError(403, 'Acesso restrito. Use o painel do desenvolvedor.'));
  }

  if (!user.tenant_id) {
    return next(new AppError(403, 'Usuário sem empresa vinculada.'));
  }

  const tenant = getTenantById(user.tenant_id);
  if (!tenant) {
    return next(new AppError(403, 'Empresa não encontrada.'));
  }
  if (tenant.status !== 'ACTIVE') {
    return next(new AppError(403, 'A empresa está suspensa. Entre em contato com o suporte.'));
  }
  if (tenant.expires_at && tenant.expires_at < todayStr()) {
    return next(new AppError(403, 'A assinatura desta empresa expirou.'));
  }
  if (isTenantInMaintenance(tenant.id)) {
    return next(new AppError(503, 'Sistema temporariamente em manutenção. Tente novamente em alguns instantes.'));
  }

  let db;
  try {
    db = openTenantDatabase(tenant.database_name);
  } catch (err) {
    console.error('[tenant] Falha ao abrir banco', tenant.database_name, err.message);
    return next(new AppError(500, 'Erro ao acessar o banco da empresa.'));
  }

  req.tenant = tenant;
  req.tenantId = tenant.id;
  req.tenantDb = db;

  /* Toda a cadeia de handlers roda dentro deste contexto, então
     getTenantDb() retorna o banco desta empresa. */
  runWithTenant(db, () => next());
}

module.exports = tenantMiddleware;
