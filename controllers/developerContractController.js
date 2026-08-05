/*
 * developerContractController.js
 *
 * Controladores da aba "Contratos" do painel do desenvolvedor. Cobre
 * configurações da contratada (PapiCore), modelos versionados e o ciclo de
 * vida do contrato (rascunho -> finalizado -> cancelado/renovado/aditivado).
 *
 * Todas as rotas já passam por requireDeveloper (aplicado em
 * routes/developerRoutes.js antes deste controller ser alcançado).
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const core = require('../database/coreDatabase');
const { AppError, isValidEmail, slugify } = require('../utils/helpers');
const {
  platformAssetsDir,
  storedPlatformFilePath,
  removePlatformAssetFile,
  unlinkIfExists,
  isAllowedMime,
  extensionFor,
  sniffMime
} = require('../utils/assetStorage');
const contractStorage = require('../utils/contractStorage');
const contractService = require('../services/contractService');
const contractPdfService = require('../services/contractPdfService');

const LOGO_KIND = 'contract_logo';
const SIGNATURE_KIND = 'contract_signature';
const IMAGE_LIMIT = 3 * 1024 * 1024; /* 3 MB, mesmo limite usado na logo da tela de login */

function safeLog(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[papi-core] Falha ao registrar log de auditoria (contratos):', err.message);
  }
}

function contractWithTenant(contract) {
  const tenant = core.getTenantById(contract.tenant_id);
  return {
    ...contract,
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null
  };
}

/* ---------- Configurações da contratada ---------- */

function getCompanySettingsHandler(req, res) {
  const settings = core.getContractCompanySettings();
  return res.json({
    ...(settings || {}),
    has_logo: Boolean(storedPlatformFilePath(LOGO_KIND)),
    has_signature: Boolean(storedPlatformFilePath(SIGNATURE_KIND))
  });
}

function validateCompanySettingsInput(body) {
  const fields = {};
  const allowed = [
    'legal_name', 'trade_name', 'document', 'address', 'address_number', 'address_complement',
    'neighborhood', 'city', 'state', 'zip_code', 'phone', 'email',
    'legal_representative_name', 'legal_representative_document', 'legal_representative_role',
    'default_jurisdiction'
  ];
  allowed.forEach((key) => {
    if (body[key] !== undefined) fields[key] = String(body[key] || '').trim() || null;
  });
  if (fields.email && !isValidEmail(fields.email)) {
    throw new AppError(400, 'Informe um e-mail válido para a contratada.');
  }
  return fields;
}

function updateCompanySettingsHandler(req, res) {
  const fields = validateCompanySettingsInput(req.body || {});
  const settings = core.upsertContractCompanySettings(fields, req.user.id);
  safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_COMPANY_SETTINGS_UPDATED', 'Dados da contratada atualizados'));
  return res.json(settings);
}

function imageMulter(kind) {
  return multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        try { cb(null, platformAssetsDir()); } catch (err) { cb(err); }
      },
      filename(req, file, cb) {
        const ext = extensionFor('logo', file.mimetype);
        cb(null, kind + ext);
      }
    }),
    limits: { fileSize: IMAGE_LIMIT },
    fileFilter(req, file, cb) {
      if (!isAllowedMime('logo', file.mimetype)) return cb(new AppError(400, 'Formato de imagem não suportado (use PNG, JPG ou WEBP).'));
      cb(null, true);
    }
  }).single('file');
}

/* Upload de logo/assinatura da contratada — mesmo fluxo para os dois
   (multer -> valida o conteúdo real do arquivo com sniffMime -> substitui
   a versão anterior). Reaproveita o mapa de mimes de "logo" (PNG/JPG/WEBP
   servem bem para uma assinatura escaneada também). */
function uploadCompanyImage(kind, actionLabel) {
  return (req, res, next) => {
    const upload = imageMulter(kind);
    upload(req, res, (err) => {
      if (err) return next(err);
      if (!req.file) return next(new AppError(400, 'Envie um arquivo.'));
      const savedPath = req.file.path;
      const sniffed = sniffMime(savedPath);
      if (!sniffed || !extensionFor('logo', sniffed)) {
        unlinkIfExists(savedPath);
        return next(new AppError(400, 'O conteúdo do arquivo não corresponde a uma imagem válida.'));
      }
      const old = storedPlatformFilePath(kind);
      if (old && path.resolve(old) !== path.resolve(savedPath)) unlinkIfExists(old);
      safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_COMPANY_SETTINGS_UPDATED', `${actionLabel} atualizada`));
      return res.status(201).json({ success: true });
    });
  };
}

/* GET .../company-settings/{logo,signature} — protegida por requireDeveloper
   (não é exibida em tela pública), por isso o frontend busca via fetch +
   Authorization e monta um blob local, como já é feito para o download de
   backups. */
