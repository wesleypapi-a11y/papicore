'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { createTenantDatabase, closeTenantDatabase, deleteTenantDatabase, tenantFilePath } = require('../database/tenantDatabase');

const CORE_FILE = path.join(__dirname, '..', 'data', 'papi_core.db');
const SLUG = 'torque-detail';
const DATABASE_NAME = 'tenant_0001_torque_detail.db';
const DOMAIN = 'torquedetail.com.br';
const SEED_MARKER = 'SEED_TORQUE_DETAIL_V1';
const REQUIRED_TENANT_TABLES = ['appointments', 'blocked_schedules', 'company_settings', 'financial_entries', 'service_categories', 'service_modalities', 'services', 'units'];

function fail(message) { throw new Error(message); }
function productionGuard() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TORQUE_DETAIL_SEED !== 'true') {
    fail('Seed bloqueado em produção. Defina ALLOW_TORQUE_DETAIL_SEED=true apenas para esta execução.');
  }
}
function safeUser(user) {
  return user && { id: user.id, tenant_id: user.tenant_id, name: user.name, email: user.email, role: user.role, active: user.active };
}
function verify(db, tenant) {
  const domains = db.prepare('SELECT id,tenant_id,domain,is_primary,verified FROM tenant_domains WHERE tenant_id=? ORDER BY id').all(tenant.id);
  const owner = db.prepare("SELECT * FROM users WHERE tenant_id=? AND role='owner' AND active=1 ORDER BY id LIMIT 1").get(tenant.id);
  const dbPath = tenantFilePath(tenant.database_name);
  const result = { tenant, domains, owner: safeUser(owner), database_exists: fs.existsSync(dbPath), missing_tables: [], usable_for_login: false };
  if (result.database_exists) {
    const tenantDb = new Database(dbPath, { readonly: true });
    const tables = new Set(tenantDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    result.missing_tables = REQUIRED_TENANT_TABLES.filter((name) => !tables.has(name));
    tenantDb.close();
  }
  const primary = domains.find((domain) => domain.domain === DOMAIN && domain.is_primary && domain.verified);
  result.usable_for_login = Boolean(
    tenant.status === 'ACTIVE' && owner && owner.password_hash && /^\$2[aby]\$/.test(owner.password_hash) &&
    primary && result.database_exists && result.missing_tables.length === 0
  );
  return result;
}
function undo(db) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE slug=?').get(SLUG);
  if (!tenant) return { action: 'nothing_to_undo' };
  const marker = db.prepare('SELECT id FROM activity_logs WHERE tenant_id=? AND action=?').get(tenant.id, SEED_MARKER);
  if (!marker) fail('Desfazer recusado: o cadastro existente não foi criado por este comando.');
  const remove = db.transaction(() => db.prepare('DELETE FROM tenants WHERE id=?').run(tenant.id));
  remove();
  deleteTenantDatabase(tenant.database_name);
  return { action: 'undone', tenant_id: tenant.id };
}
function run() {
  productionGuard();
  if (!fs.existsSync(CORE_FILE)) fail('Banco central não encontrado. Inicie a aplicação ao menos uma vez.');
  const db = new Database(CORE_FILE);
  db.pragma('foreign_keys = ON');
  try {
    if (process.argv.includes('--undo')) return console.log(JSON.stringify(undo(db), null, 2));
    let tenant = db.prepare('SELECT * FROM tenants WHERE slug=? OR lower(name)=lower(?)').get(SLUG, 'Torque Detail');
    if (tenant) {
      const result = verify(db, tenant);
      if (!result.usable_for_login) fail(`Cadastro existente incompleto: ${JSON.stringify(result)}`);
      return console.log(JSON.stringify({ action: 'already_complete', ...result, local_domain: 'localhost (resolvido por DEFAULT_TENANT_SLUG em desenvolvimento)' }, null, 2));
    }
    if (db.prepare('SELECT COUNT(*) AS total FROM tenants').get().total !== 0) fail('Não é possível cadastrar como primeira empresa: já existem outros tenants.');
    const adminName = String(process.env.TORQUE_DETAIL_ADMIN_NAME || '').trim();
    const adminEmail = String(process.env.TORQUE_DETAIL_ADMIN_EMAIL || '').trim().toLowerCase();
    const adminPassword = String(process.env.TORQUE_DETAIL_ADMIN_PASSWORD || '');
    if (!adminName || !/^\S+@\S+\.\S+$/.test(adminEmail) || adminPassword.length < 8) {
      fail('Defina TORQUE_DETAIL_ADMIN_NAME, TORQUE_DETAIL_ADMIN_EMAIL e TORQUE_DETAIL_ADMIN_PASSWORD (mínimo 8 caracteres).');
    }
    if (db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) fail('O e-mail do administrador já pertence a outro usuário.');
    if (db.prepare('SELECT id FROM tenant_domains WHERE domain=?').get(DOMAIN)) fail('O domínio já pertence a outro tenant.');
    const configuredPlan = String(process.env.TORQUE_DETAIL_PLAN || '').trim().toUpperCase();
    const plan = configuredPlan
      ? db.prepare('SELECT * FROM plans WHERE slug=? AND active=1').get(configuredPlan)
      : db.prepare('SELECT * FROM plans WHERE active=1 ORDER BY id LIMIT 1').get();
    if (!plan) fail('Nenhum plano padrão ativo foi encontrado.');
    let createdFile = false;
    try {
      if (!fs.existsSync(tenantFilePath(DATABASE_NAME))) {
        createTenantDatabase(DATABASE_NAME, { companyName: 'Torque Detail', fullCatalog: true });
        createdFile = true;
      } else fail(`Arquivo ${DATABASE_NAME} já existe sem tenant correspondente; operação cancelada.`);
      tenant = db.transaction(() => {
        const info = db.prepare("INSERT INTO tenants (id,name,slug,database_name,plan,status) VALUES (1,?,?,?,?, 'ACTIVE')")
          .run('Torque Detail', SLUG, DATABASE_NAME, plan.slug);
        const tenantId = Number(info.lastInsertRowid);
        const userInfo = db.prepare("INSERT INTO users (tenant_id,name,email,password_hash,role,active) VALUES (?,?,?,?, 'owner',1)")
          .run(tenantId, adminName, adminEmail, bcrypt.hashSync(adminPassword, 12));
        db.prepare('INSERT INTO tenant_domains (tenant_id,domain,is_primary,verified) VALUES (?,?,1,1)').run(tenantId, DOMAIN);
        db.prepare('INSERT INTO activity_logs (user_id,user_name,tenant_id,action,details) VALUES (?,?,?,?,?)')
          .run(userInfo.lastInsertRowid, adminName, tenantId, SEED_MARKER, 'Primeiro tenant criado pelo seed controlado');
        return db.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId);
      })();
    } catch (error) {
      if (createdFile) deleteTenantDatabase(DATABASE_NAME);
      throw error;
    }
    console.log(JSON.stringify({ action: 'created', ...verify(db, tenant), local_domain: 'localhost (resolvido por DEFAULT_TENANT_SLUG em desenvolvimento)' }, null, 2));
  } finally { db.close(); }
}

try { run(); } catch (error) { console.error(`[seed:torque-detail] ${error.message}`); process.exitCode = 1; }
