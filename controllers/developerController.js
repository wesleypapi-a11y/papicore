/*
 * developerController.js
 *
 * Controladores do painel exclusivo do desenvolvedor ("PapiCore"),
 * acessível somente por usuários com role = developer.
 *
 * Gerencia toda a plataforma: empresas (tenants), domínios, usuários, planos,
 * logs, backups e impersonação. Usa o banco central (papi_core.db).
 */

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
  getPlanBySlug,
  listFinancialEntries,
  getFinancialEntry,
  insertFinancialEntry,
  updateFinancialEntry,
  deleteFinancialEntry,
  listLogs,
  logActivity,
  normalizeDomain,
  listLeads,
  updateLeadStatus
} = require('../database/coreDatabase');
const { buildDatabaseName, tenantDatabaseExists } = require('../database/createTenantDatabase');
const { createTenantDatabase } = require('../database/tenantDatabase');
const { deleteTenantDatabase } = require('../database/tenantDatabase');
const { AppError, isValidEmail, isValidPhone, isValidTime, todayStr, slugify, LEAD_STATUSES } = require('../utils/helpers');
const { signToken } = require('./authController');
const backupService = require('../services/backupService');
const restoreService = require('../services/restoreService');
const planService = require('../services/planService');

const VALID_STATUSES = ['ACTIVE', 'SUSPENDED', 'TRIAL', 'ARCHIVED'];

function auditDetails(req, message) {
  return JSON.stringify({ message, ip: req.ip || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) });
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
  if (plan !== undefined && plan) {
    const planUpper = String(plan).toUpperCase();
    const exists = listPlans().some((p) => String(p.slug).toUpperCase() === planUpper);
    if (!exists) {
      throw new AppError(400, 'Plano inválido. Cadastre o plano no painel de Planos e Assinaturas antes de usá-lo.');
    }
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

  const unitInfo = buildUnitInput(body);

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
    domain: domain !== undefined ? finalDomain : undefined,
    unit: unitInfo.provided ? unitInfo.unit : undefined
  };
}

/*
 * Valida e normaliza os dados da primeira unidade preenchidos no formulário
 * "Nova empresa". Quando nenhum campo de unidade é informado (ex.: edição),
 * retorna { provided: false }. Quando os campos obrigatórios estão ausentes
 * ou inválidos, lança AppError com a lista clara do que falta — impedindo a
 * implantação antes de qualquer escrita no banco (regra: nunca salvar nome,
 * endereço ou telefone placeholder).
 */
