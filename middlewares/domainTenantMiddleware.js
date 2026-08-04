/*
 * domainTenantMiddleware.js
 *
 * Resolve o tenant pelo domínio da requisição (hostname).
 *
 * Fluxo:
 *   Domínio acessado → consulta tenant_domains no papi_core.db → empresa
 *   encontrada → database_name → banco individual aberto → página carregada.
 *
 * Passos de normalização do host:
 *   1. lê req.hostname / req.headers.host;
 *   2. remove a porta;
 *   3. converte para minúsculas;
 *   4. remove o prefixo www;
 *   5. consulta tenant_domains;
 *   6. valida status (403 se suspensa) e verificação do domínio (404 se não
 *      verificado);
 *   7. abre o banco correto e define req.tenant, req.tenantId, req.tenantDb.
 *
 * Em desenvolvimento (NODE_ENV !== 'production'), o host localhost/127.0.0.1
 * usa o tenant padrão (DEFAULT_TENANT_SLUG) para manter o fluxo local.
 */

const { AppError } = require('../utils/helpers');
const { getDomainRow, getTenantBySlug, normalizeDomain, isTenantInMaintenance } = require('../database/coreDatabase');
const { openTenantDatabase, runWithTenant } = require('../database/tenantDatabase');

function isDevLocalhost(domain) {
  return (
    process.env.NODE_ENV !== 'production' &&
    ['localhost', '127.0.0.1', '::1'].includes(domain)
  );
}

/*
 * Middleware leve: apenas resolve o tenant a partir do domínio e define
 * req.tenantFromDomain (sem abrir banco). Usado no login administrativo para
 * validar que o usuário pertence à empresa do domínio.
 */
function resolveTenantByHost(req, res, next) {
  const host = String(req.headers.host || req.hostname || '');
  const domain = normalizeDomain(host);

  const row = getDomainRow(domain);
  if (row) {
    req.tenantFromDomain = {
      id: row.tenant_id,
      name: row.name,
      slug: row.slug,
      database_name: row.database_name,
      status: row.status,
      plan: row.plan,
      domain: row.domain,
      verified: row.verified ? 1 : 0
    };
  } else if (isDevLocalhost(domain)) {
    const def = getTenantBySlug(process.env.DEFAULT_TENANT_SLUG || '');
    if (def) {
      req.tenantFromDomain = {
        id: def.id,
        name: def.name,
        slug: def.slug,
        database_name: def.database_name,
        status: def.status,
        plan: def.plan,
        domain,
        verified: 1
      };
    }
  }

  req.tenantDomain = domain;
  return next();
}

/*
 * Middleware completo para rotas públicas. Resolve o tenant pelo domínio e
 * abre o banco da empresa (req.tenantDb), colocando toda a cadeia dentro do
 * contexto do tenant.
 */
function domainTenantMiddleware(req, res, next) {
  resolveTenantByHost(req, res, (err) => {
    if (err) return next(err);

    const t = req.tenantFromDomain;
    if (!t) {
      return next(new AppError(404, 'Domínio não cadastrado nesta plataforma.'));
    }
    if (!t.verified) {
      return next(new AppError(404, 'Domínio não validado.'));
    }
    if (t.status !== 'ACTIVE') {
      return next(new AppError(403, 'A empresa associada a este domínio está suspensa.'));
    }
    if (isTenantInMaintenance(t.id)) {
      return next(new AppError(503, 'Sistema temporariamente em manutenção. Tente novamente em alguns instantes.'));
    }

    let db;
    try {
      db = openTenantDatabase(t.database_name);
    } catch (openErr) {
      console.error('[domainTenant] Falha ao abrir banco', t.database_name, openErr.message);
      return next(new AppError(500, 'Erro ao acessar o banco da empresa.'));
    }

    req.tenant = t;
    req.tenantId = t.id;
    req.tenantDb = db;

    runWithTenant(db, () => next());
  });
}

module.exports = { domainTenantMiddleware, resolveTenantByHost, normalizeDomain, isDevLocalhost };
