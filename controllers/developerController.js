/*
 * developerController.js
 *
 * Controladores do painel exclusivo do desenvolvedor ("PapiCore"),
 * acessível somente por usuários com role = developer.
 *
 * Gerencia toda a plataforma: empresas (tenants), domínios, usuários, planos,
 * logs, backups e impersonação. Usa o banco central (papi_core.db).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const {
  getCoreDb,
  listTenants,
  getTenantById,
  getTenantBySlug,
  insertTenant,
  createTenantBundle,
  updateTenant,
  setTenantStatus,
  deleteTenant,
  nextTenantId,
  countTenantAppointments,
  listDomains,
  getDomainById,
  getDomainRow,
  insertDomain,
  setDomainPrimary,
  setDomainVerified,
  setDomainValue,
  updateDomain,
  deleteDomain,
  listUsers,
  listUsersByTenant,
  getUserByEmail,
  getUserById,
  insertUser,
  updateUser,
  setUserActive,
  setUserPassword,
  deleteUser,
  getTenantOwner,
  listPlans,
  insertPlan,
  updatePlan,
  deletePlan,
  listFinancialEntries,
  getFinancialEntry,
  insertFinancialEntry,
  updateFinancialEntry,
  deleteFinancialEntry,
  listLogs,
  logActivity,
  normalizeDomain
} = require('../database/coreDatabase');
const { buildDatabaseName, tenantDatabaseExists } = require('../database/createTenantDatabase');
const { createTenantDatabase } = require('../database/tenantDatabase');
const { deleteTenantDatabase } = require('../database/tenantDatabase');
const { AppError, isValidEmail, isValidPhone, todayStr, slugify } = require('../utils/helpers');
const { signToken } = require('./authController');

const VALID_STATUSES = ['ACTIVE', 'SUSPENDED', 'TRIAL', 'ARCHIVED'];
const BACKUPS_DIR = path.join(__dirname, '..', 'data', 'backups');

function auditDetails(req, message) {
  return JSON.stringify({ message, ip: req.ip || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) });
}

function parseFeatures(value) {
  if (Array.isArray(value)) return value.map((i) => String(i).trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore */ }
    return value.split('\n').map((i) => i.trim()).filter(Boolean);
  }
  return [];
}

function pluckTenant(t, extra = {}) {
  return { ...t, ...extra };
}

/* Registra log sem nunca derrubar uma operação que já deu certo. */
function safeLog(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[papi-core] Falha ao registrar log de auditoria:', err.message);
  }
}

/*
 * Traduz falhas de integridade do banco central (ex.: UNIQUE) para mensagens
 * claras, sem expor detalhes internos. Usado como rede de segurança após as
 * pré-verificações do createTenant.
 */
function mapCreateTenantError(err) {
  if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    const msg = String(err.message || '');
    if (msg.includes('users.email')) return new AppError(409, 'Este e-mail já está cadastrado na plataforma.');
    if (msg.includes('tenants.slug')) return new AppError(409, 'Este slug já está cadastrado.');
    if (msg.includes('tenant_domains.domain')) return new AppError(409, 'Este domínio já está cadastrado.');
    return new AppError(409, 'Conflito ao cadastrar a empresa. Verifique os dados.');
  }
  if (err instanceof AppError) return err;
  return new AppError(500, 'Não foi possível criar a empresa.');
}

/* ---------- Autenticação ---------- */

function login(req, res) {
  const { email, password } = req.body || {};

  if (!isValidEmail(email) || !password) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const user = getUserByEmail(String(email).trim().toLowerCase());
  if (!user || user.role !== 'developer') {
    logActivity(null, null, 'DEVELOPER_LOGIN_FAILED', auditDetails(req, 'Credenciais invalidas'));
    throw new AppError(401, 'Acesso restrito ao desenvolvedor da plataforma.');
  }
  if (!user.active) {
    throw new AppError(401, 'Usuário inativo.');
  }
  const ok = bcrypt.compareSync(String(password), user.password_hash);
  if (!ok) {
    logActivity(user.id, null, 'DEVELOPER_LOGIN_FAILED', auditDetails(req, 'Credenciais invalidas'));
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const token = signToken(user);
  logActivity(user.id, null, 'DEVELOPER_LOGIN', auditDetails(req, 'Login realizado'));
  return res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, tenant_id: user.tenant_id }
  });
}

function me(req, res) {
  const user = getUserById(req.user.id);
  if (!user) throw new AppError(401, 'Usuário não encontrado.');
  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    created_at: user.created_at
  });
}

