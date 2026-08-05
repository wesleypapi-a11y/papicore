/*
 * contractService.js
 *
 * Regras de negócio dos contratos gerados pelo painel do desenvolvedor.
 *
 * Conceitos centrais:
 *   - contratada: dados fixos da própria PapiCore (contract_company_settings,
 *     linha única), usados em todo contrato gerado, para qualquer empresa;
 *   - modelo: texto editável com placeholders (contract_templates, global,
 *     versionado por família via slug — nunca perde uma versão salva);
 *   - contrato: gerado PARA uma empresa cliente (tenant). O texto final e os
 *     dados usados (contratada/cliente/plano) ficam congelados em *_snapshot
 *     no momento da geração — mudar o cadastro da empresa ou o preço do
 *     plano depois NUNCA altera um contrato já criado.
 *
 * Placeholders: substituição literal de string (nunca eval/Function/template
 * engine) sobre uma lista fechada e validada — um modelo não pode conter um
 * placeholder fora da lista abaixo.
 */

const core = require('../database/coreDatabase');
const { AppError, formatCurrencyFromCents, slugify } = require('../utils/helpers');
const planService = require('./planService');

const CONTRACT_TYPES = ['SUBSCRIPTION', 'RENEWAL', 'ADDENDUM', 'CANCELLATION', 'CUSTOM'];
const CONTRACT_STATUSES = ['DRAFT', 'FINALIZED', 'CANCELLED', 'EXPIRED', 'REPLACED'];
const BILLING_PERIODICITIES = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'CUSTOM'];
const PERIODICITY_LABELS = {
  MONTHLY: 'Mensal',
  QUARTERLY: 'Trimestral',
  SEMIANNUAL: 'Semestral',
  ANNUAL: 'Anual',
  CUSTOM: 'Personalizada'
};
const PERIODICITY_MONTHS = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };

/*
 * Lista fechada de placeholders aceitos em um modelo. Qualquer {{TOKEN}} fora
 * desta lista é rejeitado ao salvar o modelo — nunca vira código executável,
 * só texto substituído por outro texto.
 */
const PLACEHOLDERS = {
  CONTRATADA_RAZAO_SOCIAL: 'Razão social da PapiCore',
  CONTRATADA_NOME_FANTASIA: 'Nome fantasia da PapiCore',
  CONTRATADA_DOCUMENTO: 'CNPJ/CPF da PapiCore',
  CONTRATADA_ENDERECO: 'Endereço completo da PapiCore',
  CONTRATADA_REPRESENTANTE: 'Nome do representante legal da PapiCore',
  CONTRATADA_REPRESENTANTE_DOCUMENTO: 'Documento do representante legal',
  CONTRATADA_EMAIL: 'E-mail da PapiCore',
  CONTRATADA_TELEFONE: 'Telefone da PapiCore',
  CLIENTE_RAZAO_SOCIAL: 'Nome/razão social da empresa cliente',
  CLIENTE_NOME_FANTASIA: 'Nome fantasia da empresa cliente',
  CLIENTE_DOCUMENTO: 'CNPJ/CPF da empresa cliente',
  CLIENTE_EMAIL: 'E-mail comercial da empresa cliente',
  CLIENTE_TELEFONE: 'Telefone da empresa cliente',
  CLIENTE_DOMINIO: 'Domínio principal da empresa cliente',
  CLIENTE_ENDERECO: 'Endereço da empresa cliente',
  CLIENTE_REPRESENTANTE: 'Nome do administrador da empresa cliente',
  CLIENTE_REPRESENTANTE_EMAIL: 'E-mail de acesso do administrador',
  PLANO_NOME: 'Nome do plano contratado',
  PLANO_PRECO: 'Preço mensal do plano (formatado em R$)',
  PLANO_PERIODICIDADE: 'Periodicidade de cobrança deste contrato',
  PLANO_DESCRICAO: 'Descrição do plano',
  PLANO_LIMITE_USUARIOS: 'Limite de usuários do plano',
  PLANO_LIMITE_UNIDADES: 'Limite de unidades do plano',
  PLANO_RECURSOS: 'Resumo de recursos/suporte do plano',
  CONTRATO_NUMERO: 'Número do contrato',
  CONTRATO_DATA: 'Data de geração do contrato',
  CONTRATO_INICIO: 'Data de início da vigência',
  CONTRATO_VENCIMENTO: 'Data de vencimento/fim da vigência',
  CONTRATO_DURACAO_MESES: 'Duração do contrato em meses',
  CONTRATO_VALOR_TOTAL: 'Valor total do contrato (formatado em R$)',
  CONTRATO_FORMA_PAGAMENTO: 'Forma de pagamento',
  CONTRATO_FORO: 'Foro contratual'
};

