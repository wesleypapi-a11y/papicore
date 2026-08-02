/*
 * tenantDatabase.js
 *
 * Responsável por abrir o banco SQLite da empresa (tenant) correta.
 *
 * Fluxo:
 *   Login → usuário encontrado → tenant_id → consulta papi_core.db →
 *   database_name → abre data/tenants/tenant_XXXX_slug.db → consultas.
 *
 * O banco correto é sempre descoberto através do usuário autenticado ou do
 * domínio da requisição — nunca por parâmetros vindos do frontend.
 *
 * Como better-sqlite3 é síncrono, usamos AsyncLocalStorage para manter o
 * banco "atual" da requisição. Controllers e services obtêm o banco com
 * getTenantDb() (ou getDb()), e o middleware envolvem a cadeia com
 * runWithTenant(db, fn).
 */

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const Database = require('better-sqlite3');

const { upgradeSchema, seedDefaults } = require('./tenantSchema');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');

const als = new AsyncLocalStorage();
const openDbs = new Map();

function tenantsDir() {
  fs.mkdirSync(TENANTS_DIR, { recursive: true });
  return TENANTS_DIR;
}

function tenantFilePath(databaseName) {
  return path.join(tenantsDir(), databaseName);
}

function isDatabaseNameSafe(databaseName) {
  return typeof databaseName === 'string' && /^tenant_\d{4}_[a-z0-9_-]+\.db$/.test(databaseName);
}

/*
 * Abre (e mantém cacheado) o banco da empresa, aplicando o schema/migrações.
 * O cache evita abrir dezenas de arquivos a cada requisição.
 */
function openTenantDatabase(databaseName) {
  if (!isDatabaseNameSafe(databaseName)) {
    throw new Error(`Nome de banco de tenant inválido: ${databaseName}`);
  }
  if (openDbs.has(databaseName)) {
    return openDbs.get(databaseName);
  }

  const filePath = tenantFilePath(databaseName);
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  upgradeSchema(db);

  openDbs.set(databaseName, db);
  return db;
}

/*
 * Cria um banco de tenant do zero: abre o arquivo, aplica o schema e popula os
 * dados padrão (configurações, unidade, modalidades, categorias).
 * Retorna a instância do banco aberto.
 */
function createTenantDatabase(databaseName, opts = {}) {
  const db = openTenantDatabase(databaseName);
  seedDefaults(db, opts);
  return db;
}

function closeTenantDatabase(databaseName) {
  const db = openDbs.get(databaseName);
  if (db) {
    try {
      db.close();
    } catch (err) {
      console.error(`[tenantDatabase] Erro ao fechar ${databaseName}:`, err.message);
    }
    openDbs.delete(databaseName);
  }
}

/* Remove o arquivo do banco (e artefatos WAL/SHM) do disco. */
function deleteTenantDatabase(databaseName) {
  closeTenantDatabase(databaseName);
  const suffixes = ['', '-wal', '-shm'];
  for (const suffix of suffixes) {
    const filePath = tenantFilePath(databaseName + suffix);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[tenantDatabase] Erro ao remover ${filePath}:`, err.message);
    }
  }
}

/*
 * Retorna o banco de tenant do contexto da requisição atual.
 * Deve ser chamado dentro do escopo de runWithTenant.
 */
function getTenantDb() {
  const store = als.getStore();
  if (store && store.db) return store.db;
  throw new Error('Nenhum banco de tenant está ativo no contexto atual.');
}

/* Alias curto usado nos controllers/services. */
function getDb() {
  return getTenantDb();
}

/* Executa fn dentro de um contexto em que getTenantDb() retorna o banco informado. */
function runWithTenant(db, fn) {
  return als.run({ db }, fn);
}

/* Informações de contexto da requisição atual (tenant id, etc). */
function getTenantContext() {
  return als.getStore() || {};
}

module.exports = {
  tenantsDir,
  tenantFilePath,
  openTenantDatabase,
  createTenantDatabase,
  closeTenantDatabase,
  deleteTenantDatabase,
  getTenantDb,
  getDb,
  runWithTenant,
  getTenantContext
};