function changePassword(req, res) {
  const { current_password, new_password } = req.body || {};
  const user = getUserById(req.user.id);
  if (!user) throw new AppError(404, 'Usuário não encontrado.');

  if (!current_password || !bcrypt.compareSync(String(current_password), user.password_hash)) {
    throw new AppError(400, 'Senha atual incorreta.');
  }
  if (!new_password || String(new_password).length < 6) {
    throw new AppError(400, 'A nova senha deve ter pelo menos 6 caracteres.');
  }

  setUserPassword(user.id, bcrypt.hashSync(String(new_password), 10));
  logActivity(user.id, null, 'DEVELOPER_PASSWORD_CHANGED', 'Senha do desenvolvedor alterada');
  return res.json({ success: true });
}

/* ---------- Dashboard ---------- */

function dashboard(req, res) {
  const tenants = listTenants();
  const users = listUsers();
  const active = tenants.filter((t) => t.status === 'ACTIVE').length;
  const suspended = tenants.filter((t) => t.status === 'SUSPENDED').length;
  const expired = tenants.filter((t) => require('../database/coreDatabase').isTenantExpired(t)).length;
  const developers = users.filter((u) => u.role === 'developer').length;
  const companyUsers = users.filter((u) => u.role !== 'developer').length;

  let domains = 0;
  let appointments = 0;
  for (const t of tenants) {
    domains += listDomains(t.id).length;
    appointments += countTenantAppointments(t.database_name);
  }

  const recentLogs = listLogs(10);
  return res.json({
    tenants: tenants.length,
    active,
    suspended,
    expired,
    developers,
    company_users: companyUsers,
    domains,
    appointments,
    plans: listPlans().length,
    tenant_databases: tenants.filter((t) => tenantDatabaseExists(t.database_name)).length,
    recent_tenants: tenants.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5),
    recent_logs: recentLogs
  });
}

/* ---------- Empresas ---------- */

function tenantWithStats(t) {
  const owner = getTenantOwner(t.id);
  return pluckTenant(t, {
    admin: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
    user_count: require('../database/coreDatabase').countTenantUsers(t.id),
    appointment_count: countTenantAppointments(t.database_name),
    domains: listDomains(t.id)
  });
}

function listTenantsHandler(req, res) {
  const tenants = listTenants().map(tenantWithStats);
  return res.json(tenants);
}

function getTenantHandler(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  return res.json(tenantWithStats(tenant));
}

function validateTenantInput(body, { existing } = {}) {
  const {
    name,
    slug,
    document,
    email,
    phone,
    plan,
    status,
    expires_at,
    adminName,
    adminEmail,
    adminPassword,
    confirmPassword,
    domain
  } = body || {};

  if (name !== undefined && String(name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome da empresa.');
  }

  let finalSlug = slug;
  if (slug !== undefined) {
    finalSlug = slugify(slug || (name || '')) || slugify(existing ? existing.name : '');
    if (!finalSlug) throw new AppError(400, 'Informe o slug da empresa.');
    const dup = getTenantBySlug(finalSlug);
    if (dup && (!existing || dup.id !== existing.id)) {
      throw new AppError(409, 'Este slug já está cadastrado.');
    }
  }

  if (email !== undefined && email && !isValidEmail(email)) {
    throw new AppError(400, 'E-mail comercial inválido.');
  }
  if (phone !== undefined && phone && !isValidPhone(phone)) {
    throw new AppError(400, 'Telefone inválido.');
  }
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    throw new AppError(400, 'Status inválido (use ACTIVE, SUSPENDED ou TRIAL).');
  }
  if (expires_at !== undefined && expires_at) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires_at)) throw new AppError(400, 'Data de vencimento inválida.');
  }
  if (adminEmail !== undefined && adminEmail && !isValidEmail(adminEmail)) {
    throw new AppError(400, 'E-mail de acesso ao painel inválido.');
  }
  if (adminPassword !== undefined && adminPassword && String(adminPassword).length < 8) {
    throw new AppError(400, 'A senha inicial deve ter pelo menos 8 caracteres.');
  }
  if (adminPassword !== undefined && confirmPassword !== undefined && String(confirmPassword) !== String(adminPassword)) {
    throw new AppError(400, 'As senhas não coincidem.');
  }

  let finalDomain = '';
  if (domain !== undefined) {
    finalDomain = normalizeDomain(domain);
    if (finalDomain && (!finalDomain.includes('.') || /\s/.test(finalDomain))) {
      throw new AppError(400, 'Informe um domínio válido (ex: esteticaalpha.com.br).');
    }
  }

  return {
    name: name !== undefined ? String(name).trim() : undefined,
    slug: finalSlug,
    document: document !== undefined ? String(document || '').replace(/[^\d]/g, '') : undefined,
    email: email !== undefined ? String(email).trim().toLowerCase() : undefined,
    phone: phone !== undefined ? (phone ? String(phone).trim() : null) : undefined,
    plan: plan !== undefined ? String(plan || 'FREE').toUpperCase() : undefined,
    status: status !== undefined ? status : undefined,
    expires_at: expires_at !== undefined ? (expires_at || null) : undefined,
    adminName: adminName !== undefined ? String(adminName).trim() : undefined,
    adminEmail: adminEmail !== undefined ? String(adminEmail).trim().toLowerCase() : undefined,
    adminPassword,
    domain: domain !== undefined ? finalDomain : undefined
  };
}

