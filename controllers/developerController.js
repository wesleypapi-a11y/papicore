/*
 * developerController.js
 *
 * Controladores do painel exclusivo do desenvolvedor ("Papi Core"),
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
  updateTenant,
  setTenantStatus,
  deleteTenant,
  nextTenantId,
  countTenantAppointments,
  listDomains,
  getDomainById,
  insertDomain,
  setDomainPrimary,
  setDomainVerified,
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
  listLogs,
  logActivity
} = require('../database/coreDatabase');
const { buildDatabaseName, tenantDatabaseExists } = require('../database/createTenantDatabase');
const { createTenantDatabase } = require('../database/tenantDatabase');
const { deleteTenantDatabase } = require('../database/tenantDatabase');
const { AppError, isValidEmail, isValidPhone, todayStr, slugify } = require('../utils/helpers');
const { signToken } = require('./authController');

const VALID_STATUSES = ['ACTIVE', 'SUSPENDED', 'TRIAL'];

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

/* ---------- Autenticação ---------- */

function login(req, res) {
  const { email, password } = req.body || {};

  if (!isValidEmail(email) || !password) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const user = getUserByEmail(String(email).trim().toLowerCase());
  if (!user || user.role !== 'developer') {
    throw new AppError(401, 'Acesso restrito ao desenvolvedor da plataforma.');
  }
  if (!user.active) {
    throw new AppError(401, 'Usuário inativo.');
  }
  const ok = bcrypt.compareSync(String(password), user.password_hash);
  if (!ok) {
    throw new AppError(401, 'E-mail ou senha inválidos.');
  }

  const token = signToken(user);
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
    developers,
    company_users: companyUsers,
    domains,
    appointments,
    plans: listPlans().length,
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
    adminPassword
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
      throw new AppError(409, 'Já existe uma empresa com este slug.');
    }
  }

  if (email !== undefined && !isValidEmail(email)) {
    throw new AppError(400, 'E-mail inválido.');
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
    throw new AppError(400, 'E-mail do administrador inválido.');
  }
  if (adminPassword !== undefined && adminPassword && String(adminPassword).length < 6) {
    throw new AppError(400, 'A senha inicial deve ter pelo menos 6 caracteres.');
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
    adminPassword
  };
}

