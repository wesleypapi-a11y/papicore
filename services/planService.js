/*
 * planService.js
 *
 * Regras centralizadas de planos e assinaturas da plataforma. O painel do
 * desenvolvedor é a única origem de escrita de planos/assinaturas; o painel
 * do tenant (admin) apenas consulta. Valores monetários sempre em centavos.
 */

const core = require('../database/coreDatabase');
const { AppError, slugify, todayStr, toDateStr, addDays } = require('../utils/helpers');

const SUBSCRIPTION_STATUSES = ['trial', 'active', 'overdue', 'suspended', 'canceled'];
const SUPPORT_LEVELS = ['standard', 'priority', 'dedicated', 'premium'];

/* ---------- Planos ---------- */

function getAllPlans() {
  return core.listPlans();
}

function getActivePlans() {
  return core.listPlans().filter((p) => p.is_active);
}

function getPlanById(id) {
  const plan = core.getPlanById(id);
  if (!plan) throw new AppError(404, 'Plano não encontrado.');
  return plan;
}

function validatePlanInput(data, { partial = false } = {}) {
  if (!partial || data.name !== undefined) {
    const name = String(data.name || '').trim();
    if (!name) throw new AppError(400, 'Informe o nome do plano.');
  }
  if (!partial || data.monthly_price_cents !== undefined) {
    const price = Number(data.monthly_price_cents);
    if (!Number.isInteger(price) || price < 0) {
      throw new AppError(400, 'Preço mensal deve ser um valor inteiro em centavos (ex.: 9790 para R$ 97,90).');
    }
  }
  if (data.max_units !== undefined && data.max_units !== null && data.max_units !== '') {
    const units = Number(data.max_units);
    if (!Number.isInteger(units) || units < 1) {
      throw new AppError(400, 'Limite de unidades deve ser um inteiro maior que zero (vazio = ilimitado).');
    }
  }
  if (data.support_level !== undefined && !SUPPORT_LEVELS.includes(data.support_level)) {
    throw new AppError(400, 'Nível de suporte inválido.');
  }
  if (data.is_active !== undefined && data.is_active !== null && typeof data.is_active !== 'boolean') {
    throw new AppError(400, 'Status do plano inválido.');
  }
  if (data.slug !== undefined && data.slug !== null && String(data.slug).trim()) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(data.slug).trim())) {
      throw new AppError(400, 'Slug inválido: use apenas letras minúsculas, números e hífens.');
    }
  }
}

function createPlan(data) {
  validatePlanInput(data);
  const slug = String(data.slug || slugify(data.name)).trim() || slugify(data.name);
  if (core.getPlanBySlug(slug)) throw new AppError(409, 'Já existe um plano com esse slug.');
  const plan = core.insertPlan({
    name: String(data.name).trim(),
    slug,
    description: data.description ? String(data.description).trim() : null,
    monthly_price_cents: Number(data.monthly_price_cents),
    max_units: data.max_units === null || data.max_units === undefined || data.max_units === '' ? null : Number(data.max_units),
    support_level: data.support_level || 'standard',
    display_order: data.display_order === undefined || data.display_order === null ? nextPlanDisplayOrder() : Number(data.display_order),
    is_active: data.is_active === undefined ? true : Boolean(data.is_active)
  });
  return plan;
}

function updatePlan(id, data) {
  const existing = getPlanById(id);
  validatePlanInput(data, { partial: true });
  const slug = data.slug !== undefined ? String(data.slug).trim() : existing.slug;
  if (slug && slug !== existing.slug) {
    const clash = core.getPlanBySlug(slug);
    if (clash && clash.id !== existing.id) throw new AppError(409, 'Já existe um plano com esse slug.');
  }
  return core.updatePlan(id, {
    name: data.name !== undefined ? String(data.name).trim() : undefined,
    slug: slug || undefined,
    description: data.description !== undefined ? (data.description ? String(data.description).trim() : null) : undefined,
    monthly_price_cents: data.monthly_price_cents !== undefined ? Number(data.monthly_price_cents) : undefined,
    max_units: data.max_units === '' ? null : data.max_units,
    support_level: data.support_level,
    display_order: data.display_order !== undefined ? Number(data.display_order) : undefined,
    is_active: data.is_active !== undefined ? Boolean(data.is_active) : undefined
  });
}