function createTenant(req, res) {
  const body = validateTenantInput(req.body);
  getCoreDb();

  if (!body.name) throw new AppError(400, 'Informe o nome da empresa.');
  if (!body.slug) throw new AppError(400, 'Informe o slug da empresa.');
  if (!body.adminName || !body.adminEmail || !body.adminPassword) {
    throw new AppError(400, 'Informe nome, e-mail de acesso e senha inicial do administrador.');
  }
  if (getTenantBySlug(body.slug)) {
    throw new AppError(409, 'Este slug já está cadastrado.');
  }
  if (getUserByEmail(body.adminEmail)) {
    throw new AppError(409, 'Este e-mail já está cadastrado na plataforma.');
  }
  if (body.domain && getDomainRow(body.domain)) {
    throw new AppError(409, 'Este domínio já está cadastrado.');
  }

  const id = nextTenantId();
  const databaseName = buildDatabaseName(id, body.slug);
  if (tenantDatabaseExists(databaseName)) {
    throw new AppError(409, 'O banco desta empresa já existe. Verifique os dados.');
  }

  /* 1. Cria o banco SQLite exclusivo da empresa (arquivo + tabelas + dados padrão). */
  createTenantDatabase(databaseName, {
    companyName: body.name,
    phone: body.phone || body.adminEmail,
    whatsapp: body.phone,
    fullCatalog: false
  });

  /* 2. Registra tenant + owner + domínio de forma atômica no banco central.
        Se qualquer passo falhar, remove o banco recém-criado e não deixa
        registros órfãos (rollback + limpeza do arquivo). */
  let bundle;
  try {
    bundle = createTenantBundle({
      tenant: {
        name: body.name,
        slug: body.slug,
        database_name: databaseName,
        document: body.document,
        email: body.email,
        phone: body.phone,
        plan: body.plan,
        status: body.status,
        expires_at: body.expires_at
      },
      user: {
        name: body.adminName,
        email: body.adminEmail,
        password_hash: bcrypt.hashSync(body.adminPassword, 10),
        role: 'owner',
        active: 1
      },
      domain: body.domain || null
    });
  } catch (err) {
    try {
      deleteTenantDatabase(databaseName);
    } catch (cleanupErr) {
      console.error('[papi-core] Erro ao remover banco órfão', databaseName, cleanupErr.message);
    }
    throw mapCreateTenantError(err);
  }

  safeLog(() => logActivity(req.user.id, bundle.tenant.id, 'TENANT_CREATED', `Empresa "${body.name}" criada (banco ${databaseName})`));
  safeLog(() => logActivity(req.user.id, bundle.tenant.id, 'TENANT_OWNER_CREATED', `Administrador ${body.adminEmail} vinculado como proprietário`));
  if (body.domain) {
    safeLog(() => logActivity(req.user.id, bundle.tenant.id, 'TENANT_DOMAIN_CREATED', `Domínio principal ${body.domain} vinculado`));
  }

  return res.status(201).json(tenantWithStats(getTenantById(bundle.tenant.id)));
}

function updateTenantHandler(req, res) {
  const existing = getTenantById(req.params.id);
  if (!existing) throw new AppError(404, 'Empresa não encontrada.');

  const data = validateTenantInput(req.body, { existing });
  const fields = {};
  for (const key of ['name', 'slug', 'document', 'email', 'phone', 'plan', 'status', 'expires_at']) {
    if (data[key] !== undefined) fields[key] = data[key];
  }

  const tenant = updateTenant(existing.id, fields);

  /* se informou dados do administrador, atualiza o owner */
  if ((data.adminName !== undefined || data.adminEmail !== undefined) && !data.adminPassword) {
    const owner = getTenantOwner(existing.id);
    if (owner) {
      const ownerFields = {};
      if (data.adminName !== undefined) ownerFields.name = data.adminName;
      if (data.adminEmail !== undefined) {
        if (String(data.adminEmail).toLowerCase() !== String(owner.email).toLowerCase()) {
          const dup = getUserByEmail(data.adminEmail);
          if (dup && dup.id !== owner.id) {
            throw new AppError(409, 'Este e-mail já está cadastrado na plataforma.');
          }
        }
        ownerFields.email = data.adminEmail;
      }
      updateUser(owner.id, ownerFields);
      logActivity(req.user.id, tenant.id, 'TENANT_OWNER_UPDATED', 'Dados do administrador atualizados');
    }
  }

  logActivity(req.user.id, tenant.id, 'TENANT_UPDATED', 'Dados da empresa atualizados');
  return res.json(tenantWithStats(tenant));
}