const REQUIRED_PLACEHOLDERS = [
  'CONTRATADA_RAZAO_SOCIAL', 'CONTRATADA_DOCUMENTO',
  'CLIENTE_RAZAO_SOCIAL', 'CLIENTE_DOCUMENTO', 'CLIENTE_REPRESENTANTE',
  'PLANO_NOME', 'CONTRATO_VALOR_TOTAL', 'CONTRATO_INICIO', 'CONTRATO_VENCIMENTO'
];

const PLACEHOLDER_TOKEN_RE = /\{\{([A-Z_]+)\}\}/g;

function formatDateBR(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR').format(d);
}

function addMonthsToDateStr(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setMonth(d.getMonth() + Number(months || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* Encontra todos os tokens {{FOO}} usados em um texto (sem duplicar). */
function findTokens(content) {
  const found = new Set();
  let match;
  PLACEHOLDER_TOKEN_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_TOKEN_RE.exec(content || ''))) {
    found.add(match[1]);
  }
  return [...found];
}

/* Garante que um modelo só use placeholders da lista fechada. */
function validateTemplateContent(content) {
  const unknown = findTokens(content).filter((token) => !PLACEHOLDERS[token]);
  if (unknown.length) {
    throw new AppError(400, `Placeholder(s) não reconhecido(s): ${unknown.map((t) => `{{${t}}}`).join(', ')}`);
  }
}

/* Substitui todos os placeholders conhecidos por seus valores resolvidos
   (string simples, nunca avaliada como código). Tokens sem valor viram
   string vazia (o chamador decide se isso bloqueia a finalização). */
function resolveContent(content, values) {
  return String(content || '').replace(PLACEHOLDER_TOKEN_RE, (whole, token) => {
    if (!Object.prototype.hasOwnProperty.call(PLACEHOLDERS, token)) return whole;
    const v = values[token];
    return v === null || v === undefined ? '' : String(v);
  });
}

function missingRequiredPlaceholders(values) {
  return REQUIRED_PLACEHOLDERS.filter((key) => !values[key] || !String(values[key]).trim());
}

/* ---------- Snapshots ---------- */

function buildProviderSnapshot() {
  const settings = core.getContractCompanySettings();
  if (!settings) {
    throw new AppError(400, 'Cadastre os dados da contratada (PapiCore) em "Configurações da contratada" antes de gerar um contrato.');
  }
  const addressParts = [
    settings.address,
    settings.address_number,
    settings.address_complement,
    settings.neighborhood,
    settings.city && settings.state ? `${settings.city}/${settings.state}` : (settings.city || settings.state),
    settings.zip_code ? `CEP ${settings.zip_code}` : null
  ].filter(Boolean);
  return {
    legal_name: settings.legal_name || '',
    trade_name: settings.trade_name || '',
    document: settings.document || '',
    address: addressParts.join(', '),
    email: settings.email || '',
    phone: settings.phone || '',
    representative_name: settings.legal_representative_name || '',
    representative_document: settings.legal_representative_document || '',
    representative_role: settings.legal_representative_role || '',
    default_jurisdiction: settings.default_jurisdiction || '',
    logo_path: settings.logo_path || null,
    signature_path: settings.signature_path || null
  };
}

function buildClientSnapshot(tenant) {
  const owner = core.getTenantOwner(tenant.id);
  const domains = core.listDomains(tenant.id);
  const primaryDomain = domains.find((d) => d.is_primary) || domains[0] || null;
  return {
    tenant_id: tenant.id,
    legal_name: tenant.name || '',
    trade_name: tenant.name || '',
    document: tenant.document || '',
    email: tenant.email || '',
    phone: tenant.phone || '',
    domain: primaryDomain ? primaryDomain.domain : '',
    address: '',
    representative_name: owner ? owner.name : '',
    representative_email: owner ? owner.email : ''
  };
}

function buildPlanSnapshot(plan) {
  if (!plan) return null;
  const featureParts = [];
  if (plan.description) featureParts.push(plan.description);
  featureParts.push(`Suporte ${planService.SUPPORT_LEVELS.includes(plan.support_level) ? supportLevelLabel(plan.support_level) : plan.support_level}`);
  return {
    plan_id: plan.id,
    name: plan.name,
    slug: plan.slug,
    description: plan.description || '',
    monthly_price_cents: plan.monthly_price_cents,
    max_units: plan.max_units,
    support_level: plan.support_level,
    features_summary: featureParts.join(' — ')
  };
}

function supportLevelLabel(level) {
  return { standard: 'Padrão', priority: 'Prioritário', dedicated: 'Dedicado', premium: 'Premium' }[level] || level;
}

/* Monta o mapa final {TOKEN: valor} a partir dos três snapshots + dados do
   próprio contrato (número, datas, valores). */
function buildPlaceholderValues({ provider, client, plan, contractNumber, contractDate, startDate, endDate, durationMonths, totalCents, billingPeriodicity, paymentMethod, jurisdiction }) {
  return {
    CONTRATADA_RAZAO_SOCIAL: provider.legal_name,
    CONTRATADA_NOME_FANTASIA: provider.trade_name,
    CONTRATADA_DOCUMENTO: provider.document,
    CONTRATADA_ENDERECO: provider.address,
    CONTRATADA_REPRESENTANTE: provider.representative_name,
    CONTRATADA_REPRESENTANTE_DOCUMENTO: provider.representative_document,
    CONTRATADA_EMAIL: provider.email,
    CONTRATADA_TELEFONE: provider.phone,
    CLIENTE_RAZAO_SOCIAL: client.legal_name,
    CLIENTE_NOME_FANTASIA: client.trade_name,
    CLIENTE_DOCUMENTO: client.document,
    CLIENTE_EMAIL: client.email,
    CLIENTE_TELEFONE: client.phone,
    CLIENTE_DOMINIO: client.domain,
    CLIENTE_ENDERECO: client.address,
    CLIENTE_REPRESENTANTE: client.representative_name,
    CLIENTE_REPRESENTANTE_EMAIL: client.representative_email,
    PLANO_NOME: plan ? plan.name : '',
    PLANO_PRECO: plan ? formatCurrencyFromCents(plan.monthly_price_cents) : '',
    PLANO_PERIODICIDADE: PERIODICITY_LABELS[billingPeriodicity] || billingPeriodicity,
    PLANO_DESCRICAO: plan ? plan.description : '',
    PLANO_LIMITE_USUARIOS: 'Não aplicável neste plano',
    PLANO_LIMITE_UNIDADES: plan && plan.max_units != null ? String(plan.max_units) : 'Ilimitado',
    PLANO_RECURSOS: plan ? plan.features_summary : '',
    CONTRATO_NUMERO: contractNumber || '',
    CONTRATO_DATA: formatDateBR(contractDate),
    CONTRATO_INICIO: formatDateBR(startDate),
    CONTRATO_VENCIMENTO: formatDateBR(endDate),
    CONTRATO_DURACAO_MESES: durationMonths != null ? String(durationMonths) : '',
    CONTRATO_VALOR_TOTAL: totalCents != null ? formatCurrencyFromCents(totalCents) : '',
    CONTRATO_FORMA_PAGAMENTO: paymentMethod || '',
    CONTRATO_FORO: jurisdiction || provider.default_jurisdiction || ''
  };
}

/* ---------- Cálculo financeiro (sempre em centavos, nunca float) ---------- */

function computeFinancials({ planPriceCents, billingPeriodicity, customSubtotalCents, discountCents, implementationFeeCents }) {
  if (!BILLING_PERIODICITIES.includes(billingPeriodicity)) {
    throw new AppError(400, 'Periodicidade de cobrança inválida.');
  }
  let subtotal;
  if (billingPeriodicity === 'CUSTOM') {
    subtotal = Number(customSubtotalCents);
    if (!Number.isInteger(subtotal) || subtotal < 0) {
      throw new AppError(400, 'Informe um valor personalizado válido para a periodicidade "Personalizada".');
    }
  } else {
    const multiplier = PERIODICITY_MONTHS[billingPeriodicity];
    subtotal = Math.round(Number(planPriceCents || 0) * multiplier);
  }
  const discount = Number(discountCents) > 0 ? Math.round(Number(discountCents)) : 0;
  const implementationFee = Number(implementationFeeCents) > 0 ? Math.round(Number(implementationFeeCents)) : 0;
  const total = Math.max(0, subtotal - discount) + implementationFee;
  return { subtotal_cents: subtotal, discount_cents: discount, implementation_fee_cents: implementationFee, total_cents: total };
}

/* ---------- Carregamento/validação de entrada comum a preview e criação ---------- */

function loadContext(input) {
  const tenant = core.getTenantById(Number(input.tenant_id));
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const contractType = String(input.contract_type || 'SUBSCRIPTION').toUpperCase();
  if (!CONTRACT_TYPES.includes(contractType)) throw new AppError(400, 'Tipo de contrato inválido.');

  let template = null;
  if (input.template_id) {
    template = core.getContractTemplate(Number(input.template_id));
    if (!template) throw new AppError(404, 'Modelo de contrato não encontrado.');
  } else {
    const current = core.listCurrentContractTemplates().find((t) => t.contract_type === contractType) || core.listCurrentContractTemplates()[0];
    template = current || null;
  }
  if (!template) throw new AppError(400, 'Nenhum modelo de contrato cadastrado. Cadastre um modelo antes de gerar contratos.');

  let plan = null;
  if (input.plan_id) {
    plan = planService.getPlanById(Number(input.plan_id));
  } else {
    const subscription = core.getSubscriptionByTenantId(tenant.id);
    plan = subscription && subscription.plan_id ? planService.getPlanById(subscription.plan_id) : null;
  }

  const billingPeriodicity = String(input.billing_periodicity || 'MONTHLY').toUpperCase();
  const startDate = input.start_date || null;
  let endDate = input.end_date || null;
  const durationMonths = input.duration_months !== undefined && input.duration_months !== null && input.duration_months !== ''
    ? Number(input.duration_months)
    : null;
  if (!endDate && startDate && durationMonths) {
    endDate = addMonthsToDateStr(startDate, durationMonths);
  }

  const financials = computeFinancials({
    planPriceCents: plan ? plan.monthly_price_cents : 0,
    billingPeriodicity,
    customSubtotalCents: input.subtotal_cents,
    discountCents: input.discount_cents,
    implementationFeeCents: input.implementation_fee_cents
  });

  const provider = buildProviderSnapshot();
  const client = buildClientSnapshot(tenant);
  const planSnapshot = buildPlanSnapshot(plan);

  return { tenant, template, plan, planSnapshot, provider, client, contractType, billingPeriodicity, startDate, endDate, durationMonths, financials, input };
}

/* Gera uma prévia (sem persistir nada) — usado em POST /contracts/preview. */
function previewContract(input) {
  const ctx = loadContext(input);
  const contractDate = new Date().toISOString().slice(0, 10);
  const values = buildPlaceholderValues({
    provider: ctx.provider,
    client: ctx.client,
    plan: ctx.planSnapshot,
    contractNumber: '(gerado ao salvar)',
    contractDate,
    startDate: ctx.startDate,
    endDate: ctx.endDate,
    durationMonths: ctx.durationMonths,
    totalCents: ctx.financials.total_cents,
    billingPeriodicity: ctx.billingPeriodicity,
    paymentMethod: input.payment_method,
    jurisdiction: input.jurisdiction
  });
  const content = resolveContent(ctx.template.content, values);
  return {
    content,
    template: ctx.template,
    plan: ctx.planSnapshot,
    financials: ctx.financials,
    missing_required: missingRequiredPlaceholders(values),
    resolved_values: values
  };
}

/* Cria o rascunho (DRAFT) definitivo: reserva número + insere, tudo na mesma
   transação (nunca count(*) + 1). */
function createDraftContract(input, userId, links = {}) {
  const ctx = loadContext(input);
  const year = new Date().getFullYear();
  const contractDate = new Date().toISOString().slice(0, 10);

  const tx = core.getCoreDb().transaction(() => {
    const contractNumber = core.reserveContractNumber(year);
    const values = buildPlaceholderValues({
      provider: ctx.provider,
      client: ctx.client,
      plan: ctx.planSnapshot,
      contractNumber,
      contractDate,
      startDate: ctx.startDate,
      endDate: ctx.endDate,
      durationMonths: ctx.durationMonths,
      totalCents: ctx.financials.total_cents,
      billingPeriodicity: ctx.billingPeriodicity,
      paymentMethod: input.payment_method,
      jurisdiction: input.jurisdiction
    });
    const content = resolveContent(ctx.template.content, values);
    return core.insertContract({
      tenant_id: ctx.tenant.id,
      template_id: ctx.template.id,
      template_version: ctx.template.version,
      contract_number: contractNumber,
      year,
      contract_type: ctx.contractType,
      status: 'DRAFT',
      title: input.title || ctx.template.name,
      content,
      provider_snapshot_json: JSON.stringify(ctx.provider),
      client_snapshot_json: JSON.stringify(ctx.client),
      plan_snapshot_json: ctx.planSnapshot ? JSON.stringify(ctx.planSnapshot) : null,
      client_name: ctx.client.legal_name,
      client_document: ctx.client.document || null,
      client_email: ctx.client.email || null,
      client_phone: ctx.client.phone || null,
      plan_name: ctx.planSnapshot ? ctx.planSnapshot.name : null,
      plan_price_cents: ctx.planSnapshot ? ctx.planSnapshot.monthly_price_cents : null,
      billing_periodicity: ctx.billingPeriodicity,
      subtotal_cents: ctx.financials.subtotal_cents,
      discount_cents: ctx.financials.discount_cents,
      implementation_fee_cents: ctx.financials.implementation_fee_cents,
      total_cents: ctx.financials.total_cents,
      payment_method: input.payment_method || null,
      billing_day: input.billing_day ? Number(input.billing_day) : null,
      start_date: ctx.startDate,
      end_date: ctx.endDate,
      duration_months: ctx.durationMonths,
      jurisdiction: input.jurisdiction || ctx.provider.default_jurisdiction || null,
      notes: input.notes || null,
      signature_status: 'PENDING',
      created_by_user_id: userId,
      previous_contract_id: links.previous_contract_id || null,
      replaces_contract_id: links.replaces_contract_id || null
    });
  });
  return tx();
}

function getContractOr404(id) {
  const contract = core.getContractById(Number(id));
  if (!contract) throw new AppError(404, 'Contrato não encontrado.');
  return contract;
}

function assertDraft(contract) {
  if (contract.status !== 'DRAFT') {
    throw new AppError(409, 'Este contrato já foi finalizado e não pode mais ser editado diretamente. Gere um aditivo, uma renovação ou duplique como novo rascunho.');
  }
}

/* Edição livre do rascunho (texto revisado manualmente, datas, valores). */
function updateDraftContract(id, fields) {
  const contract = getContractOr404(id);
  assertDraft(contract);
  const patch = {};
  ['title', 'content', 'start_date', 'end_date', 'duration_months', 'billing_periodicity',
    'discount_cents', 'implementation_fee_cents', 'payment_method', 'billing_day', 'jurisdiction', 'notes'
  ].forEach((key) => {
    if (fields[key] !== undefined) patch[key] = fields[key];
  });
  if (patch.subtotal_cents === undefined && (patch.discount_cents !== undefined || patch.implementation_fee_cents !== undefined)) {
    const discount = patch.discount_cents !== undefined ? Number(patch.discount_cents) : contract.discount_cents;
    const fee = patch.implementation_fee_cents !== undefined ? Number(patch.implementation_fee_cents) : contract.implementation_fee_cents;
    patch.total_cents = Math.max(0, contract.subtotal_cents - discount) + fee;
  }
  return core.updateContract(id, patch);
}

function contractHasUnresolvedPlaceholders(content) {
  PLACEHOLDER_TOKEN_RE.lastIndex = 0;
  return PLACEHOLDER_TOKEN_RE.test(content || '');
}

function validateFinalizable(contract) {
  assertDraft(contract);
  if (contractHasUnresolvedPlaceholders(contract.content)) {
    throw new AppError(400, 'O texto do contrato ainda contém um placeholder não resolvido. Revise o texto antes de finalizar.');
  }
  const missing = [];
  if (!contract.client_name) missing.push('nome da empresa');
  if (!contract.client_document) missing.push('documento da empresa');
  if (!contract.plan_name) missing.push('plano');
  if (!contract.total_cents && contract.total_cents !== 0) missing.push('valor total');
  if (!contract.start_date) missing.push('data de início');
  if (!contract.end_date) missing.push('data de vencimento');
  const provider = JSON.parse(contract.provider_snapshot_json || '{}');
  if (!provider.representative_name) missing.push('representante da contratada');
  if (missing.length) {
    throw new AppError(400, `Não é possível finalizar: preencha ${missing.join(', ')}.`);
  }
}

module.exports = {
  CONTRACT_TYPES,
  CONTRACT_STATUSES,
  BILLING_PERIODICITIES,
  PERIODICITY_LABELS,
  PLACEHOLDERS,
  REQUIRED_PLACEHOLDERS,
  formatDateBR,
  findTokens,
  validateTemplateContent,
  resolveContent,
  missingRequiredPlaceholders,
  buildProviderSnapshot,
  buildClientSnapshot,
  buildPlanSnapshot,
  computeFinancials,
  loadContext,
  previewContract,
  createDraftContract,
  getContractOr404,
  assertDraft,
  updateDraftContract,
  contractHasUnresolvedPlaceholders,
  validateFinalizable
};