function serveCompanyImage(kind, notFoundMessage) {
  return (req, res) => {
    const file = storedPlatformFilePath(kind);
    if (!file) throw new AppError(404, notFoundMessage);
    res.set('Cache-Control', 'private, max-age=300');
    return res.sendFile(file);
  };
}

function removeCompanyImage(kind, actionLabel) {
  return (req, res) => {
    removePlatformAssetFile(kind);
    safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_COMPANY_SETTINGS_UPDATED', `${actionLabel} removida`));
    return res.json({ success: true });
  };
}

const uploadCompanyLogo = uploadCompanyImage(LOGO_KIND, 'Logo de contratos');
const serveCompanyLogo = serveCompanyImage(LOGO_KIND, 'Nenhuma logo cadastrada.');
const removeCompanyLogo = removeCompanyImage(LOGO_KIND, 'Logo de contratos');

const uploadCompanySignature = uploadCompanyImage(SIGNATURE_KIND, 'Assinatura de contratos');
const serveCompanySignature = serveCompanyImage(SIGNATURE_KIND, 'Nenhuma assinatura cadastrada.');
const removeCompanySignature = removeCompanyImage(SIGNATURE_KIND, 'Assinatura de contratos');

/* ---------- Modelos ---------- */

function listTemplatesHandler(req, res) {
  return res.json(core.listContractTemplates());
}

function listCurrentTemplatesHandler(req, res) {
  return res.json(core.listCurrentContractTemplates());
}

function getTemplateHandler(req, res) {
  const template = core.getContractTemplate(Number(req.params.id));
  if (!template) throw new AppError(404, 'Modelo não encontrado.');
  return res.json({ ...template, versions: core.listContractTemplateVersions(template.slug) });
}

function uniqueSlug(base) {
  let candidate = base || 'modelo';
  let attempt = 1;
  while (core.contractTemplateSlugExists(candidate)) {
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }
  return candidate;
}

function validateTemplateBody(body, { requireName = true } = {}) {
  const name = String(body.name || '').trim();
  if (requireName && name.length < 2) throw new AppError(400, 'Informe o nome do modelo.');
  const contractType = String(body.contract_type || 'SUBSCRIPTION').toUpperCase();
  if (!contractService.CONTRACT_TYPES.includes(contractType)) throw new AppError(400, 'Tipo de contrato inválido.');
  const content = String(body.content || '');
  contractService.validateTemplateContent(content);
  return { name, contractType, content, description: body.description ? String(body.description).trim() : null };
}

function createTemplateHandler(req, res) {
  const { name, contractType, content, description } = validateTemplateBody(req.body || {});
  const slug = uniqueSlug(slugify(req.body.slug || name));
  const template = core.insertContractTemplate({
    slug, name, description, contract_type: contractType, content, created_by_user_id: req.user.id
  });
  safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_TEMPLATE_CREATED', `Modelo "${name}" criado`));
  return res.status(201).json(template);
}

/* Nunca sobrescreve o conteúdo salvo: qualquer alteração cria uma nova
   versão da mesma família (mesmo slug). */
function updateTemplateHandler(req, res) {
  const existing = core.getContractTemplate(Number(req.params.id));
  if (!existing) throw new AppError(404, 'Modelo não encontrado.');
  const { name, contractType, content, description } = validateTemplateBody(req.body || {});
  const template = core.createContractTemplateVersion(existing.slug, {
    name, description, contract_type: contractType, content, created_by_user_id: req.user.id
  });
  safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_TEMPLATE_UPDATED', `Modelo "${name}" atualizado (versão ${template.version})`));
  return res.json(template);
}

function duplicateTemplateHandler(req, res) {
  const source = core.getContractTemplate(Number(req.params.id));
  if (!source) throw new AppError(404, 'Modelo não encontrado.');
  const name = String((req.body && req.body.name) || `${source.name} (cópia)`).trim();
  const slug = uniqueSlug(slugify(name));
  const template = core.insertContractTemplate({
    slug, name, description: source.description, contract_type: source.contract_type, content: source.content, created_by_user_id: req.user.id
  });
  safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_TEMPLATE_CREATED', `Modelo "${name}" criado a partir de "${source.name}"`));
  return res.status(201).json(template);
}

function setTemplateDefaultHandler(req, res) {
  const template = core.setContractTemplateDefault(Number(req.params.id));
  if (!template) throw new AppError(404, 'Modelo não encontrado.');
  safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_TEMPLATE_UPDATED', `Versão ${template.version} de "${template.name}" marcada como padrão`));
  return res.json(template);
}