function setTenantStatusHandler(req, res) {
  const { status } = req.body || {};
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (!VALID_STATUSES.includes(status)) {
    throw new AppError(400, 'Status inválido (use ACTIVE, SUSPENDED ou TRIAL).');
  }

  const updated = setTenantStatus(tenant.id, status);
  logActivity(req.user.id, tenant.id, 'TENANT_STATUS', `Status alterado para ${status}`);
  return res.json(tenantWithStats(updated));
}

function suspendTenant(req, res) {
  req.body = { ...req.body, status: 'SUSPENDED' };
  return setTenantStatusHandler(req, res);
}

function reactivateTenant(req, res) {
  req.body = { ...req.body, status: 'ACTIVE' };
  return setTenantStatusHandler(req, res);
}

function resetTenantPassword(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const owner = getTenantOwner(tenant.id);
  if (!owner) throw new AppError(400, 'Esta empresa não possui administrador vinculado.');

  const newPassword = req.body && req.body.new_password;
  const confirmPassword = req.body && req.body.confirm_password;
  if (!newPassword || String(newPassword).length < 8) throw new AppError(400, 'Informe uma nova senha com pelo menos 8 caracteres.');
  if (confirmPassword !== undefined && String(confirmPassword) !== String(newPassword)) {
    throw new AppError(400, 'As senhas não coincidem.');
  }
  setUserPassword(owner.id, bcrypt.hashSync(newPassword, 10));

  logActivity(req.user.id, tenant.id, 'TENANT_OWNER_PASSWORD_RESET', `Senha do administrador "${owner.email}" redefinida`);
  return res.json({
    success: true,
    admin_email: owner.email
  });
}

/* ---------- Administrador principal da empresa ---------- */

function updateTenantOwner(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const owner = getTenantOwner(tenant.id);
  if (!owner) throw new AppError(400, 'Esta empresa não possui administrador vinculado.');

  const { name, email, active } = req.body || {};
  const fields = {};
  if (name !== undefined) {
    if (String(name).trim().length < 2) throw new AppError(400, 'Informe o nome do administrador.');
    fields.name = String(name).trim();
  }
  if (email !== undefined) {
    if (!isValidEmail(email)) throw new AppError(400, 'E-mail de acesso ao painel inválido.');
    const norm = String(email).trim().toLowerCase();
    if (norm !== String(owner.email).toLowerCase()) {
      const dup = getUserByEmail(norm);
      if (dup && dup.id !== owner.id) {
        throw new AppError(409, 'Este e-mail já está cadastrado na plataforma.');
      }
    }
    fields.email = norm;
  }
  if (active !== undefined) fields.active = active ? 1 : 0;

  let updated = owner;
  if (Object.keys(fields).length) updated = updateUser(owner.id, fields);

  if (active !== undefined) {
    logActivity(req.user.id, tenant.id, 'TENANT_OWNER_STATUS_CHANGED', `Administrador "${updated.email}" ${active ? 'ativado' : 'desativado'}`);
  }
  if (name !== undefined || email !== undefined) {
    logActivity(req.user.id, tenant.id, 'TENANT_OWNER_UPDATED', 'Dados do administrador atualizados');
  }

  const { password_hash, ...safe } = updated;
  return res.json(safe);
}

function impersonate(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (tenant.status !== 'ACTIVE') {
    throw new AppError(400, 'Não é possível entrar em uma empresa suspensa.');
  }

  const owner = getTenantOwner(tenant.id);
  if (!owner) throw new AppError(400, 'Esta empresa não possui administrador vinculado.');

  const startedAt = new Date().toISOString();
  const token = jwt.sign({
    id: owner.id, name: owner.name, email: owner.email, role: owner.role,
    tenant_id: owner.tenant_id, impersonated: true, developer_id: req.user.id,
    original_user_id: req.user.id, started_at: startedAt
  }, process.env.JWT_SECRET, { expiresIn: '30m' });
  logActivity(req.user.id, tenant.id, 'IMPERSONATE', `Entrou como ${owner.email}`);
  return res.json({
    token,
    expires_in: 1800,
    redirect: '/admin',
    user: { id: owner.id, name: owner.name, email: owner.email, role: owner.role, tenant_id: owner.tenant_id }
  });
}