/* Inativa em vez de apagar quando o plano está em uso; planos sem assinatura
   podem ser apagados de verdade. */
function deletePlan(id) {
  const existing = getPlanById(id);
  const result = core.deletePlan(id);
  if (result.inUse) {
    core.updatePlan(id, { is_active: 0 });
    return { deleted: false, deactivated: true, plan: core.getPlanById(id) };
  }
  return { deleted: true, deactivated: false, plan: existing };
}

/* ---------- Assinaturas ---------- */

function getAllSubscriptions() {
  return core.listSubscriptions();
}

function getSubscriptionByTenantId(tenantId) {
  return core.getSubscriptionByTenantId(tenantId);
}

function getSubscriptionWithPlan(subscription) {
  if (!subscription) return null;
  return {
    ...subscription,
    plan: subscription.plan_id ? core.getPlanById(subscription.plan_id) : null
  };
}

function validateSubscriptionInput(data, { partial = false } = {}) {
  if (!partial || data.plan_id !== undefined) {
    const plan = core.getPlanById(data.plan_id);
    if (!plan) throw new AppError(400, 'Plano inválido.');
  }
  if (data.custom_monthly_price_cents !== undefined && data.custom_monthly_price_cents !== null && data.custom_monthly_price_cents !== '') {
    const price = Number(data.custom_monthly_price_cents);
    if (!Number.isInteger(price) || price < 0) {
      throw new AppError(400, 'Preço customizado deve ser um valor inteiro em centavos.');
    }
  }
  if (data.status !== undefined && !SUBSCRIPTION_STATUSES.includes(data.status)) {
    throw new AppError(400, 'Status de assinatura inválido.');
  }
}

function getEffectiveMonthlyPrice(subscription) {
  if (!subscription) return null;
  if (subscription.custom_monthly_price_cents !== null && subscription.custom_monthly_price_cents !== undefined) {
    return Number(subscription.custom_monthly_price_cents);
  }
  const plan = subscription.plan_id ? core.getPlanById(subscription.plan_id) : null;
  return plan ? Number(plan.monthly_price_cents) : null;
}

/*
 * Atualiza a assinatura de uma empresa pelo painel do desenvolvedor e mantém
 * o espelho "tenants.plan" (slug em texto) sempre sincronizado para não
 * quebrar o tenantMiddleware e as telas que ainda leem tenants.plan.
 */
function updateTenantSubscription(tenantId, data) {
  const tenant = core.getTenantById(tenantId);
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  const existing = core.getSubscriptionByTenantId(tenantId);
  validateSubscriptionInput(data, { partial: true });

  const next = {
    plan_id: data.plan_id !== undefined ? data.plan_id : existing?.plan_id,
    custom_monthly_price_cents: data.custom_monthly_price_cents !== undefined ? (data.custom_monthly_price_cents === '' || data.custom_monthly_price_cents === null ? null : Number(data.custom_monthly_price_cents)) : undefined,
    status: data.status !== undefined ? data.status : undefined,
    billing_day: data.billing_day !== undefined ? (data.billing_day === '' || data.billing_day === null ? null : Number(data.billing_day)) : undefined,
    started_at: data.started_at || undefined,
    current_period_start: data.current_period_start || undefined,
    current_period_end: data.current_period_end || undefined,
    last_payment_at: data.last_payment_at || undefined,
    next_due_date: data.next_due_date || undefined,
    suspended_at: data.suspended_at || undefined,
    canceled_at: data.canceled_at || undefined,
    notes: data.notes !== undefined ? (data.notes || null) : undefined
  };

  const subscription = core.upsertSubscription(tenantId, next);

  if (subscription.plan_id) {
    const plan = core.getPlanById(subscription.plan_id);
    if (plan && plan.slug !== tenant.plan) {
      core.updateTenant(tenantId, { plan: plan.slug });
    }
  }
  return getSubscriptionWithPlan(subscription);
}