function setTemplateActiveHandler(req, res) {
  const template = core.getContractTemplate(Number(req.params.id));
  if (!template) throw new AppError(404, 'Modelo não encontrado.');
  const isActive = Boolean(req.body && req.body.is_active);
  const versions = core.setContractTemplateActive(template.slug, isActive);
  safeLog(() => core.logActivity(req.user.id, null, 'CONTRACT_TEMPLATE_UPDATED', `Modelo "${template.name}" ${isActive ? 'ativado' : 'inativado'}`));
  return res.json(versions);
}

/* ---------- Metadados (enums usados pelo formulário) ---------- */

function contractsMetaHandler(req, res) {
  return res.json({
    contract_types: contractService.CONTRACT_TYPES,
    statuses: contractService.CONTRACT_STATUSES,
    billing_periodicities: contractService.BILLING_PERIODICITIES,
    periodicity_labels: contractService.PERIODICITY_LABELS,
    placeholders: contractService.PLACEHOLDERS,
    required_placeholders: contractService.REQUIRED_PLACEHOLDERS
  });
}

/* ---------- Contratos ---------- */

function listContractsHandler(req, res) {
  const { tenant_id, status, contract_type, q } = req.query;
  const filters = {};
  if (tenant_id) filters.tenant_id = Number(tenant_id);
  if (status) filters.status = status;
  if (contract_type) filters.contract_type = contract_type;
  if (q) filters.q = q;
  return res.json(core.listContracts(filters).map(contractWithTenant));
}

function previewContractHandler(req, res) {
  if (!req.body || !req.body.tenant_id) throw new AppError(400, 'Selecione uma empresa.');
  const result = contractService.previewContract(req.body);
  return res.json(result);
}

function createContractHandler(req, res) {
  if (!req.body || !req.body.tenant_id) throw new AppError(400, 'Selecione uma empresa.');
  const contract = contractService.createDraftContract(req.body, req.user.id);
  safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_DRAFT_CREATED', `Rascunho ${contract.contract_number} criado`));
  return res.status(201).json(contractWithTenant(contract));
}

function getContractHandler(req, res) {
  const contract = contractService.getContractOr404(req.params.id);
  return res.json(contractWithTenant(contract));
}

function updateContractHandler(req, res) {
  const contract = contractService.updateDraftContract(req.params.id, req.body || {});
  return res.json(contractWithTenant(contract));
}

function finalizeContractHandler(req, res, next) {
  const contract = contractService.getContractOr404(req.params.id);
  contractService.validateFinalizable(contract);
  contractPdfService.generateAndStoreContractPdf(contract)
    .then(({ relativePath, sha256, sizeBytes }) => {
      const updated = core.updateContract(contract.id, {
        status: 'FINALIZED',
        finalized_at: new Date().toISOString(),
        finalized_by_user_id: req.user.id,
        pdf_path: relativePath,
        pdf_sha256: sha256,
        pdf_size_bytes: sizeBytes
      });
      safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_FINALIZED', `Contrato ${contract.contract_number} finalizado`));
      safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_PDF_GENERATED', `PDF do contrato ${contract.contract_number} gerado (sha256 ${sha256.slice(0, 12)}…)`));
      return res.json(contractWithTenant(updated));
    })
    .catch(next);
}

function downloadContractHandler(req, res) {
  const contract = contractService.getContractOr404(req.params.id);
  if (!contract.pdf_path) throw new AppError(404, 'Este contrato ainda não possui um PDF gerado.');
  const filePath = contractStorage.resolveContractPdf(contract.pdf_path);
  if (!filePath || !fs.existsSync(filePath)) throw new AppError(404, 'Arquivo do contrato não encontrado.');
  safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_DOWNLOADED', `Download do contrato ${contract.contract_number}`));
  return res.download(filePath, `${contract.contract_number}.pdf`);
}

function cancelContractHandler(req, res) {
  const contract = contractService.getContractOr404(req.params.id);
  if (contract.status !== 'FINALIZED') throw new AppError(409, 'Somente contratos finalizados podem ser cancelados.');
  const reason = req.body && req.body.reason ? String(req.body.reason).trim() : null;
  const updated = core.updateContract(contract.id, {
    status: 'CANCELLED',
    cancelled_at: new Date().toISOString(),
    cancel_reason: reason
  });
  safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_CANCELLED', `Contrato ${contract.contract_number} cancelado${reason ? `: ${reason}` : ''}`));
  return res.json(contractWithTenant(updated));
}

/* Duplica qualquer contrato (rascunho ou finalizado) como um novo rascunho
   independente — não altera nem substitui o original. */