function backupTenant(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const tenantDb = require('../database/tenantDatabase').openTenantDatabase(tenant.database_name);
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const backupName = `${tenant.database_name.replace('.db', '')}-${Date.now()}.db`;
  const tmpFile = path.join(BACKUPS_DIR, backupName);
  const escaped = tmpFile.replace(/'/g, "''");
  tenantDb.exec(`VACUUM INTO '${escaped}'`);

  logActivity(req.user.id, tenant.id, 'BACKUP', 'Backup do banco gerado');
  if (req.method === 'GET') return res.download(tmpFile, `${tenant.database_name.replace('.db', '')}-backup-${todayStr()}.db`);
  return res.status(201).json({ success: true, name: backupName, size: fs.statSync(tmpFile).size, created_at: new Date().toISOString() });
}

function listBackupsHandler(req, res) {
  if (!fs.existsSync(BACKUPS_DIR)) return res.json([]);
  const tenants = listTenants();
  const backups = fs.readdirSync(BACKUPS_DIR)
    .filter((name) => /^tenant_\d{4}_[a-z0-9_-]+-\d+\.db$/.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, name));
      const tenant = tenants.find((item) => name.startsWith(item.database_name.replace('.db', '') + '-'));
      return { name, size: stat.size, created_at: stat.birthtime.toISOString(), tenant: tenant ? { id: tenant.id, name: tenant.name } : null };
    });
  return res.json(backups.sort((a, b) => b.created_at.localeCompare(a.created_at)));
}

function deleteTenantHandler(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (tenant.slug === 'torque-detail') {
    throw new AppError(400, 'A empresa padrão da plataforma não pode ser excluída.');
  }

  const confirmation = String((req.body && req.body.confirmation) || '');
  if (confirmation !== tenant.name && confirmation !== tenant.slug) {
    throw new AppError(400, 'Digite exatamente o nome ou slug da empresa para confirmar.');
  }
  /* Exclusão definitiva: apaga o banco de dados exclusivo da empresa e a
     linha em tenants — domínios, usuários e lançamentos financeiros somem
     junto via ON DELETE CASCADE (foreign_keys ligado em openCore()). */
  deleteTenant(tenant.id);
  logActivity(req.user.id, null, 'TENANT_DELETED', `Empresa "${tenant.name}" excluída permanentemente`);
  return res.json({ success: true });
}

/* ---------- Domínios ---------- */

function listDomainsHandler(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  return res.json(listDomains(tenant.id));
}

function addDomain(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const { domain, is_primary } = req.body || {};
  const normalized = String(domain || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('.') || /\s/.test(normalized)) {
    throw new AppError(400, 'Informe um domínio válido (ex: esteticaalpha.com.br).');
  }

  const domains = listDomains(tenant.id);
  if (domains.some((d) => d.domain === normalized.replace(/^www\./, ''))) {
    throw new AppError(409, 'Este domínio já está cadastrado para esta empresa.');
  }

  const row = insertDomain(tenant.id, normalized, Boolean(is_primary) || domains.length === 0);
  logActivity(req.user.id, tenant.id, 'DOMAIN_ADDED', `Domínio ${row.domain} adicionado`);
  return res.status(201).json(row);
}

function updateDomainHandler(req, res) {
  const row = getDomainById(req.params.domainId);
  if (!row) throw new AppError(404, 'Domínio não encontrado.');

  const { is_primary, verified, domain } = req.body || {};

  if (domain !== undefined) {
    const normalized = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
    if (!normalized || !normalized.includes('.') || /\s/.test(normalized)) {
      throw new AppError(400, 'Informe um domínio válido (ex: esteticaalpha.com.br).');
    }
    if (normalized !== row.domain) {
      const existing = getDomainRow(normalized);
      if (existing && existing.domain_id !== row.id) {
        throw new AppError(409, 'Este domínio já está cadastrado para outra empresa.');
      }
      setDomainValue(row.id, normalized);
    }
  }
  if (is_primary !== undefined) setDomainPrimary(row.id);
  if (verified !== undefined) setDomainVerified(row.id, verified ? 1 : 0);

  logActivity(req.user.id, row.tenant_id, 'DOMAIN_UPDATED', `Domínio ${row.domain} atualizado`);
  return res.json(getDomainById(row.id));
}

function removeDomainHandler(req, res) {
  const row = getDomainById(req.params.domainId);
  if (!row) throw new AppError(404, 'Domínio não encontrado.');
  deleteDomain(row.id);
  logActivity(req.user.id, row.tenant_id, 'DOMAIN_REMOVED', `Domínio ${row.domain} removido`);
  return res.json({ success: true });
}