function buildUnitInput(body = {}) {
  const {
    unitName, unitPhone, unitZipcode, unitStreet, unitNumber, unitComplement,
    unitNeighborhood, unitCity, unitState, unitReference, unitMapsLink,
    unitCapacity, unitOpeningTime, unitClosingTime, unitLunchStart, unitLunchEnd,
    unitWorkingDays, unitInterval
  } = body || {};

  const hasAnyUnitField =
    unitName !== undefined || unitPhone !== undefined || unitZipcode !== undefined ||
    unitStreet !== undefined || unitNumber !== undefined || unitComplement !== undefined ||
    unitNeighborhood !== undefined || unitCity !== undefined || unitState !== undefined ||
    unitReference !== undefined || unitMapsLink !== undefined ||
    unitCapacity !== undefined || unitOpeningTime !== undefined || unitClosingTime !== undefined ||
    unitLunchStart !== undefined || unitLunchEnd !== undefined ||
    unitWorkingDays !== undefined || unitInterval !== undefined;

  if (!hasAnyUnitField) return { provided: false, unit: null };

  const str = (v) => String(v || '').trim();
  const required = [
    ['unitName', 'nome da unidade'],
    ['unitPhone', 'telefone da unidade'],
    ['unitZipcode', 'CEP'],
    ['unitStreet', 'rua'],
    ['unitNumber', 'número'],
    ['unitNeighborhood', 'bairro'],
    ['unitCity', 'cidade'],
    ['unitState', 'estado'],
    ['unitCapacity', 'capacidade simultânea'],
    ['unitOpeningTime', 'horário de abertura'],
    ['unitClosingTime', 'horário de fechamento']
  ];

  const missing = required.filter(([key]) => !str(body[key])).map(([, label]) => label);
  if (missing.length) {
    throw new AppError(
      400,
      `Dados da primeira unidade incompletos. Faltam: ${missing.join(', ')}.`
    );
  }

  if (!isValidPhone(unitPhone)) {
    throw new AppError(400, 'Telefone da unidade inválido.');
  }
  const zipcode = str(unitZipcode).replace(/\D/g, '');
  if (!/^\d{8}$/.test(zipcode)) {
    throw new AppError(400, 'CEP da unidade inválido.');
  }
  const state = str(unitState).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw new AppError(400, 'Estado da unidade inválido (use a sigla, ex: SP).');
  }
  if (!isValidTime(unitOpeningTime) || !isValidTime(unitClosingTime)) {
    throw new AppError(400, 'Horários de funcionamento da unidade inválidos.');
  }
  if (unitClosingTime <= unitOpeningTime) {
    throw new AppError(400, 'O horário de fechamento deve ser após a abertura.');
  }
  if (unitLunchStart && !isValidTime(unitLunchStart)) {
    throw new AppError(400, 'Início do almoço inválido.');
  }
  if (unitLunchEnd && !isValidTime(unitLunchEnd)) {
    throw new AppError(400, 'Fim do almoço inválido.');
  }
  if (unitLunchStart && unitLunchEnd && unitLunchEnd <= unitLunchStart) {
    throw new AppError(400, 'O fim do almoço deve ser após o início.');
  }
  const interval = unitInterval === undefined || unitInterval === '' ? 60 : Number(unitInterval);
  if (!Number.isInteger(interval) || interval < 15 || interval > 240) {
    throw new AppError(400, 'O intervalo entre agendamentos deve estar entre 15 e 240 minutos.');
  }
  const capacity = Number(unitCapacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) {
    throw new AppError(400, 'A capacidade de atendimento deve estar entre 1 e 20.');
  }

  let days = [];
  if (Array.isArray(unitWorkingDays)) {
    days = [...new Set(unitWorkingDays.map(Number).filter((d) => d >= 0 && d <= 6))];
  } else if (unitWorkingDays !== undefined && unitWorkingDays !== '') {
    days = [...new Set(String(unitWorkingDays).split(',').map(Number).filter((d) => d >= 0 && d <= 6))];
  }
  if (days.length === 0) {
    throw new AppError(400, 'Selecione pelo menos um dia de funcionamento da unidade.');
  }

  const street = str(unitStreet);
  const number = str(unitNumber);
  const complement = str(unitComplement);
  const neighborhood = str(unitNeighborhood);
  const city = str(unitCity);
  const address = [street, number, complement, neighborhood, city, state].filter(Boolean).join(', ');

  return {
    provided: true,
    unit: {
      name: str(unitName),
      phone: str(unitPhone),
      address,
      address_street: street || null,
      address_number: number || null,
      address_complement: complement || null,
      address_neighborhood: neighborhood || null,
      address_city: city || null,
      address_state: state || null,
      address_zipcode: zipcode || null,
      address_reference: str(unitReference) || null,
      maps_link: str(unitMapsLink) || null,
      capacity,
      opening_time: unitOpeningTime,
      closing_time: unitClosingTime,
      lunch_start: unitLunchStart ? str(unitLunchStart) : '12:00',
      lunch_end: unitLunchEnd ? str(unitLunchEnd) : '13:00',
      appointment_interval: interval,
      working_days: days,
      active: 1
    }
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

  /* A primeira unidade é obrigatória e criada na MESMA operação de
     implantação. Sem ela, não há empresa para publicar a agenda. */
  if (!body.unit) {
    throw new AppError(
      400,
      'Dados da primeira unidade obrigatórios: nome, telefone, CEP, rua, número, bairro, cidade, estado, capacidade e horários de funcionamento.'
    );
  }

  const id = nextTenantId();
  const databaseName = buildDatabaseName(id, body.slug);
  if (tenantDatabaseExists(databaseName)) {
    throw new AppError(409, 'O banco desta empresa já existe. Verifique os dados.');
  }

  /* 1. Cria o banco SQLite exclusivo da empresa (arquivo + tabelas + dados
        padrão) já com a primeira unidade real. O telefone NUNCA usa o e-mail
        do administrador como fallback. Se a criação da unidade falhar, o
        banco parcial é removido (compensação) e a implantação é abortada. */
  try {
    createTenantDatabase(databaseName, {
      companyName: body.name,
      phone: body.phone || body.unit.phone || null,
      whatsapp: body.phone || body.unit.phone || null,
      unit: body.unit,
      fullCatalog: false
    });
  } catch (unitErr) {
    try {
      deleteTenantDatabase(databaseName);
    } catch (cleanupErr) {
      console.error('[papi-core] Erro ao remover banco parcial após falha na unidade', databaseName, cleanupErr.message);
    }
    throw mapCreateTenantError(unitErr);
  }

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

  /* Se o plano da empresa mudou, mantém a assinatura sincronizada (a
     assinatura é a fonte de verdade de preço/limite; tenants.plan é espelho). */
  if (fields.plan !== undefined) {
    const plan = getPlanBySlug(fields.plan) ||
      listPlans().find((p) => String(p.slug).toUpperCase() === String(fields.plan).toUpperCase());
    if (plan) {
      planService.updateTenantSubscription(existing.id, { plan_id: plan.id });
    }
  }

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

/*
 * Backup manual de uma empresa (POST /api/developer/tenants/:id/backup).
 * Delega ao backupService, que gera o ZIP (banco consistente + integridade +
 * hash SHA-256 + assets + manifest.json) e registra o histórico em backup_runs.
 */
function backupTenant(req, res, next) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  backupService.createTenantBackup({
    tenantId: tenant.id,
    backupType: 'TENANT_MANUAL',
    userId: req.user.id
  }).then((run) => res.status(201).json(run)).catch(next);
}

