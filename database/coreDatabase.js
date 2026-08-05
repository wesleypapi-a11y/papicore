/*
 * coreDatabase.js
 *
 * Banco central da plataforma "PapiCore": data/papi_core.db
 *
 * Este banco NÃO armazena agendamentos, clientes, serviços ou agenda de
 * nenhuma empresa. Ele controla apenas a plataforma:
 *
 *   - plans: planos disponíveis (valores em centavos, limite de unidades);
 *   - subscriptions: assinatura de cada empresa (plano, status, vencimentos);
 *   - tenants: empresas cadastradas (nome, slug, banco, status...);
 *   - users: usuários da plataforma (developer + usuários das empresas);
 *   - tenant_domains: domínios próprios de cada empresa;
 *   - activity_logs: trilha de auditoria do painel do desenvolvedor;
 *   - schema_migrations: controle de migrações idempotentes deste banco.
 *
 * Ao subir o servidor, este módulo também migra o banco legado
 * (data/app.db) para o banco da primeira empresa (tenant_0001_torque_detail.db),
 * preservando todos os dados existentes.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const { slugify, todayStr, toDateStr, addDays, parseCurrencyToCents } = require('../utils/helpers');
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

const SUBSCRIPTIONS_DDL = `
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  custom_monthly_price_cents INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  billing_day INTEGER,
  started_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  last_payment_at TEXT,
  next_due_date TEXT,
  suspended_at TEXT,
  canceled_at TEXT,
  notes TEXT,
  external_customer_id TEXT,
  external_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

const CORE_DDL = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  monthly_price_cents INTEGER NOT NULL DEFAULT 0,
  max_units INTEGER,
  support_level TEXT NOT NULL DEFAULT 'standard',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

${SUBSCRIPTIONS_DDL}

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

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER,
  backup_type TEXT NOT NULL,
  status TEXT NOT NULL,
  filename TEXT,
  relative_path TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  database_count INTEGER DEFAULT 0,
  asset_file_count INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

/* Modo de manutenção por empresa (usado durante restaurações). Idempotente. */
const MAINTENANCE_DDL = `
CREATE TABLE IF NOT EXISTS tenant_maintenance (
  tenant_id INTEGER PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  started_at TEXT,
  updated_at TEXT,
  started_by_user_id INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
`;

/* Histórico de restaurações por empresa. Nunca guarda senha, token ou
   caminho absoluto — apenas referências e status sanitizados. */