function dnsInstructions(req, res) {
  const row = getDomainById(req.params.domainId);
  if (!row) throw new AppError(404, 'Domínio não encontrado.');

  const apex = row.domain;
  const www = `www.${apex}`;
  const platformDomain = String(process.env.SAAS_CNAME_TARGET || process.env.PLATFORM_DOMAIN || 'app.papicore.com.br').trim();
  const serverIp = String(process.env.PLATFORM_SERVER_IP || '').trim();

  const records = [];
  if (serverIp) {
    records.push({
      type: 'A',
      name: '@',
      value: serverIp,
      ttl: '3600',
      purpose: `Aponta ${apex} para o servidor da plataforma.`
    });
    records.push({
      type: 'A',
      name: 'www',
      value: serverIp,
      ttl: '3600',
      purpose: `Aponta ${www} para o servidor da plataforma.`
    });
  } else {
    records.push({
      type: 'CNAME',
      name: 'www',
      value: platformDomain,
      ttl: '3600',
      purpose: `Aponta ${www} para ${platformDomain}.`
    });
    records.push({
      type: 'A',
      name: '@',
      value: 'EXEMPLO: 203.0.113.10',
      ttl: '3600',
      purpose: 'Use o IP do servidor (A) ou um CNAME/redirect para a plataforma.'
    });
  }

  return res.json({
    domain: apex,
    records,
    steps: [
      'Acesse o painel DNS do seu provedor de domínio.',
      'Adicione os registros abaixo apontando o domínio para a plataforma.',
      'Depois de propagar (pode levar de 15 min a 24h), clique em "Marcar como verificado".',
      'Acesse o site no seu domínio para confirmar que tudo funciona.'
    ]
  });
}

/* ---------- Usuários ---------- */

function listUsersHandler(req, res) {
  const { tenant_id } = req.query;
  const users = tenant_id
    ? listUsersByTenant(Number(tenant_id))
    : listUsers();
  const result = users.map(({ password_hash, ...u }) => ({
    ...u,
    tenant: u.tenant_id ? getTenantById(u.tenant_id) : null
  }));
  return res.json(result);
}

function createUser(req, res) {
  const { tenant_id, name, email, password, role } = req.body || {};
  if (!tenant_id) throw new AppError(400, 'Informe a empresa (tenant_id).');
  if (!name || String(name).trim().length < 2) throw new AppError(400, 'Informe o nome.');
  if (!isValidEmail(email)) throw new AppError(400, 'E-mail inválido.');
  if (!password || String(password).length < 6) throw new AppError(400, 'A senha deve ter pelo menos 6 caracteres.');

  const tenant = getTenantById(Number(tenant_id));
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (getUserByEmail(email)) throw new AppError(409, 'Já existe um usuário com este e-mail.');

  const roles = ['owner', 'admin', 'employee'];
  const finalRole = roles.includes(role) ? role : 'employee';

  const user = insertUser({
    tenant_id: tenant.id,
    name: String(name).trim(),
    email,
    password_hash: bcrypt.hashSync(String(password), 10),
    role: finalRole,
    active: 1
  });
  logActivity(req.user.id, tenant.id, 'USER_CREATED', `Usuário ${email} criado`);
  const { password_hash, ...safeUser } = user;
  return res.status(201).json({ ...safeUser, tenant });
}

function updateUserHandler(req, res) {
  const user = getUserById(req.params.id);
  if (!user) throw new AppError(404, 'Usuário não encontrado.');
  if (user.role === 'developer') throw new AppError(400, 'Usuários desenvolvedor não podem ser alterados aqui.');

  const { name, role, active, email, password } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = String(name).trim();
  if (email !== undefined) {
    if (!isValidEmail(email)) throw new AppError(400, 'E-mail inválido.');
    const norm = String(email).trim().toLowerCase();
    if (norm !== String(user.email).toLowerCase()) {
      const dup = getUserByEmail(norm);
      if (dup && dup.id !== user.id) {
        throw new AppError(409, 'Este e-mail já está cadastrado na plataforma.');
      }
    }
    fields.email = norm;
  }
  if (role !== undefined) {
    if (!['owner', 'admin', 'employee'].includes(role)) throw new AppError(400, 'Papel inválido.');
    fields.role = role;
  }
  if (active !== undefined) fields.active = active ? 1 : 0;

  let updated = updateUser(user.id, fields);
  if (password) {
    if (String(password).length < 6) throw new AppError(400, 'A senha deve ter pelo menos 6 caracteres.');
    updated = setUserPassword(user.id, bcrypt.hashSync(String(password), 10));
  }

  logActivity(req.user.id, user.tenant_id, 'USER_UPDATED', `Usuário ${user.email} atualizado`);
  const { password_hash, ...safeUpdated } = updated;
  return res.json({ ...safeUpdated, tenant: updated.tenant_id ? getTenantById(updated.tenant_id) : null });
}

