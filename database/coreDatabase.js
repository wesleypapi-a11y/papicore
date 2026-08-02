/*
 * coreDatabase.js
 *
 * Banco central da plataforma "Papi Core": data/papi_core.db
 *
 * Este banco NÃO armazena agendamentos, clientes, serviços ou agenda de
 * nenhuma empresa. Ele controla apenas a plataforma:
 *
 *   - plans: planos disponíveis (FREE, STARTER, PRO, ENTERPRISE...);
 *   - tenants: empresas cadastradas (nome, slug, banco, plano, status...);
 *   - users: usuários da plataforma (developer + usuários das empresas);
 *   - tenant_domains: domínios próprios de cada empresa;
 *   - activity_logs: trilha de auditoria do painel do desenvolvedor.
 *
 * Ao subir o servidor, este módulo também migra o banco legado
 * (data/app.db) para o banco da primeira empresa (tenant_0001_torque_detail.db),
 * preservando todos os dados existentes.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { slugify, todayStr } = require('../utils/helpers');
const {
  openTenantDatabase,
  createTenantDatabase,
  tenantFilePath,
  deleteTenantDatabase
} = require('./tenantDatabase');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CORE_FILE = path.join(DATA_DIR, 'papi_core.db');
const LEGACY_FILE = path.join(DATA_DIR, 'app.db');

const CORE_DDL = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  monthly_price REAL NOT NULL DEFAULT 0,
  appointment_limit INTEGER,
  features TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  database_name TEXT NOT NULL UNIQUE,
  document TEXT,
  email TEXT,
  phone TEXT,
  plan TEXT NOT NULL DEFAULT 'FREE',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS tenant_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain TEXT NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_name TEXT,
  tenant_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

const SEED_PLANS = [
  { id: 1, name: 'Gratuito', slug: 'FREE', monthly_price: 0, appointment_limit: 30, features: JSON.stringify(['Até 30 agendamentos/mês', '1 unidade', '1 domínio próprio']) },
  { id: 2, name: 'Starter', slug: 'STARTER', monthly_price: 49.9, appointment_limit: 100, features: JSON.stringify(['Até 100 agendamentos/mês', '1 unidade', 'Domínios próprios', 'Suporte por e-mail']) },
  { id: 3, name: 'Pro', slug: 'PRO', monthly_price: 99.9, appointment_limit: null, features: JSON.stringify(['Agendamentos ilimitados', 'Múltiplas unidades', 'Domínios próprios', 'Backup automático', 'Suporte prioritário']) },
  { id: 4, name: 'Enterprise', slug: 'ENTERPRISE', monthly_price: 199.9, appointment_limit: null, features: JSON.stringify(['Agendamentos ilimitados', 'Múltiplas unidades', 'Domínios ilimitados', 'Backup automático', 'Onboarding dedicado']) }
];

let db = null;

function getCoreDb() {
  if (!db) initCore();
  return db;
}

function openCore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(CORE_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CORE_DDL);
}

function seedCore() {
  const insertPlan = db.prepare(
    'INSERT OR IGNORE INTO plans (id, name, slug, monthly_price, appointment_limit, features) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of SEED_PLANS) {
    insertPlan.run(p.id, p.name, p.slug, p.monthly_price, p.appointment_limit, p.features);
  }

  /* Usuário desenvolvedor (role = developer, tenant_id = NULL) */
  const devEmail = String(process.env.DEVELOPER_EMAIL || 'developer@papi.app').toLowerCase();
  const devPassword = process.env.DEVELOPER_PASSWORD || 'developer123';
  if (!db.prepare('SELECT id FROM users WHERE email = ?').get(devEmail)) {
    db.prepare('INSERT INTO users (tenant_id, name, email, password_hash, role, active) VALUES (NULL, ?, ?, ?, ?, 1)').run(
      process.env.DEVELOPER_NAME || 'Desenvolvedor',
      devEmail,
      bcrypt.hashSync(devPassword, 10),
      'developer'
    );
  }

  /* Primeiro cliente: Torque Detail */
  if (!db.prepare('SELECT id FROM tenants WHERE slug = ?').get('torque-detail')) {
    const info = db.prepare(
      `INSERT INTO tenants (name, slug, database_name, document, email, phone, plan, status)
       VALUES ('Torque Detail', 'torque-detail', 'tenant_0001_torque_detail.db', '', ?, ?, 'PRO', 'ACTIVE')`
    ).run(process.env.ADMIN_EMAIL || 'admin@sistema.com', process.env.ADMIN_WHATSAPP || '');
    const tenantId = info.lastInsertRowid;

    /* Administrador (owner) da Torque Detail */
    const ownerEmail = String(process.env.ADMIN_EMAIL || 'admin@sistema.com').toLowerCase();
    if (!db.prepare('SELECT id FROM users WHERE email = ?').get(ownerEmail)) {
      db.prepare('INSERT INTO users (tenant_id, name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?, 1)').run(
        tenantId,
        process.env.ADMIN_NAME || 'Administrador',
        ownerEmail,
        bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10),
        'owner'
      );
    }

    /* Domínio principal da Torque Detail (não verificado até o dev validar) */
    db.prepare('INSERT OR IGNORE INTO tenant_domains (tenant_id, domain, is_primary, verified) VALUES (?, ?, 1, 0)').run(
      tenantId,
      process.env.TORQUE_DETAIL_DOMAIN || 'torquedetail.com.br'
    );
  }
}