/* GET /api/developer/backups */
function listBackupsHandler(req, res) {
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : undefined;
  return res.json(backupService.listBackups({ tenantId }));
}

/* GET /api/developer/backups/:backupId */
function getBackupHandler(req, res) {
  return res.json(backupService.getBackup(req.params.backupId));
}

/* GET /api/developer/backups/storage */
function storageInfoHandler(req, res) {
  return res.json(backupService.getStorageInfo());
}

/* GET /api/developer/backups/:backupId/download */
function downloadBackupHandler(req, res) {
  const { run, filePath, filename } = backupService.resolveBackupFile(req.params.backupId);
  logActivity(req.user.id, run.tenant_id, 'BACKUP_DOWNLOADED', `Download de ${run.filename || filename}`);
  return res.download(filePath, filename);
}

/* DELETE /api/developer/backups/:backupId */
function deleteBackupHandler(req, res) {
  const run = backupService.deleteBackup(req.params.backupId, req.user.id);
  return res.json(run);
}

/* ---------- Restauração de backups ---------- */

/* POST /api/developer/backups/:backupId/restore */
function restoreBackupHandler(req, res, next) {
  const { run } = backupService.getBackup(req.params.backupId);
  restoreService.restoreTenantBackup({
    backupId: req.params.backupId,
    tenantId: run.tenant_id,
    userId: req.user.id
  }).then((restoreRun) => res.status(201).json(restoreRun)).catch(next);
}

/* GET /api/developer/restores */
function listRestoresHandler(req, res) {
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : undefined;
  return res.json(restoreService.listRestores({ tenantId }));
}

/* GET /api/developer/restores/:restoreId */
function getRestoreHandler(req, res) {
  return res.json(restoreService.getRestore(req.params.restoreId));
}

/*
 * POST /api/developer/restores/:restoreId
 * Nova tentativa de uma restauração que falhou: inicia uma nova execução a
 * partir do MESMO backup da execução original.
 */