const RESTORE_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS restore_runs (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  backup_id TEXT NOT NULL,
  pre_restore_backup_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  started_by_user_id INTEGER,
  error_message TEXT,
  rollback_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (backup_id) REFERENCES backup_runs(id),
  FOREIGN KEY (pre_restore_backup_id) REFERENCES backup_runs(id)
);
`;

/* Conteúdo editável do site institucional (papicore.com.br): vídeo
   demonstrativo e dados de contato comercial. Linha única (id = 1). As
   imagens (mockup do hero + galeria de demonstração) NÃO ficam aqui — são
   arquivos em disco geridos por utils/assetStorage.js (platformAssetsDir),
   o mesmo mecanismo já usado para a logo/favicon da tela de login. */
const SITE_CONTENT_DDL = `
CREATE TABLE IF NOT EXISTS site_content (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  demo_video_url TEXT,
  contact_whatsapp TEXT,
  contact_email TEXT,
  contact_instagram TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

/* Leads comerciais captados pelo site institucional (papicore.com.br). Nunca
   pertencem a um tenant — vivem só no banco central e são visíveis apenas no
   Painel do Desenvolvedor (rota GET /api/developer/leads). */
const COMMERCIAL_LEADS_DDL = `
CREATE TABLE IF NOT EXISTS commercial_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_name TEXT,
  whatsapp TEXT NOT NULL,
  city TEXT,
  units_count INTEGER,
  interested_plan TEXT,
  message TEXT,
  source TEXT NOT NULL DEFAULT 'website',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

/* Planos iniciais da plataforma. Os valores ficam fixos aqui (migration/seed)
   e NÃO são duplicados no front-end: depois da primeira criação, o painel do
   desenvolvedor pode alterar preço, limite e status. max_units = null
   significa unidades ilimitadas. */
const SEED_PLANS = [
  { name: 'Starter', slug: 'STARTER', monthly_price_cents: 9900, max_units: 1, support_level: 'standard', display_order: 1, is_active: 1, description: 'Para quem está começando: 1 unidade e suporte padrão.' },
  { name: 'Pro', slug: 'PRO', monthly_price_cents: 14900, max_units: null, support_level: 'priority', display_order: 2, is_active: 1, description: 'Unidades ilimitadas e suporte prioritário.' },
  { name: 'Enterprise', slug: 'ENTERPRISE', monthly_price_cents: 19900, max_units: null, support_level: 'premium', display_order: 3, is_active: 1, description: 'Unidades ilimitadas, suporte premium e acesso aos futuros upgrades sem custo.' }
];

let db = null;

function getCoreDb() {
  if (!db) initCore();
  return db;
}

/* Migração idempotente: adiciona colunas novas em bancos já existentes sem
   recriar a tabela nem afetar dados de nenhum tenant. */
function ensureColumn(table, column, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function migrateBrandingThemeColumns() {
  ensureColumn('tenant_branding', 'theme_key', 'TEXT');
  ensureColumn('tenant_branding', 'background_color', 'TEXT');
  ensureColumn('tenant_branding', 'surface_color', 'TEXT');
  ensureColumn('tenant_branding', 'text_color', 'TEXT');
  ensureColumn('tenant_branding', 'muted_color', 'TEXT');
  ensureColumn('tenant_branding', 'border_color', 'TEXT');
  ensureColumn('tenant_branding', 'success_color', 'TEXT');
  ensureColumn('tenant_branding', 'danger_color', 'TEXT');
}

function openCore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(CORE_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CORE_DDL);
  db.exec(MAINTENANCE_DDL);
  db.exec(RESTORE_RUNS_DDL);
  db.exec(COMMERCIAL_LEADS_DDL);
  db.exec(SITE_CONTENT_DDL);
  migrateBrandingThemeColumns();
  runMigrations();
}

function seedCore() {
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
       VALUES ('Torque Detail', 'torque-detail', 'tenant_0001_torque_detail.db', '', ?, ?, 'STARTER', 'ACTIVE')`
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
    ensureSubscriptionForTenant(tenantId, 'STARTER');
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
      fullCatalog: true,
      createDefaultUnit: true
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

/* ---------- Migrações versionadas ---------- */

function migrationApplied(name) {
  return !!db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name);
}

function markMigrationApplied(name) {
  db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
}

/* v1 — planos legados (monthly_price REAL, appointment_limit, features,
   slugs maiúsculos) para o schema atual: valores em centavos inteiros,
   limite de unidades, suporte, ordem e status. Os planos já existentes são
   convertidos (preservando id/uso), os demais planos iniciais são criados.
   Depois desta migração, "tenants.plan" continua sendo um espelho em texto
   do slug do plano (usado pelo tenantMiddleware e pelo painel), mas a fonte
   da verdade do preço/limite passa a ser "plans" + "subscriptions". */