function deleteUserHandler(req, res) {
  const user = getUserById(req.params.id);
  if (!user) throw new AppError(404, 'Usuário não encontrado.');
  if (user.role === 'developer') throw new AppError(400, 'Usuários desenvolvedor não podem ser excluídos.');
  deleteUser(user.id);
  logActivity(req.user.id, user.tenant_id, 'USER_DELETED', `Usuário ${user.email} excluído`);
  return res.json({ success: true });
}

/* ---------- Planos ---------- */

function listPlansHandler(req, res) {
  const plans = listPlans().map((p) => ({ ...p, features: parseFeatures(p.features) }));
  return res.json(plans);
}

function createPlan(req, res) {
  const { name, slug, monthly_price, appointment_limit, features } = req.body || {};
  if (!name || String(name).trim().length < 2) throw new AppError(400, 'Informe o nome do plano.');
  if (listPlans().some((p) => p.slug === String(slug || slugify(name)).toUpperCase())) {
    throw new AppError(409, 'Já existe um plano com este slug.');
  }
  const plan = insertPlan({ name, slug, monthly_price, appointment_limit, features });
  logActivity(req.user.id, null, 'PLAN_CREATED', `Plano ${plan.slug} criado`);
  return res.status(201).json({ ...plan, features: parseFeatures(plan.features) });
}

function updatePlanHandler(req, res) {
  const plans = listPlans();
  const current = plans.find((p) => String(p.id) === String(req.params.id));
  if (!current) throw new AppError(404, 'Plano não encontrado.');

  const { name, slug, monthly_price, appointment_limit, features, active } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = String(name).trim();
  if (slug !== undefined) {
    const newSlug = String(slug).toUpperCase();
    if (plans.some((p) => p.slug === newSlug && String(p.id) !== String(req.params.id))) {
      throw new AppError(409, 'Já existe um plano com este slug.');
    }
    fields.slug = newSlug;
  }
  if (monthly_price !== undefined) fields.monthly_price = Number(monthly_price) || 0;
  if (appointment_limit !== undefined) fields.appointment_limit = appointment_limit === '' ? null : Number(appointment_limit);
  if (features !== undefined) fields.features = features;
  if (active !== undefined) fields.active = active ? 1 : 0;

  const plan = updatePlan(current.id, fields);
  logActivity(req.user.id, null, 'PLAN_UPDATED', `Plano ${plan.slug} atualizado`);
  return res.json({ ...plan, features: parseFeatures(plan.features) });
}

function deletePlanHandler(req, res) {
  const plans = listPlans();
  const current = plans.find((p) => String(p.id) === String(req.params.id));
  if (!current) throw new AppError(404, 'Plano não encontrado.');

  const inUse = listTenants().filter((t) => t.plan === current.slug).length;
  if (inUse > 0) {
    throw new AppError(409, `Este plano está em uso por ${inUse} empresa(s).`);
  }
  deletePlan(current.id);
  logActivity(req.user.id, null, 'PLAN_DELETED', `Plano ${current.slug} excluído`);
  return res.json({ success: true });
}

/* ---------- Financeiro ---------- */

const FINANCIAL_TYPES = ['MONTHLY', 'PACKAGE', 'PERCENTAGE'];
const FINANCIAL_STATUSES = ['PENDING', 'PAID', 'CANCELED'];

function financialWithTenant(entry) {
  const tenant = getTenantById(entry.tenant_id);
  const overdue = entry.status === 'PENDING' && entry.due_date && entry.due_date < todayStr();
  return {
    ...entry,
    is_overdue: overdue,
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null
  };
}

function listFinancialHandler(req, res) {
  const { tenant_id, status, type } = req.query;
  const filters = {};
  if (tenant_id) filters.tenant_id = Number(tenant_id);
  if (status) filters.status = status;
  if (type) filters.type = type;
  const entries = listFinancialEntries(filters).map(financialWithTenant);
  return res.json(entries);
}