function retryRestoreHandler(req, res, next) {
  const run = restoreService.getRestore(req.params.restoreId);
  if (['RUNNING', 'ROLLBACK_RUNNING'].includes(run.status)) {
    throw new AppError(409, 'Esta restauração ainda está em andamento.');
  }
  restoreService.restoreTenantBackup({
    backupId: run.backup_id,
    tenantId: run.tenant_id,
    userId: req.user.id
  }).then((newRun) => res.status(201).json({ restored_run: newRun, previous_run: run })).catch(next);
}

/* GET /api/developer/tenants/:tenantId/maintenance */
function getMaintenanceHandler(req, res) {
  return res.json(restoreService.getMaintenanceStatus(req.params.tenantId));
}

function deleteTenantHandler(req, res, next) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (process.env.DEFAULT_TENANT_SLUG && tenant.slug === process.env.DEFAULT_TENANT_SLUG) {
    throw new AppError(400, 'A empresa padrão da plataforma não pode ser excluída.');
  }

  const confirmation = String((req.body && req.body.confirmation) || '');
  if (confirmation !== tenant.name && confirmation !== tenant.slug) {
    throw new AppError(400, 'Digite exatamente o nome ou slug da empresa para confirmar.');
  }

  /* Backup pré-exclusão: se falhar, a exclusão é CANCELADA. O backup gerado
     permanece em disco mesmo após a exclusão (FK ON DELETE SET NULL). */
  (async () => {
    try {
      await backupService.createTenantBackup({
        tenantId: tenant.id,
        backupType: 'TENANT_PRE_DELETE',
        userId: req.user.id
      });
      logActivity(req.user.id, tenant.id, 'TENANT_PRE_DELETE_BACKUP_SUCCESS', `Backup pré-exclusão da empresa "${tenant.name}" gerado`);
    } catch (backupErr) {
      logActivity(req.user.id, tenant.id, 'TENANT_DELETE_BLOCKED_BY_BACKUP_FAILURE', `Exclusão de "${tenant.name}" bloqueada: backup pré-exclusão falhou (${backupErr.message})`);
      if (backupErr instanceof AppError) throw backupErr;
      throw new AppError(409, 'Não foi possível gerar o backup pré-exclusão. A exclusão foi cancelada.');
    }

    /* Exclusão definitiva: apaga o banco de dados exclusivo da empresa e a
       linha em tenants — domínios, usuários e lançamentos financeiros somem
       junto via ON DELETE CASCADE (foreign_keys ligado em openCore()). */
    deleteTenant(tenant.id);
    logActivity(req.user.id, null, 'TENANT_DELETED', `Empresa "${tenant.name}" excluída permanentemente`);
    return res.json({ success: true });
  })().catch(next);
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

/* ---------- Planos e Assinaturas ---------- */

function listPlansHandler(req, res) {
  const plans = planService.getAllPlans().map((p) => {
    const subscriptions = require('../database/coreDatabase').listSubscriptions().filter((s) => s.plan_id === p.id).length;
    return { ...p, subscription_count: subscriptions };
  });
  return res.json(plans);
}

function createPlan(req, res) {
  const plan = planService.createPlan(req.body || {});
  logActivity(req.user.id, null, 'PLAN_CREATED', `Plano ${plan.slug} criado (${plan.name})`);
  return res.status(201).json(plan);
}

function updatePlanHandler(req, res) {
  const plan = planService.updatePlan(req.params.id, req.body || {});
  logActivity(req.user.id, null, 'PLAN_UPDATED', `Plano ${plan.slug} atualizado (${plan.name})`);
  return res.json(plan);
}

function setPlanStatusHandler(req, res) {
  const { is_active } = req.body || {};
  if (typeof is_active !== 'boolean') throw new AppError(400, 'Informe o novo status (is_active).');
  const plan = planService.updatePlan(req.params.id, { is_active });
  logActivity(req.user.id, null, 'PLAN_STATUS_CHANGED', `Plano ${plan.slug} ${is_active ? 'ativado' : 'inativado'}`);
  return res.json(plan);
}