function migratePlansV1() {
  const tx = db.transaction(() => {
    const hasOld = db.prepare(
      "SELECT 1 FROM pragma_table_info('plans') WHERE name = 'monthly_price'"
    ).get();

    if (hasOld) {
      db.prepare('DROP TABLE IF EXISTS plans_v1_old').run();
      /* legacy_alter_table evita que o RENAME atualize as FKs que apontam
         para a tabela (ex.: subscriptions.plan_id), o que quebraria a
         referência ao apagar a tabela antiga. Assim as FKs continuam
         apontando para o nome "plans" (a nova tabela). */
      db.pragma('legacy_alter_table = ON');
      db.prepare('ALTER TABLE plans RENAME TO plans_v1_old').run();
      db.pragma('legacy_alter_table = OFF');
      db.exec(`
        CREATE TABLE plans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT,
          monthly_price_cents INTEGER NOT NULL DEFAULT 0,
          max_units INTEGER,
          support_level TEXT NOT NULL DEFAULT 'standard',
          display_order INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
      `);
      db.prepare(
        `INSERT INTO plans (id, name, slug, description, monthly_price_cents, max_units, support_level, display_order, is_active, created_at, updated_at)
         SELECT id, name, slug, NULL, CAST(ROUND(monthly_price * 100) AS INTEGER), appointment_limit, 'standard', 0, active, created_at, updated_at
         FROM plans_v1_old`
      ).run();
      /* O "appointment_limit" legado era agendamentos/mês, não unidades.
         Para os planos básicos isso faria o tenant ter dezenas de unidades,
         então corrigimos para 1 unidade (sem tocar em preços). */
      db.prepare(
        "UPDATE plans SET max_units = 1, updated_at = datetime('now', 'localtime') WHERE slug IN ('FREE', 'STARTER')"
      ).run();
      db.prepare('DROP TABLE plans_v1_old').run();
    }

    const insertOrIgnore = db.prepare(
      `INSERT OR IGNORE INTO plans (name, slug, description, monthly_price_cents, max_units, support_level, display_order, is_active)
       VALUES (@name, @slug, @description, @monthly_price_cents, @max_units, @support_level, @display_order, @is_active)`
    );
    for (const p of SEED_PLANS) {
      insertOrIgnore.run(p);
    }
  });
  tx();
}

/* v2 — assinaturas: uma por empresa, espelhando o plano atual do tenant.
   Empresas que ainda não têm assinatura recebem um registro "active"
   apontando para o plano (pelo slug: STARTER, PRO, ENTERPRISE;
   desconhecido/ausente cai no primeiro plano ativo). Roda uma única vez;
   depois disso as assinaturas só mudam pelo painel do desenvolvedor. */
function migrateSubscriptionsV2() {
  /* Repara instalações que rodaram a primeira versão desta migração: o
     rebuild de "plans" (RENAME + DROP) deixou a FK de subscriptions
     apontando para "plans_v1_old", uma tabela que não existe mais. Como
     essas linhas nunca conseguiram ser gravadas, recriar a tabela é seguro
     e restaura a FK para "plans". */
  const fkTargets = db.prepare('PRAGMA foreign_key_list(subscriptions)').all().map((f) => f.table);
  if (!fkTargets.includes('plans')) {
    db.prepare('DROP TABLE IF EXISTS subscriptions').run();
    db.exec(SUBSCRIPTIONS_DDL);
  }

  const seed = (() => {
    const plans = db.prepare('SELECT * FROM plans ORDER BY display_order ASC, id ASC').all();
    const active = plans.filter((p) => p.is_active);
    return (slug) => {
      const upper = String(slug || '').toUpperCase();
      const found = plans.find((p) => p.slug.toUpperCase() === upper) || active[0];
      return found || plans[0];
    };
  })();

  const tx = db.transaction(() => {
    const tenants = db.prepare('SELECT id, plan FROM tenants').all();
    const upsert = db.prepare(`
      INSERT INTO subscriptions (tenant_id, plan_id, status, started_at, current_period_start, current_period_end, next_due_date, created_at, updated_at)
      VALUES (@tenant_id, @plan_id, 'active', @started_at, @current_period_start, @current_period_end, @next_due_date, @started_at, @started_at)
      ON CONFLICT(tenant_id) DO UPDATE SET
        plan_id = excluded.plan_id,
        updated_at = datetime('now', 'localtime')
    `);
    const today = todayStr();
    const periodEnd = toDateStr(addDays(new Date(), 30));
    for (const t of tenants) {
      const plan = seed(t.plan);
      upsert.run({
        tenant_id: t.id,
        plan_id: plan.id,
        started_at: today,
        current_period_start: today,
        current_period_end: periodEnd,
        next_due_date: periodEnd
      });
    }
  });
  tx();
}