function createTenantSubscription(tenantId, data) {
  return updateTenantSubscription(tenantId, data);
}

/* ---------- Limites ---------- */

/* Uso atual: unidades criadas no banco da empresa. */
function getTenantUnitUsage(tenant) {
  const count = core.countTenantUnits(tenant.database_name);
  return { currentUnits: count, maxUnits: subscriptionMaxUnitsFor(tenant) };
}

function subscriptionMaxUnitsFor(tenant) {
  const subscription = core.getSubscriptionByTenantId(tenant.id);
  if (!subscription) return null;
  const plan = subscription.plan_id ? core.getPlanById(subscription.plan_id) : null;
  return plan ? plan.max_units : null;
}

function isSubscriptionActive(subscription) {
  if (!subscription) return false;
  if (subscription.status === 'canceled' || subscription.status === 'suspended') return false;
  if (subscription.status === 'trial') return true;
  if (subscription.status === 'overdue') return false;
  return true;
}

/*
 * Decide se a empresa ainda pode criar unidade. Regras:
 *   - assinatura cancelada/suspensa/vencida bloqueia criação;
 *   - plano sem limite (max_units = null) libera;
 *   - unidades atuais >= limite bloqueia.
 * Lança AppError com payload rico quando bloqueado.
 */
function canTenantCreateUnit(tenant) {
  const subscription = core.getSubscriptionByTenantId(tenant.id);
  if (!subscription) {
    throw new AppError(403, 'Esta empresa não possui assinatura ativa. Contate o suporte.', {
      code: 'SUBSCRIPTION_NOT_FOUND',
      currentUnits: core.countTenantUnits(tenant.database_name),
      maxUnits: null,
      plan: null
    });
  }
  if (!isSubscriptionActive(subscription)) {
    const plan = subscription.plan_id ? core.getPlanById(subscription.plan_id) : null;
    throw new AppError(403, `A assinatura desta empresa está ${subscription.status}. Contate o suporte para reativar.`, {
      code: 'SUBSCRIPTION_NOT_ACTIVE',
      status: subscription.status,
      currentUnits: core.countTenantUnits(tenant.database_name),
      maxUnits: plan ? plan.max_units : null,
      plan: plan ? plan.slug : null
    });
  }
  const plan = subscription.plan_id ? core.getPlanById(subscription.plan_id) : null;
  if (!plan) {
    throw new AppError(403, 'Esta empresa não possui um plano válido. Contate o suporte.', {
      code: 'PLAN_NOT_FOUND',
      currentUnits: core.countTenantUnits(tenant.database_name),
      maxUnits: null,
      plan: null
    });
  }
  const currentUnits = core.countTenantUnits(tenant.database_name);
  const maxUnits = plan.max_units;
  if (maxUnits === null || maxUnits === undefined) {
    return { allowed: true, currentUnits, maxUnits: null, plan: plan.slug };
  }
  if (currentUnits >= maxUnits) {
    throw new AppError(403, `Limite de unidades do plano ${plan.name} atingido (${maxUnits}).`, {
      code: 'PLAN_UNIT_LIMIT_REACHED',
      currentUnits,
      maxUnits,
      plan: plan.slug
    });
  }
  return { allowed: true, currentUnits, maxUnits, plan: plan.slug };
}

function nextPlanDisplayOrder() {
  const plans = core.listPlans();
  return plans.reduce((max, p) => Math.max(max, p.display_order || 0), 0) + 1;
}

module.exports = {
  SUBSCRIPTION_STATUSES,
  SUPPORT_LEVELS,
  getAllPlans,
  getActivePlans,
  getPlanById,
  createPlan,
  updatePlan,
  deletePlan,
  getAllSubscriptions,
  getSubscriptionByTenantId,
  getSubscriptionWithPlan,
  updateTenantSubscription,
  createTenantSubscription,
  getEffectiveMonthlyPrice,
  getTenantUnitUsage,
  subscriptionMaxUnitsFor,
  canTenantCreateUnit
};