/*
 * Migra o banco legado (data/app.db) para o banco da primeira empresa.
 * Usa VACUUM INTO para gerar um snapshot consistente (ignora WAL/SHM).
 * Os usuários do app.db são transferidos para o banco central e a tabela
 * "users" é removida do banco da empresa (autenticação vive no central).
 */
function migrateLegacyData() {
  if (!fs.existsSync(LEGACY_FILE)) return;

  const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get('torque-detail');
  if (!tenant) return;

  const targetPath = tenantFilePath(tenant.database_name);
  if (fs.existsSync(targetPath)) return; // já migrado

  console.log('[papi-core] Migrando data/app.db para', tenant.database_name);

  const escapedTarget = targetPath.replace(/'/g, "''");
  const legacy = new Database(LEGACY_FILE, { readonly: true });
  try {
    legacy.exec(`VACUUM INTO '${escapedTarget}'`);
  } finally {
    legacy.close();
  }

  const tenantDb = openTenantDatabase(tenant.database_name);

  /* transfere usuários do app.db para o banco central */
  if (tenantDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()) {
    const users = tenantDb.prepare('SELECT * FROM users').all();
    for (const u of users) {
      const email = String(u.email || '').toLowerCase();
      if (!email) continue;
      if (!db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
        db.prepare('INSERT INTO users (tenant_id, name, email, password_hash, role, active) VALUES (?, ?, ?, ?, ?, ?)').run(
          tenant.id,
          u.name || 'Administrador',
          email,
          u.password_hash,
          u.role === 'admin' ? 'owner' : (u.role || 'admin'),
          u.active !== undefined ? u.active : 1
        );
      }
    }
    /* autenticação é centralizada no papi_core.db */
    tenantDb.exec('DROP TABLE IF EXISTS users');
  }

  db.prepare("UPDATE tenants SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(tenant.id);
  logActivity(null, tenant.id, 'MIGRATION', 'Dados migrados do banco legado app.db');
}

/*
 * Garante que o banco da primeira empresa exista no disco.
 * Em instalações sem app.db legado, cria o banco com o catálogo completo.
 */
function ensureDefaultTenant() {
  const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get('torque-detail');
  if (!tenant) return;
  if (!fs.existsSync(tenantFilePath(tenant.database_name))) {
    console.log('[papi-core] Criando banco padrão', tenant.database_name);
    createTenantDatabase(tenant.database_name, {
      companyName: 'Torque Detail',
      phone: process.env.ADMIN_WHATSAPP || '(12) 99185-7345',
      whatsapp: process.env.ADMIN_WHATSAPP || '(12) 99185-7345',
      fullCatalog: true
    });
  }
}

function initCore() {
  if (db) return db;
  openCore();
  seedCore();
  migrateLegacyData();
  ensureDefaultTenant();
  return db;
}

/* ---------- Tenants ---------- */

function listTenants() {
  return db.prepare('SELECT * FROM tenants ORDER BY id ASC').all();
}

function getTenantById(id) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

function getTenantBySlug(slug) {
  return db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug);
}

function getTenantByDatabaseName(databaseName) {
  return db.prepare('SELECT * FROM tenants WHERE database_name = ?').get(databaseName);
}

function insertTenant(data) {
  const info = db.prepare(
    `INSERT INTO tenants (name, slug, database_name, document, email, phone, plan, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.name, data.slug, data.database_name,
    data.document || null, data.email || null, data.phone || null,
    data.plan || 'FREE', data.status || 'ACTIVE', data.expires_at || null
  );
  return getTenantById(info.lastInsertRowid);
}

function updateTenant(id, fields) {
  const allowed = ['name', 'slug', 'document', 'email', 'phone', 'plan', 'status', 'expires_at'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return getTenantById(id);
  sets.push("updated_at = datetime('now', 'localtime')");
  params.push(id);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getTenantById(id);
}

function setTenantStatus(id, status) {
  return updateTenant(id, { status });
}

function deleteTenant(id) {
  const tenant = getTenantById(id);
  if (!tenant) return false;
  deleteTenantDatabase(tenant.database_name);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
  return true;
}

function nextTenantId() {
  const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM tenants').get();
  return row.max_id + 1;
}

/* ---------- Domínios ---------- */

/*
 * Normaliza um host: remove protocolo, porta e o prefixo "www", e converte
 * para minúsculas. Ex.: "WWW.TorqueDetail.com.br:8080" -> "torquedetail.com.br"
 */
function normalizeDomain(host) {
  let h = String(host || '').trim();
  if (h.includes('://')) h = h.split('://')[1];
  if (h.includes(':')) h = h.split(':')[0];
  h = h.toLowerCase();
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

function listDomains(tenantId) {
  return db.prepare('SELECT * FROM tenant_domains WHERE tenant_id = ? ORDER BY is_primary DESC, id ASC').all(tenantId);
}

function getDomainById(id) {
  return db.prepare('SELECT * FROM tenant_domains WHERE id = ?').get(id);
}

/* Busca um domínio junto com o tenant (JOIN). Retorna null se não existir. */
function getDomainRow(domain) {
  const normalized = normalizeDomain(domain);
  return db.prepare(
    `SELECT d.id AS domain_id, d.domain, d.is_primary, d.verified,
            t.id AS tenant_id, t.name, t.slug, t.database_name, t.status, t.plan
     FROM tenant_domains d
     JOIN tenants t ON t.id = d.tenant_id
     WHERE d.domain = ?`
  ).get(normalized);
}

function insertDomain(tenantId, domain, isPrimary) {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error('Domínio inválido.');
  if (isPrimary) db.prepare('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?').run(tenantId);
  const info = db.prepare(
    'INSERT INTO tenant_domains (tenant_id, domain, is_primary, verified) VALUES (?, ?, ?, 0)'
  ).run(tenantId, normalized, isPrimary ? 1 : 0);
  return getDomainById(info.lastInsertRowid);
}

function setDomainPrimary(domainId) {
  const row = getDomainById(domainId);
  if (!row) return null;
  db.prepare('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?').run(row.tenant_id);
  db.prepare('UPDATE tenant_domains SET is_primary = 1 WHERE id = ?').run(domainId);
  return getDomainById(domainId);
}

function setDomainVerified(domainId, verified) {
  db.prepare('UPDATE tenant_domains SET verified = ? WHERE id = ?').run(verified ? 1 : 0, domainId);
  return getDomainById(domainId);
}

function updateDomain(domainId, fields) {
  const allowed = ['is_primary', 'verified'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key] ? 1 : 0);
    }
  }
  if (fields.is_primary && fields.is_primary !== 0) {
    const row = getDomainById(domainId);
    if (row) db.prepare('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?').run(row.tenant_id);
  }
  if (!sets.length) return getDomainById(domainId);
  params.push(domainId);
  db.prepare(`UPDATE tenant_domains SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getDomainById(domainId);
}

function deleteDomain(id) {
  db.prepare('DELETE FROM tenant_domains WHERE id = ?').run(id);
  return true;
}

/* ---------- Usuários ---------- */

function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY id ASC').all();
}

function listUsersByTenant(tenantId) {
  return db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY id ASC').all(tenantId);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
}

function getUserByEmailAndTenant(email, tenantId) {
  return db.prepare('SELECT * FROM users WHERE email = ? AND tenant_id = ?').get(String(email || '').toLowerCase(), tenantId);
}

function getTenantOwner(tenantId) {
  return (
    db.prepare("SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' ORDER BY id ASC LIMIT 1").get(tenantId) ||
    db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY id ASC LIMIT 1').get(tenantId)
  );
}

function insertUser(data) {
  const info = db.prepare(
    `INSERT INTO users (tenant_id, name, email, password_hash, role, active)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    data.tenant_id ?? null,
    data.name,
    String(data.email).toLowerCase(),
    data.password_hash,
    data.role || 'admin',
    data.active === undefined ? 1 : (data.active ? 1 : 0)
  );
  return getUserById(info.lastInsertRowid);
}

function updateUser(id, fields) {
  const allowed = ['name', 'email', 'role', 'active'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === 'active' ? (fields[key] ? 1 : 0) : fields[key]);
    }
  }
  if (fields.email !== undefined) params[params.length - 1] = String(fields.email).toLowerCase();
  if (!sets.length) return getUserById(id);
  params.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getUserById(id);
}

function setUserActive(id, active) {
  return updateUser(id, { active });
}

function setUserPassword(id, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  return getUserById(id);
}

function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

function countTenantUsers(tenantId) {
  return db.prepare('SELECT COUNT(*) AS total FROM users WHERE tenant_id = ?').get(tenantId).total;
}

/* ---------- Planos ---------- */

function listPlans() {
  return db.prepare('SELECT * FROM plans ORDER BY id ASC').all();
}

function getPlan(slug) {
  return db.prepare('SELECT * FROM plans WHERE slug = ?').get(slug);
}

function insertPlan(data) {
  const info = db.prepare(
    `INSERT INTO plans (name, slug, monthly_price, appointment_limit, features)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    data.name,
    String(data.slug || slugify(data.name)).toUpperCase(),
    data.monthly_price ?? 0,
    data.appointment_limit ?? null,
    data.features ? JSON.stringify(data.features) : null
  );
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(info.lastInsertRowid);
}

function updatePlan(id, fields) {
  const allowed = ['name', 'slug', 'monthly_price', 'appointment_limit', 'features', 'active'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === 'features' ? JSON.stringify(fields[key]) : fields[key]);
    }
  }
  if (!sets.length) return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  sets.push("updated_at = datetime('now', 'localtime')");
  params.push(id);
  db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
}