/* v3 — colunas de integração de pagamento reservadas (gateway futuro).
   Idempotente: roda a cada boot para bancos criados antes destas colunas. */
function migrateSubscriptionsV3() {
  ensureColumn('subscriptions', 'external_customer_id', 'TEXT');
  ensureColumn('subscriptions', 'external_subscription_id', 'TEXT');
}

function runMigrations() {
  if (!migrationApplied('plans_v1')) {
    migratePlansV1();
    markMigrationApplied('plans_v1');
  }
  if (!migrationApplied('subscriptions_v2')) {
    migrateSubscriptionsV2();
    markMigrationApplied('subscriptions_v2');
  }
  if (!migrationApplied('subscriptions_v3')) {
    migrateSubscriptionsV3();
    markMigrationApplied('subscriptions_v3');
  }
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

/*
 * Cria tenant + usuário (owner) + domínio principal de forma atômica no
 * banco central. Se qualquer insert falhar, nada fica gravado (rollback).
 * O tenant é inserido primeiro; o usuário herda tenant_id do tenant criado.
 */
function createTenantBundle({ tenant, user, domain }) {
  const tx = db.transaction(() => {
    const t = insertTenant(tenant);
    const u = insertUser({ ...user, tenant_id: t.id });
    let d = null;
    if (domain) d = insertDomain(t.id, domain, true);
    ensureSubscriptionForTenant(t.id, tenant.plan);
    return { tenant: t, user: u, domain: d };
  });
  return tx();
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
 * Normaliza um host: remove protocolo, porta, path e o prefixo "www", e
 * converte para minúsculas.
 * Ex.: "WWW.TorqueDetail.com.br:8080/admin" -> "torquedetail.com.br"
 */
function normalizeDomain(host) {
  let h = String(host || '').trim();
  if (h.includes('://')) h = h.split('://')[1];
  h = h.split('/')[0];
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
  return db.prepare('SELECT * FROM plans ORDER BY display_order ASC, id ASC').all();
}

function getPlan(slugOrId) {
  return db.prepare('SELECT * FROM plans WHERE slug = ? OR id = ?').get(slugOrId, slugOrId);
}

function getPlanById(id) {
  return db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
}

function getPlanBySlug(slug) {
  return db.prepare('SELECT * FROM plans WHERE slug = ?').get(slug);
}

function insertPlan(data) {
  const info = db.prepare(
    `INSERT INTO plans (name, slug, description, monthly_price_cents, max_units, support_level, display_order, is_active)
     VALUES (@name, @slug, @description, @monthly_price_cents, @max_units, @support_level, @display_order, @is_active)`
  ).run({
    name: data.name,
    slug: String(data.slug || slugify(data.name)),
    description: data.description || null,
    monthly_price_cents: Number(data.monthly_price_cents) || 0,
    max_units: data.max_units === null || data.max_units === undefined ? null : Number(data.max_units),
    support_level: data.support_level || 'standard',
    display_order: Number(data.display_order) || 0,
    is_active: data.is_active === undefined || data.is_active === null ? 1 : (data.is_active ? 1 : 0)
  });
  return getPlanById(info.lastInsertRowid);
}

function updatePlan(id, fields) {
  const allowed = ['name', 'slug', 'description', 'monthly_price_cents', 'max_units', 'support_level', 'display_order', 'is_active'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(key === 'is_active' ? (fields[key] ? 1 : 0) : fields[key]);
    }
  }
  if (!sets.length) return getPlanById(id);
  sets.push("updated_at = datetime('now', 'localtime')");
  params.push(id);
  db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getPlanById(id);
}

/* Reordena os planos conforme a lista de ids (display_order = posição + 1). */
function reorderPlans(orderedIds) {
  const tx = db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.prepare('UPDATE plans SET display_order = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(index + 1, id);
    });
  });
  tx();
  return listPlans();
}

