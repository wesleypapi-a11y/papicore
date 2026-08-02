/*
 * createTenantDatabase.js
 *
 * Criação do banco individual de uma nova empresa (tenant).
 *
 * Padrão de nome: tenant_0004_nome_empresa.db
 *   - id com 4 dígitos (0001, 0002, 0003, ...);
 *   - slug da empresa sanitizado (minúsculas, sem acentos).
 *
 * Fluxo executado ao salvar uma nova empresa:
 *   1. cadastrar empresa no papi_core.db (obtém o id);
 *   2. gerar nome do banco a partir do id + slug;
 *   3. criar o arquivo SQLite;
 *   4. criar todas as tabelas;
 *   5. criar configurações padrão;
 *   6. criar categorias padrão;
 *   7. criar modalidades padrão;
 *   8. criar administrador (feito pelo developerController);
 *   9. vincular administrador à empresa (tenant_id);
 *   10. finalizar cadastro.
 */

const { slugify } = require('../utils/helpers');
const { openTenantDatabase, tenantFilePath } = require('./tenantDatabase');

/*
 * Gera o nome padrão do banco: tenant_0004_nome_empresa.db
 * O slug é sanitizado e espaços/hífens viram underscores para seguir o padrão.
 */
function buildDatabaseName(id, slug) {
  const clean = slugify(slug || 'empresa').replace(/-/g, '_');
  return `tenant_${String(id).padStart(4, '0')}_${clean}.db`;
}

/*
 * Verifica se o banco da empresa já existe no disco.
 */
function tenantDatabaseExists(databaseName) {
  const fs = require('fs');
  return fs.existsSync(tenantFilePath(databaseName));
}

/*
 * Cria o banco da empresa com todas as tabelas e dados padrão.
 * Retorna a instância aberta do banco (pronta para uso).
 *
 * @param {object} opts
 *   databaseName: nome do arquivo (ex: tenant_0004_nome_empresa.db)
 *   companyName:  nome comercial usado nas configurações/unidade padrão
 *   phone, whatsapp: contatos padrão
 *   fullCatalog:  se true, insere também o catálogo completo do primeiro cliente
 */
function createTenantDatabase(opts) {
  const databaseName = opts.databaseName || buildDatabaseName(opts.id, opts.slug);
  const { createTenantDatabase: create } = require('./tenantDatabase');
  return create(databaseName, {
    companyName: opts.companyName,
    phone: opts.phone,
    whatsapp: opts.whatsapp,
    fullCatalog: Boolean(opts.fullCatalog)
  });
}

module.exports = {
  buildDatabaseName,
  tenantDatabaseExists,
  createTenantDatabase
};
