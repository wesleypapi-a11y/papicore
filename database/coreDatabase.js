/*
 * coreDatabase.js
 *
 * Banco central da plataforma "PapiCore": data/papi_core.db
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
const { removeTenantAssets } = require('../utils/assetStorage');

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, '..', 'data');

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

CREATE TABLE IF NOT EXISTS financial_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'MONTHLY',
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  percentage REAL,
  installment_number INTEGER,
  installment_total INTEGER,
  due_date TEXT NOT NULL,
  paid_at TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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

CREATE TABLE IF NOT EXISTS tenant_branding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  logo_path TEXT,
  favicon_path TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  accent_color TEXT,
  browser_title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
  const devEmail = String(process.env.DEVELOPER_EMAIL || '').trim().toLowerCase();
  const devPassword = String(process.env.DEVELOPER_PASSWORD || '');
  if (!devEmail || !devPassword) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DEVELOPER_EMAIL e DEVELOPER_PASSWORD são obrigatórios em produção.');
    }
    console.warn('[papi-core] Desenvolvedor não criado: configure DEVELOPER_EMAIL e DEVELOPER_PASSWORD.');
  }
  if (devEmail && devPassword && !db.prepare('SELECT id FROM users WHERE email = ?').get(devEmail)) {
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

    /* Domínio principal da Torque Detail: configurado pelo próprio operador da
       plataforma via env var, então já nasce verificado (diferente de um
       domínio que um tenant adicionaria depois e precisaria comprovar
       propriedade via DNS). */
    db.prepare('INSERT OR IGNORE INTO tenant_domains (tenant_id, domain, is_primary, verified) VALUES (?, ?, 1, 1)').run(
      tenantId,
      process.env.TORQUE_DETAIL_DOMAIN || 'torquedetail.com.br'
    );
  }
}

/*
 * Corrige instalações que já tinham o domínio padrão da Torque Detail
 * salvo como não verificado (estado em que a rota pública ficava
 * inacessível por esse domínio). Idempotente: roda a cada boot.
 */
function ensureDefaultDomainVerified() {
  const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get('torque-detail');
  if (!tenant) return;
  const domain = normalizeDomain(process.env.TORQUE_DETAIL_DOMAIN || 'torquedetail.com.br');
  db.prepare(
    'UPDATE tenant_domains SET verified = 1 WHERE tenant_id = ? AND domain = ? AND verified = 0'
  ).run(tenant.id, domain);
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
  ensureDefaultDomainVerified();
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
  try {
    removeTenantAssets(id);
  } catch (err) {
    console.error('[papi-core] Erro ao remover assets da empresa', id, err.message);
  }
  return true;
}

function deleteTenantRecord(id) {
  db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
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

/* Troca o hostname de um domínio já cadastrado. Volta verified para 0, já
   que um domínio novo precisa apontar o DNS e ser verificado de novo. */
function setDomainValue(domainId, domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error('Domínio inválido.');
  db.prepare('UPDATE tenant_domains SET domain = ?, verified = 0 WHERE id = ?').run(normalized, domainId);
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

/* ---------- Financeiro ---------- */

function listFinancialEntries(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.tenant_id) { clauses.push('tenant_id = ?'); params.push(filters.tenant_id); }
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.type) { clauses.push('type = ?'); params.push(filters.type); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM financial_entries ${where} ORDER BY due_date DESC, id DESC`).all(...params);
}

function getFinancialEntry(id) {
  return db.prepare('SELECT * FROM financial_entries WHERE id = ?').get(id);
}

function insertFinancialEntry(data) {
  const info = db.prepare(
    `INSERT INTO financial_entries (tenant_id, type, description, amount, percentage, installment_number, installment_total, due_date, paid_at, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.tenant_id,
    data.type,
    data.description || null,
    data.amount ?? 0,
    data.percentage ?? null,
    data.installment_number ?? null,
    data.installment_total ?? null,
    data.due_date,
    data.paid_at || null,
    data.status || 'PENDING',
    data.notes || null
  );
  return getFinancialEntry(info.lastInsertRowid);
}

function updateFinancialEntry(id, fields) {
  const allowed = ['type', 'description', 'amount', 'percentage', 'installment_number', 'installment_total', 'due_date', 'paid_at', 'status', 'notes'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return getFinancialEntry(id);
  sets.push("updated_at = datetime('now', 'localtime')");
  params.push(id);
  db.prepare(`UPDATE financial_entries SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getFinancialEntry(id);
}

function deleteFinancialEntry(id) {
  db.prepare('DELETE FROM financial_entries WHERE id = ?').run(id);
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

/* ---------- Identidade visual ---------- */

function getTenantBranding(tenantId) {
  return db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenantId) || null;
}

/*
 * Cria ou atualiza a linha de branding da empresa. Os caminhos de logo e
 * favicon são sempre relativos a DATA_DIR (ex: assets/tenant_0001/logo.png).
 */
function upsertTenantBranding(tenantId, fields = {}) {
  const allowed = ['logo_path', 'favicon_path', 'primary_color', 'secondary_color', 'accent_color', 'browser_title'];
  const existing = getTenantBranding(tenantId);
  if (existing) {
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(fields[key] === null ? null : fields[key]);
      }
    }
    if (!sets.length) return existing;
    sets.push("updated_at = datetime('now', 'localtime')");
    params.push(tenantId);
    db.prepare(`UPDATE tenant_branding SET ${sets.join(', ')} WHERE tenant_id = ?`).run(...params);
    return getTenantBranding(tenantId);
  }
  db.prepare(
    `INSERT INTO tenant_branding (tenant_id, logo_path, favicon_path, primary_color, secondary_color, accent_color, browser_title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tenantId,
    fields.logo_path ?? null,
    fields.favicon_path ?? null,
    fields.primary_color ?? null,
    fields.secondary_color ?? null,
    fields.accent_color ?? null,
    fields.browser_title ?? null
  );
  return getTenantBranding(tenantId);
}

function deleteTenantBranding(tenantId) {
  db.prepare('DELETE FROM tenant_branding WHERE tenant_id = ?').run(tenantId);
  return true;
}

function updateTenantLogo(tenantId, assetPath) {
  return upsertTenantBranding(tenantId, { logo_path: assetPath || null });
}

function updateTenantFavicon(tenantId, assetPath) {
  return upsertTenantBranding(tenantId, { favicon_path: assetPath || null });
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
  deleteTenantRecord,
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
  setDomainValue,
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
  /* financeiro */
  listFinancialEntries,
  getFinancialEntry,
  insertFinancialEntry,
  updateFinancialEntry,
  deleteFinancialEntry,
  /* logs */
  logActivity,
  listLogs,
  /* identidade visual */
  getTenantBranding,
  upsertTenantBranding,
  deleteTenantBranding,
  updateTenantLogo,
  updateTenantFavicon
};