/* Planos em uso não podem ser apagados: o banco mantém assinaturas apontando
   para eles. A exclusão é feita via is_active = 0 (inativação) ou, no caso de
   planos sem assinatura, exclusão física. */
function deletePlan(id) {
  const used = db.prepare('SELECT COUNT(*) AS total FROM subscriptions WHERE plan_id = ?').get(id).total;
  if (used > 0) return { deleted: false, inUse: true };
  db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return { deleted: true, inUse: false };
}

/* ---------- Assinaturas ---------- */

function listSubscriptions() {
  return db.prepare(
    `SELECT s.*, t.name AS tenant_name, t.slug AS tenant_slug, p.name AS plan_name, p.slug AS plan_slug,
            p.monthly_price_cents AS plan_monthly_price_cents, p.max_units AS plan_max_units,
            p.support_level AS plan_support_level
     FROM subscriptions s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN plans p ON p.id = s.plan_id
     ORDER BY t.id ASC`
  ).all();
}

function getSubscriptionByTenantId(tenantId) {
  return db.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').get(tenantId) || null;
}

function getSubscriptionById(id) {
  return db.prepare(
    `SELECT s.*, t.name AS tenant_name, t.slug AS tenant_slug, p.name AS plan_name, p.slug AS plan_slug,
            p.monthly_price_cents AS plan_monthly_price_cents, p.max_units AS plan_max_units,
            p.support_level AS plan_support_level
     FROM subscriptions s
     JOIN tenants t ON t.id = s.tenant_id
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE s.id = ?`
  ).get(id) || null;
}

function upsertSubscription(tenantId, data) {
  const existing = getSubscriptionByTenantId(tenantId);
  const values = {
    tenant_id: tenantId,
    plan_id: data.plan_id,
    custom_monthly_price_cents: data.custom_monthly_price_cents ?? null,
    status: data.status || 'active',
    billing_day: data.billing_day ?? null,
    started_at: data.started_at ?? null,
    current_period_start: data.current_period_start ?? null,
    current_period_end: data.current_period_end ?? null,
    last_payment_at: data.last_payment_at ?? null,
    next_due_date: data.next_due_date ?? null,
    suspended_at: data.suspended_at ?? null,
    canceled_at: data.canceled_at ?? null,
    notes: data.notes ?? null,
    external_customer_id: data.external_customer_id ?? null,
    external_subscription_id: data.external_subscription_id ?? null
  };
  if (existing) {
    const sets = Object.keys(values).map((key) => `${key} = @${key}`);
    db.prepare(
      `UPDATE subscriptions SET ${sets.join(', ')}, updated_at = datetime('now', 'localtime') WHERE tenant_id = @tenant_id`
    ).run(values);
  } else {
    const columns = Object.keys(values);
    db.prepare(
      `INSERT INTO subscriptions (${columns.join(', ')})
       VALUES (${columns.map((key) => `@${key}`).join(', ')})`
    ).run(values);
  }
  return getSubscriptionByTenantId(tenantId);
}

function updateSubscriptionById(id, fields) {
  const allowed = [
    'plan_id', 'custom_monthly_price_cents', 'status', 'billing_day',
    'started_at', 'current_period_start', 'current_period_end',
    'last_payment_at', 'next_due_date', 'suspended_at', 'canceled_at',
    'notes', 'external_customer_id', 'external_subscription_id'
  ];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return getSubscriptionById(id);
  sets.push("updated_at = datetime('now', 'localtime')");
  params.push(id);
  db.prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getSubscriptionById(id);
}

function deleteSubscription(tenantId) {
  db.prepare('DELETE FROM subscriptions WHERE tenant_id = ?').run(tenantId);
  return true;
}

/*
 * Garante que a empresa tenha assinatura. Usada na criação de empresa e nos
 * seeds: se já existe, não mexe; se não existe, cria "active" apontando para
 * o plano pelo slug (com fallback para o primeiro plano ativo).
 */