function duplicateContractHandler(req, res) {
  const source = contractService.getContractOr404(req.params.id);
  const input = {
    tenant_id: source.tenant_id,
    template_id: source.template_id,
    contract_type: source.contract_type,
    plan_id: source.plan_snapshot_json ? JSON.parse(source.plan_snapshot_json).plan_id : undefined,
    billing_periodicity: source.billing_periodicity,
    start_date: source.start_date,
    end_date: source.end_date,
    duration_months: source.duration_months,
    discount_cents: source.discount_cents,
    implementation_fee_cents: source.implementation_fee_cents,
    subtotal_cents: source.billing_periodicity === 'CUSTOM' ? source.subtotal_cents : undefined,
    payment_method: source.payment_method,
    billing_day: source.billing_day,
    jurisdiction: source.jurisdiction,
    notes: source.notes,
    title: `${source.title || ''} (cópia)`.trim()
  };
  const contract = contractService.createDraftContract(input, req.user.id, { previous_contract_id: source.id });
  safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_DRAFT_CREATED', `Contrato ${contract.contract_number} criado como cópia de ${source.contract_number}`));
  return res.status(201).json(contractWithTenant(contract));
}

/* Renovação: rascunho novo vinculado ao contrato original, com o plano
   ATUAL da empresa (pode ter mudado de preço desde então) e datas
   deslocadas para o período seguinte. */
function renewContractHandler(req, res) {
  const source = contractService.getContractOr404(req.params.id);
  const startDate = (req.body && req.body.start_date) || source.end_date || new Date().toISOString().slice(0, 10);
  const input = {
    tenant_id: source.tenant_id,
    template_id: req.body && req.body.template_id ? req.body.template_id : source.template_id,
    contract_type: 'RENEWAL',
    plan_id: req.body && req.body.plan_id ? req.body.plan_id : undefined,
    billing_periodicity: (req.body && req.body.billing_periodicity) || source.billing_periodicity,
    start_date: startDate,
    duration_months: (req.body && req.body.duration_months) || source.duration_months,
    discount_cents: (req.body && req.body.discount_cents) ?? 0,
    implementation_fee_cents: 0,
    payment_method: source.payment_method,
    billing_day: source.billing_day,
    jurisdiction: source.jurisdiction,
    notes: req.body && req.body.notes
  };
  const contract = contractService.createDraftContract(input, req.user.id, {
    previous_contract_id: source.id,
    replaces_contract_id: source.id
  });
  safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_RENEWAL_CREATED', `Renovação ${contract.contract_number} criada a partir de ${source.contract_number}`));
  return res.status(201).json(contractWithTenant(contract));
}

/* Aditivo: contrato próprio (numeração própria, PDF próprio) que referencia
   o contrato original sem alterar o PDF/registro dele. */
function addendumContractHandler(req, res) {
  const source = contractService.getContractOr404(req.params.id);
  const changes = req.body && req.body.changes ? String(req.body.changes).trim() : '';
  if (!changes) throw new AppError(400, 'Descreva as cláusulas alteradas pelo aditivo.');
  const effectiveDate = (req.body && req.body.effective_date) || new Date().toISOString().slice(0, 10);
  const input = {
    tenant_id: source.tenant_id,
    template_id: req.body && req.body.template_id ? req.body.template_id : undefined,
    contract_type: 'ADDENDUM',
    plan_id: req.body && req.body.plan_id ? req.body.plan_id : undefined,
    billing_periodicity: source.billing_periodicity,
    start_date: effectiveDate,
    end_date: source.end_date,
    discount_cents: 0,
    implementation_fee_cents: 0,
    payment_method: source.payment_method,
    jurisdiction: source.jurisdiction,
    notes: `Aditivo ao contrato ${source.contract_number}. Cláusulas alteradas: ${changes}`,
    title: `Aditivo ao contrato ${source.contract_number}`
  };
  const contract = contractService.createDraftContract(input, req.user.id, { previous_contract_id: source.id });
  safeLog(() => core.logActivity(req.user.id, contract.tenant_id, 'CONTRACT_ADDENDUM_CREATED', `Aditivo ${contract.contract_number} criado para ${source.contract_number}`));
  return res.status(201).json(contractWithTenant(contract));
}

module.exports = {
  getCompanySettingsHandler,
  updateCompanySettingsHandler,
  uploadCompanyLogo,
  serveCompanyLogo,
  removeCompanyLogo,
  uploadCompanySignature,
  serveCompanySignature,
  removeCompanySignature,
  listTemplatesHandler,
  listCurrentTemplatesHandler,
  getTemplateHandler,
  createTemplateHandler,
  updateTemplateHandler,
  duplicateTemplateHandler,
  setTemplateDefaultHandler,
  setTemplateActiveHandler,
  contractsMetaHandler,
  listContractsHandler,
  previewContractHandler,
  createContractHandler,
  getContractHandler,
  updateContractHandler,
  finalizeContractHandler,
  downloadContractHandler,
  cancelContractHandler,
  duplicateContractHandler,
  renewContractHandler,
  addendumContractHandler
};