function createTenant(req, res) {
  const body = validateTenantInput(req.body);
  const db = getCoreDb();

  if (!body.name) throw new AppError(400, 'Informe o nome da empresa.');
  if (!body.slug) throw new AppError(400, 'Informe o slug da empresa.');
  if (!body.adminName || !body.adminEmail || !body.adminPassword) {
    throw new AppError(400, 'Informe nome, e-mail e senha inicial do administrador.');
  }
  if (getTenantBySlug(body.slug)) {
    throw new AppError(409, 'Já existe uma empresa com este slug.');
  }
  if (getUserByEmail(body.adminEmail)) {
    throw new AppError(409, 'Já existe um usuário com este e-mail.');
  }

  const id = nextTenantId();
  const databaseName = buildDatabaseName(id, body.slug);
  if (tenantDatabaseExists(databaseName)) {
    throw new AppError(409, 'O banco desta empresa já existe. Verifique os dados.');
  }

  /* 1-7: cria o banco com todas as tabelas e dados padrão */
  const tenantDb = createTenantDatabase(databaseName, {
    companyName: body.name,
    phone: body.phone || body.adminEmail,
    whatsapp: body.phone,
    fullCatalog: false
  });

  /* registra a empresa no banco central */
  const tenant = insertTenant({
    name: body.name,
    slug: body.slug,
    database_name: databaseName,
    document: body.document,
    email: body.email,
    phone: body.phone,
    plan: body.plan,
    status: 'ACTIVE',
    expires_at: null
  });

  /* 8-9: cria o administrador e vincula à empresa */
  insertUser({
    tenant_id: tenant.id,
    name: body.adminName,
    email: body.adminEmail,
    password_hash: bcrypt.hashSync(body.adminPassword, 10),
    role: 'owner',
    active: 1
  });

  logActivity(req.user.id, tenant.id, 'TENANT_CREATED', `Empresa "${body.name}" criada (banco ${databaseName})`);
  return res.status(201).json(tenantWithStats(getTenantById(tenant.id)));
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
      updateUser(owner.id, {
        name: data.adminName !== undefined ? data.adminName : undefined,
        email: data.adminEmail !== undefined ? data.adminEmail : undefined
      });
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

function resetTenantPassword(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const owner = getTenantOwner(tenant.id);
  if (!owner) throw new AppError(400, 'Esta empresa não possui administrador vinculado.');

  const newPassword = (req.body && req.body.new_password) || 'mudar123';
  setUserPassword(owner.id, bcrypt.hashSync(newPassword, 10));

  logActivity(req.user.id, tenant.id, 'PASSWORD_RESET', `Senha do administrador "${owner.email}" redefinida`);
  return res.json({
    success: true,
    admin_email: owner.email,
    new_password: newPassword
  });
}

function impersonate(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (tenant.status !== 'ACTIVE') {
    throw new AppError(400, 'Não é possível entrar em uma empresa suspensa.');
  }

  const owner = getTenantOwner(tenant.id);
  if (!owner) throw new AppError(400, 'Esta empresa não possui administrador vinculado.');

  const token = signToken(owner);
  logActivity(req.user.id, tenant.id, 'IMPERSONATE', `Entrou como ${owner.email}`);
  return res.json({
    token,
    redirect: '/admin',
    user: { id: owner.id, name: owner.name, email: owner.email, role: owner.role, tenant_id: owner.tenant_id }
  });
}

function backupTenant(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const tenantDb = require('../database/tenantDatabase').openTenantDatabase(tenant.database_name);
  const tmpFile = path.join(os.tmpdir(), `${tenant.database_name.replace('.db', '')}-${Date.now()}.db`);
  const escaped = tmpFile.replace(/'/g, "''");
  tenantDb.exec(`VACUUM INTO '${escaped}'`);

  logActivity(req.user.id, tenant.id, 'BACKUP', 'Backup do banco gerado');
  res.download(tmpFile, `${tenant.database_name.replace('.db', '')}-backup-${todayStr()}.db`, (err) => {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch { /* ignore */ }
    if (err) {
      console.error('[developer] Erro ao enviar backup:', err.message);
    }
  });
}

function deleteTenantHandler(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (tenant.slug === 'torque-detail') {
    throw new AppError(400, 'A empresa padrão da plataforma não pode ser excluída.');
  }

  deleteTenant(tenant.id);
  logActivity(req.user.id, null, 'TENANT_DELETED', `Empresa "${tenant.name}" excluída`);
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

  const { is_primary, verified } = req.body || {};
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
  const platformDomain = String(process.env.PLATFORM_DOMAIN || 'app.papi.app').trim();
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
  const result = users.map((u) => ({
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
  return res.status(201).json({ ...user, tenant });
}

function updateUserHandler(req, res) {
  const user = getUserById(req.params.id);
  if (!user) throw new AppError(404, 'Usuário não encontrado.');
  if (user.role === 'developer') throw new AppError(400, 'Usuários desenvolvedor não podem ser alterados aqui.');

  const { name, role, active, password } = req.body || {};
  const fields = {};
  if (name !== undefined) fields.name = String(name).trim();
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
  return res.json({ ...updated, tenant: updated.tenant_id ? getTenantById(updated.tenant_id) : null });
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
    platform_name: process.env.PLATFORM_NAME || 'Papi Core',
    core_database: require('../database/coreDatabase').CORE_FILE,
    tenants_directory: require('../database/tenantDatabase').tenantsDir(),
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
  resetTenantPassword,
  impersonate,
  backupTenant,
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
  logsHandler,
  platformSettings
};