function validateFinancialInput(body, { partial = false } = {}) {
  const {
    tenant_id, type, description, amount, percentage,
    installment_number, installment_total, due_date, status, notes
  } = body || {};

  if (!partial || tenant_id !== undefined) {
    if (!tenant_id || !getTenantById(Number(tenant_id))) throw new AppError(400, 'Informe uma empresa válida.');
  }
  if (!partial || type !== undefined) {
    if (!FINANCIAL_TYPES.includes(type)) throw new AppError(400, 'Tipo de cobrança inválido.');
  }
  if (!partial || amount !== undefined) {
    if (amount === undefined || amount === null || amount === '' || Number(amount) <= 0) {
      throw new AppError(400, 'Informe um valor maior que zero.');
    }
  }
  if (!partial || due_date !== undefined) {
    if (!due_date || !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) throw new AppError(400, 'Informe uma data de vencimento válida.');
  }
  if (status !== undefined && !FINANCIAL_STATUSES.includes(status)) {
    throw new AppError(400, 'Status inválido.');
  }

  const result = {};
  if (tenant_id !== undefined) result.tenant_id = Number(tenant_id);
  if (type !== undefined) result.type = type;
  if (description !== undefined) result.description = String(description || '').trim() || null;
  if (amount !== undefined) result.amount = Number(amount);
  if (percentage !== undefined) result.percentage = (percentage === '' || percentage === null) ? null : Number(percentage);
  if (installment_number !== undefined) result.installment_number = (installment_number === '' || installment_number === null) ? null : Number(installment_number);
  if (installment_total !== undefined) result.installment_total = (installment_total === '' || installment_total === null) ? null : Number(installment_total);
  if (due_date !== undefined) result.due_date = due_date;
  if (status !== undefined) result.status = status;
  if (notes !== undefined) result.notes = String(notes || '').trim() || null;
  return result;
}

function createFinancialEntry(req, res) {
  const data = validateFinancialInput(req.body);
  if (!data.status) data.status = 'PENDING';
  if (data.status === 'PAID') data.paid_at = todayStr();
  const entry = insertFinancialEntry(data);
  logActivity(req.user.id, entry.tenant_id, 'FINANCIAL_ENTRY_CREATED', `Cobrança de R$ ${Number(entry.amount).toFixed(2)} criada`);
  return res.status(201).json(financialWithTenant(entry));
}

function updateFinancialEntryHandler(req, res) {
  const existing = getFinancialEntry(req.params.id);
  if (!existing) throw new AppError(404, 'Cobrança não encontrada.');

  const data = validateFinancialInput(req.body, { partial: true });
  if (data.status === 'PAID' && !existing.paid_at) {
    data.paid_at = todayStr();
  } else if (data.status && data.status !== 'PAID' && existing.status === 'PAID') {
    data.paid_at = null;
  }

  const entry = updateFinancialEntry(existing.id, data);
  logActivity(req.user.id, entry.tenant_id, 'FINANCIAL_ENTRY_UPDATED', `Cobrança #${entry.id} atualizada`);
  return res.json(financialWithTenant(entry));
}

function deleteFinancialEntryHandler(req, res) {
  const existing = getFinancialEntry(req.params.id);
  if (!existing) throw new AppError(404, 'Cobrança não encontrada.');
  deleteFinancialEntry(existing.id);
  logActivity(req.user.id, existing.tenant_id, 'FINANCIAL_ENTRY_DELETED', `Cobrança #${existing.id} excluída`);
  return res.json({ success: true });
}

/* ---------- Logs ---------- */

function logsHandler(req, res) {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const logs = listLogs(limit).map((l) => ({
    ...l,
    tenant: l.tenant_id ? getTenantById(l.tenant_id) : null
  }));
  return res.json(logs);
}

/* ---------- Configurações da plataforma ---------- */

function platformSettings(req, res) {
  const core = getCoreDb();
  return res.json({
    platform_name: process.env.PLATFORM_NAME || 'PapiCore',
    storage: 'SQLite isolado por empresa',
    node_env: process.env.NODE_ENV || 'development',
    default_tenant_slug: process.env.DEFAULT_TENANT_SLUG || 'torque-detail',
    platform_domain: process.env.PLATFORM_DOMAIN || '',
    platform_server_ip: process.env.PLATFORM_SERVER_IP || '',
    counts: {
      tenants: listTenants().length,
      users: listUsers().length,
      plans: listPlans().length
    }
  });
}

module.exports = {
  login,
  me,
  changePassword,
  dashboard,
  listTenantsHandler,
  getTenantHandler,
  createTenant,
  updateTenantHandler,
  setTenantStatusHandler,
  suspendTenant,
  reactivateTenant,
  resetTenantPassword,
  updateTenantOwner,
  impersonate,
  backupTenant,
  listBackupsHandler,
  deleteTenantHandler,
  listDomainsHandler,
  addDomain,
  updateDomainHandler,
  removeDomainHandler,
  dnsInstructions,
  listUsersHandler,
  createUser,
  updateUserHandler,
  deleteUserHandler,
  listPlansHandler,
  createPlan,
  updatePlanHandler,
  deletePlanHandler,
  listFinancialHandler,
  createFinancialEntry,
  updateFinancialEntryHandler,
  deleteFinancialEntryHandler,
  logsHandler,
  platformSettings
};