function ensureSubscriptionForTenant(tenantId, planSlug) {
  const existing = getSubscriptionByTenantId(tenantId);
  if (existing) return existing;
  const plan =
    getPlanBySlug(planSlug) ||
    db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY display_order ASC, id ASC LIMIT 1').get();
  if (!plan) return null;
  const today = todayStr();
  const periodEnd = toDateStr(addDays(new Date(), 30));
  return upsertSubscription(tenantId, {
    plan_id: plan.id,
    status: 'active',
    started_at: today,
    current_period_start: today,
    current_period_end: periodEnd,
    next_due_date: periodEnd
  });
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

/* ---------- Backups ---------- */

const BACKUP_RUN_FIELDS = [
  'tenant_id', 'backup_type', 'status', 'filename', 'relative_path',
  'size_bytes', 'sha256', 'database_count', 'asset_file_count',
  'started_at', 'completed_at', 'error_message', 'created_by_user_id'
];

function insertBackupRun(data) {
  db.prepare(
    `INSERT INTO backup_runs
       (id, tenant_id, backup_type, status, filename, relative_path, size_bytes,
        sha256, database_count, asset_file_count, started_at, completed_at,
        error_message, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.id,
    data.tenant_id ?? null,
    data.backup_type,
    data.status || 'RUNNING',
    data.filename || null,
    data.relative_path || null,
    data.size_bytes ?? null,
    data.sha256 || null,
    data.database_count ?? 0,
    data.asset_file_count ?? 0,
    data.started_at,
    data.completed_at || null,
    data.error_message || null,
    data.created_by_user_id ?? null
  );
  return getBackupRun(data.id);
}

function updateBackupRun(id, fields) {
  const sets = [];
  const params = [];
  for (const key of BACKUP_RUN_FIELDS) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return getBackupRun(id);
  params.push(id);
  db.prepare(`UPDATE backup_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getBackupRun(id);
}

function getBackupRun(id) {
  return db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id);
}

function listBackupRuns(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.tenant_id) { clauses.push('tenant_id = ?'); params.push(filters.tenant_id); }
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  if (filters.backup_type) { clauses.push('backup_type = ?'); params.push(filters.backup_type); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM backup_runs ${where} ORDER BY started_at DESC, id DESC`
  ).all(...params);
}

function deleteBackupRun(id) {
  db.prepare('DELETE FROM backup_runs WHERE id = ?').run(id);
  return true;
}

/* ---------- Modo de manutenção por tenant ---------- */

/* Cache em memória (cache-aside) para não consultar o banco central a cada
   requisição pública. Invalidado em setTenantMaintenance. */
const maintenanceCache = new Map();

function getTenantMaintenance(tenantId) {
  const key = Number(tenantId);
  if (maintenanceCache.has(key)) return maintenanceCache.get(key);
  const row = db.prepare('SELECT * FROM tenant_maintenance WHERE tenant_id = ?').get(key) || null;
  maintenanceCache.set(key, row);
  return row;
}

function isTenantInMaintenance(tenantId) {
  const row = getTenantMaintenance(tenantId);
  return Boolean(row && Number(row.active) === 1);
}

/*
 * Liga/desliga o modo de manutenção de uma empresa. Grava no banco central e
 * sincroniza o cache em memória. Idempotente: repetir o mesmo estado não
 * gera erro.
 */
function setTenantMaintenance(tenantId, { active, reason, started_by_user_id } = {}) {
  const key = Number(tenantId);
  const now = new Date().toISOString();
  const value = active ? 1 : 0;
  const existing = db.prepare('SELECT * FROM tenant_maintenance WHERE tenant_id = ?').get(key);
  if (existing) {
    db.prepare(
      `UPDATE tenant_maintenance SET active = ?, reason = COALESCE(?, reason), updated_at = ?,
         started_at = CASE WHEN ? = 1 AND started_at IS NULL THEN ? ELSE started_at END,
         started_by_user_id = COALESCE(?, started_by_user_id)
       WHERE tenant_id = ?`
    ).run(value, reason || null, now, value, now, started_by_user_id ?? null, key);
  } else {
    db.prepare(
      `INSERT INTO tenant_maintenance (tenant_id, active, reason, started_at, updated_at, started_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(key, value, reason || null, value ? now : null, now, started_by_user_id ?? null);
  }
  const row = db.prepare('SELECT * FROM tenant_maintenance WHERE tenant_id = ?').get(key) || null;
  maintenanceCache.set(key, row);
  return row;
}

function clearMaintenanceCache() {
  maintenanceCache.clear();
}

/* ---------- Restaurações ---------- */

const RESTORE_RUN_FIELDS = [
  'tenant_id', 'backup_id', 'pre_restore_backup_id', 'status',
  'started_at', 'completed_at', 'started_by_user_id',
  'error_message', 'rollback_status'
];

function insertRestoreRun(data) {
  db.prepare(
    `INSERT INTO restore_runs
       (id, tenant_id, backup_id, pre_restore_backup_id, status, started_at,
        completed_at, started_by_user_id, error_message, rollback_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.id,
    data.tenant_id,
    data.backup_id,
    data.pre_restore_backup_id || null,
    data.status || 'RUNNING',
    data.started_at,
    data.completed_at || null,
    data.started_by_user_id ?? null,
    data.error_message || null,
    data.rollback_status || null
  );
  return getRestoreRun(data.id);
}

function updateRestoreRun(id, fields) {
  const sets = [];
  const params = [];
  for (const key of RESTORE_RUN_FIELDS) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return getRestoreRun(id);
  params.push(id);
  db.prepare(`UPDATE restore_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getRestoreRun(id);
}

function getRestoreRun(id) {
  return db.prepare('SELECT * FROM restore_runs WHERE id = ?').get(id);
}

function listRestoreRuns(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.tenant_id) { clauses.push('tenant_id = ?'); params.push(Number(filters.tenant_id)); }
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM restore_runs ${where} ORDER BY started_at DESC, id DESC`
  ).all(...params);
}

/* ---------- Leads comerciais ---------- */

function insertLead(data) {
  const info = db.prepare(
    `INSERT INTO commercial_leads
       (name, company_name, whatsapp, city, units_count, interested_plan, message, source, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  ).run(
    data.name,
    data.company_name || null,
    data.whatsapp,
    data.city || null,
    data.units_count ?? null,
    data.interested_plan || null,
    data.message || null,
    data.source || 'website'
  );
  return getLeadById(info.lastInsertRowid);
}

function getLeadById(id) {
  return db.prepare('SELECT * FROM commercial_leads WHERE id = ?').get(id);
}

function listLeads(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.status) { clauses.push('status = ?'); params.push(filters.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM commercial_leads ${where} ORDER BY id DESC`).all(...params);
}

/* Lead mais recente do mesmo WhatsApp nos últimos "windowSeconds" segundos.
   Usada para evitar registrar duplicidade em clique duplo/reenvio do
   formulário de contato. Janela calculada no próprio SQLite (mesmo fuso e
   formato de created_at) para nunca divergir do valor gravado no insert. */
function findRecentLeadByWhatsapp(whatsapp, windowSeconds) {
  return db.prepare(
    `SELECT * FROM commercial_leads
     WHERE whatsapp = ? AND created_at >= datetime('now', 'localtime', ? || ' seconds')
     ORDER BY id DESC LIMIT 1`
  ).get(whatsapp, -Math.abs(windowSeconds));
}

function updateLeadStatus(id, status) {
  const existing = getLeadById(id);
  if (!existing) return null;
  db.prepare(
    "UPDATE commercial_leads SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(status, id);
  return getLeadById(id);
}

/* ---------- Conteúdo do site institucional ---------- */

function getSiteContent() {
  return db.prepare('SELECT * FROM site_content WHERE id = 1').get() || {
    id: 1, demo_video_url: null, contact_whatsapp: null, contact_email: null, contact_instagram: null, updated_at: null
  };
}

const SITE_CONTENT_FIELDS = ['demo_video_url', 'contact_whatsapp', 'contact_email', 'contact_instagram'];

function upsertSiteContent(fields = {}) {
  const values = { id: 1 };
  for (const key of SITE_CONTENT_FIELDS) values[key] = fields[key] !== undefined ? fields[key] : null;
  const existing = db.prepare('SELECT 1 FROM site_content WHERE id = 1').get();
  if (existing) {
    const sets = SITE_CONTENT_FIELDS.map((key) => `${key} = @${key}`);
    db.prepare(`UPDATE site_content SET ${sets.join(', ')}, updated_at = datetime('now', 'localtime') WHERE id = 1`).run(values);
  } else {
    const columns = ['id', ...SITE_CONTENT_FIELDS];
    db.prepare(`INSERT INTO site_content (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`).run(values);
  }
  return getSiteContent();
}

/* ---------- Identidade visual ---------- */

function getTenantBranding(tenantId) {
  return db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenantId) || null;
}

/*
 * Cria ou atualiza a linha de branding da empresa. Os caminhos de logo e
 * favicon são sempre relativos a DATA_DIR (ex: assets/tenant_0001/logo.png).
 */
const BRANDING_FIELDS = [
  'logo_path', 'favicon_path', 'browser_title', 'theme_key',
  'primary_color', 'secondary_color', 'accent_color',
  'background_color', 'surface_color', 'text_color', 'muted_color',
  'border_color', 'success_color', 'danger_color'
];

function upsertTenantBranding(tenantId, fields = {}) {
  const existing = getTenantBranding(tenantId);
  if (existing) {
    const sets = [];
    const params = [];
    for (const key of BRANDING_FIELDS) {
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
  const columns = ['tenant_id', ...BRANDING_FIELDS];
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO tenant_branding (${columns.join(', ')}) VALUES (${placeholders})`).run(
    tenantId,
    ...BRANDING_FIELDS.map((key) => fields[key] ?? null)
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

function countTenantUnits(databaseName) {
  try {
    const tenantDb = openTenantDatabase(databaseName);
    const row = tenantDb.prepare('SELECT COUNT(*) AS total FROM units').get();
    return row ? row.total : 0;
  } catch (err) {
    console.error('[papi-core] Falha ao contar unidades de', databaseName, err.message);
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
  createTenantBundle,
  updateTenant,
  setTenantStatus,
  deleteTenant,
  deleteTenantRecord,
  nextTenantId,
  countTenantAppointments,
  countTenantUnits,
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
  getPlanById,
  getPlanBySlug,
  insertPlan,
  updatePlan,
  reorderPlans,
  deletePlan,
  /* assinaturas */
  listSubscriptions,
  getSubscriptionByTenantId,
  getSubscriptionById,
  upsertSubscription,
  updateSubscriptionById,
  deleteSubscription,
  ensureSubscriptionForTenant,
  /* financeiro */
  listFinancialEntries,
  getFinancialEntry,
  insertFinancialEntry,
  updateFinancialEntry,
  deleteFinancialEntry,
  /* logs */
  logActivity,
  listLogs,
  /* backups */
  insertBackupRun,
  updateBackupRun,
  getBackupRun,
  listBackupRuns,
  deleteBackupRun,
  /* manutenção por tenant */
  getTenantMaintenance,
  isTenantInMaintenance,
  setTenantMaintenance,
  clearMaintenanceCache,
  /* restaurações */
  insertRestoreRun,
  updateRestoreRun,
  getRestoreRun,
  listRestoreRuns,
  /* leads comerciais */
  insertLead,
  getLeadById,
  listLeads,
  findRecentLeadByWhatsapp,
  updateLeadStatus,
  /* conteúdo do site institucional */
  getSiteContent,
  upsertSiteContent,
  /* identidade visual */
  getTenantBranding,
  upsertTenantBranding,
  deleteTenantBranding,
  updateTenantLogo,
  updateTenantFavicon
};