function deletePlanHandler(req, res) {
  const result = planService.deletePlan(req.params.id);
  if (result.deactivated) {
    logActivity(req.user.id, null, 'PLAN_DEACTIVATED', `Plano ${result.plan.slug} em uso foi inativado`);
    return res.json({ success: false, message: 'Plano em uso não pode ser excluído e foi inativado.', plan: result.plan });
  }
  logActivity(req.user.id, null, 'PLAN_DELETED', `Plano ${result.plan.slug} excluído`);
  return res.json({ success: true, plan: result.plan });
}

function listSubscriptionsHandler(req, res) {
  const subscriptions = planService.getAllSubscriptions().map((s) => {
    const tenant = getTenantById(s.tenant_id);
    return {
      ...s,
      effective_monthly_price_cents: planService.getEffectiveMonthlyPrice(s),
      units: tenant ? {
        current: require('../database/coreDatabase').countTenantUnits(tenant.database_name),
        max: s.plan_max_units
      } : null
    };
  });
  return res.json(subscriptions);
}

function getSubscriptionHandler(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  const subscription = planService.getSubscriptionByTenantId(tenant.id);
  const withPlan = planService.getSubscriptionWithPlan(subscription);
  return res.json({
    subscription: withPlan,
    effective_monthly_price_cents: subscription ? planService.getEffectiveMonthlyPrice(subscription) : null,
    units: {
      current: require('../database/coreDatabase').countTenantUnits(tenant.database_name),
      max: subscription ? planService.subscriptionMaxUnitsFor(tenant) : null
    }
  });
}

function updateSubscriptionHandler(req, res) {
  const tenant = getTenantById(req.params.id);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  const subscription = planService.updateTenantSubscription(tenant.id, req.body || {});
  logActivity(req.user.id, tenant.id, 'SUBSCRIPTION_UPDATED', `Assinatura de "${tenant.name}" atualizada`);
  return res.json({
    subscription,
    effective_monthly_price_cents: planService.getEffectiveMonthlyPrice(subscription),
    units: {
      current: require('../database/coreDatabase').countTenantUnits(tenant.database_name),
      max: planService.subscriptionMaxUnitsFor(tenant)
    }
  });
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
    default_tenant_slug: process.env.DEFAULT_TENANT_SLUG || '',
    platform_domain: process.env.PLATFORM_DOMAIN || '',
    platform_server_ip: process.env.PLATFORM_SERVER_IP || '',
    counts: {
      tenants: listTenants().length,
      users: listUsers().length,
      plans: listPlans().length
    }
  });
}

/* ---------- Leads comerciais (site institucional) ---------- */

function listLeadsHandler(req, res) {
  const { status } = req.query;
  const leads = listLeads(status ? { status } : {});
  return res.json(leads);
}

function updateLeadStatusHandler(req, res) {
  const { status } = req.body || {};
  if (!LEAD_STATUSES.includes(status)) {
    throw new AppError(400, `Status inválido. Use um de: ${LEAD_STATUSES.join(', ')}.`);
  }
  const lead = updateLeadStatus(req.params.id, status);
  if (!lead) throw new AppError(404, 'Lead não encontrado.');
  logActivity(req.user.id, null, 'LEAD_STATUS_CHANGED', `Lead #${lead.id} (${lead.name}) marcado como "${status}"`);
  return res.json(lead);
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
  getBackupHandler,
  storageInfoHandler,
  downloadBackupHandler,
  deleteBackupHandler,
  restoreBackupHandler,
  listRestoresHandler,
  getRestoreHandler,
  retryRestoreHandler,
  getMaintenanceHandler,
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
  setPlanStatusHandler,
  deletePlanHandler,
  listSubscriptionsHandler,
  getSubscriptionHandler,
  updateSubscriptionHandler,
  listFinancialHandler,
  createFinancialEntry,
  updateFinancialEntryHandler,
  deleteFinancialEntryHandler,
  logsHandler,
  platformSettings,
  listLeadsHandler,
  updateLeadStatusHandler
};
