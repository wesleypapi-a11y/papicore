/*
 * commercialController.js
 *
 * Endpoints públicos do site institucional (papicore.com.br): planos
 * comerciais somente leitura e o formulário de contato ("leads"). Nunca
 * dependem de tenant/domínio de empresa — atendem o domínio da própria
 * plataforma, então não usam domainTenantMiddleware.
 */

const core = require('../database/coreDatabase');
const planService = require('../services/planService');
const { AppError, isValidPhone, normalizePhone } = require('../utils/helpers');

const SUPPORT_LEVEL_LABELS = {
  standard: 'Suporte padrão',
  priority: 'Suporte prioritário',
  dedicated: 'Suporte dedicado'
};

/*
 * GET /api/public/plans
 * Retorna somente planos ativos e somente os campos comerciais. Nunca expõe
 * assinaturas, tenants ou qualquer campo administrativo.
 */
function listPublicPlans(req, res) {
  const plans = planService.getActivePlans().map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description || '',
    monthly_price_cents: p.monthly_price_cents,
    max_units: p.max_units,
    support_level: p.support_level,
    support_level_label: SUPPORT_LEVEL_LABELS[p.support_level] || p.support_level,
    display_order: p.display_order
  }));
  return res.json(plans);
}

function trimOrNull(value, maxLength) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  return s.slice(0, maxLength);
}

/*
 * Valida e normaliza o corpo do formulário de contato. Lança AppError(400)
 * com uma mensagem clara no primeiro campo inválido.
 */
function validateLeadInput(body) {
  const name = String(body.name || '').trim();
  if (name.length < 2) throw new AppError(400, 'Informe seu nome.');
  if (name.length > 150) throw new AppError(400, 'Nome muito longo.');

  const whatsapp = normalizePhone(body.whatsapp);
  if (!isValidPhone(whatsapp)) throw new AppError(400, 'Informe um WhatsApp válido, com DDD.');

  let units_count = null;
  if (body.units_count !== undefined && body.units_count !== null && body.units_count !== '') {
    units_count = Number(body.units_count);
    if (!Number.isInteger(units_count) || units_count < 1 || units_count > 9999) {
      throw new AppError(400, 'Quantidade de unidades inválida.');
    }
  }

  return {
    name: name.slice(0, 150),
    company_name: trimOrNull(body.company_name, 150),
    whatsapp,
    city: trimOrNull(body.city, 100),
    units_count,
    interested_plan: trimOrNull(body.interested_plan, 60),
    message: trimOrNull(body.message, 2000)
  };
}

/*
 * POST /api/public/contact
 * Salva o lead no banco central da plataforma (nunca no banco de um tenant).
 * Proteções contra spam/duplicidade:
 *   - honeypot (campo "website" deve chegar vazio; bots costumam preenchê-lo)
 *     — nesse caso respondemos sucesso sem gravar nada, sem alertar o bot;
 *   - rate limit por IP (aplicado na rota, ver routes/commercialRoutes.js);
 *   - dedupe: reenvio do mesmo WhatsApp em menos de 20s retorna o lead já
 *     existente em vez de duplicar (clique duplo / retry de rede).
 */
function submitLead(req, res) {
  const body = req.body || {};

  /* Honeypot: campo invisível para humanos. Preenchido = bot. */
  if (String(body.website || '').trim()) {
    return res.status(201).json({ success: true });
  }

  const data = validateLeadInput(body);

  const recent = core.findRecentLeadByWhatsapp(data.whatsapp, 20);
  if (recent) {
    return res.status(201).json({ success: true, id: recent.id });
  }

  const lead = core.insertLead({ ...data, source: 'website' });
  return res.status(201).json({ success: true, id: lead.id });
}

module.exports = { listPublicPlans, submitLead };