function deletePlan(id) {
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return true;
}

/* ---------- Logs ---------- */

function logActivity(userId, tenantId, action, details) {
  const user = userId ? getUserById(userId) : null;
  db.prepare(
    `INSERT INTO activity_logs (user_id, user_name, tenant_id, action, details)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    user ? user.id : null,
    user ? user.name : 'Sistema',
    tenantId ?? null,
    action,
    details ? String(details) : null
  );
}

function listLogs(limit = 100) {
  return db.prepare('SELECT * FROM activity_logs ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------- Utilitários ---------- */

function countTenantAppointments(databaseName) {
  try {
    const tenantDb = openTenantDatabase(databaseName);
    const row = tenantDb.prepare('SELECT COUNT(*) AS total FROM appointments').get();
    return row ? row.total : 0;
  } catch (err) {
    console.error('[papi-core] Falha ao contar agendamentos de', databaseName, err.message);
    return 0;
  }
}

function isTenantExpired(tenant) {
  return Boolean(tenant && tenant.expires_at && tenant.expires_at < todayStr());
}

module.exports = {
  initCore,
  getCoreDb,
  CORE_FILE,
  DATA_DIR,
  normalizeDomain,
  /* tenants */
  listTenants,
  getTenantById,
  getTenantBySlug,
  getTenantByDatabaseName,
  insertTenant,
  updateTenant,
  setTenantStatus,
  deleteTenant,
  nextTenantId,
  countTenantAppointments,
  isTenantExpired,
  /* domínios */
  listDomains,
  getDomainById,
  getDomainRow,
  insertDomain,
  setDomainPrimary,
  setDomainVerified,
  updateDomain,
  deleteDomain,
  /* usuários */
  listUsers,
  listUsersByTenant,
  getUserById,
  getUserByEmail,
  getUserByEmailAndTenant,
  getTenantOwner,
  insertUser,
  updateUser,
  setUserActive,
  setUserPassword,
  deleteUser,
  countTenantUsers,
  /* planos */
  listPlans,
  getPlan,
  insertPlan,
  updatePlan,
  deletePlan,
  /* logs */
  logActivity,
  listLogs
};
