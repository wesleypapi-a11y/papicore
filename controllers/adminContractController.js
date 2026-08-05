/*
 * adminContractController.js
 *
 * Consulta e download dos contratos da PRÓPRIA empresa pelo painel
 * administrativo do tenant. Contratos vivem no banco central; o tenant_id
 * usado é sempre req.tenant.id, resolvido pelo tenantMiddleware a partir do
 * usuário autenticado — nunca vindo do frontend. Rascunhos (DRAFT) nunca
 * aparecem aqui: são trabalho interno do desenvolvedor, só o que já saiu do
 * estado de rascunho é visível para o cliente.
 */

const fs = require('fs');
const core = require('../database/coreDatabase');
const { AppError } = require('../utils/helpers');
const contractStorage = require('../utils/contractStorage');

function listMyContracts(req, res) {
  const contracts = core.listContracts({ tenant_id: req.tenant.id }).filter((c) => c.status !== 'DRAFT');
  return res.json(contracts.map((c) => ({
    id: c.id,
    contract_number: c.contract_number,
    contract_type: c.contract_type,
    status: c.status,
    plan_name: c.plan_name,
    total_cents: c.total_cents,
    billing_periodicity: c.billing_periodicity,
    start_date: c.start_date,
    end_date: c.end_date,
    finalized_at: c.finalized_at,
    has_pdf: Boolean(c.pdf_path),
    created_at: c.created_at
  })));
}

function downloadMyContract(req, res) {
  const contract = core.getContractById(Number(req.params.id));
  if (!contract || contract.tenant_id !== req.tenant.id || contract.status === 'DRAFT') {
    throw new AppError(404, 'Contrato não encontrado.');
  }
  if (!contract.pdf_path) {
    throw new AppError(404, 'Este contrato ainda não possui um PDF gerado.');
  }
  const filePath = contractStorage.resolveContractPdf(contract.pdf_path);
  if (!filePath || !fs.existsSync(filePath)) {
    throw new AppError(404, 'Arquivo do contrato não encontrado.');
  }
  return res.download(filePath, `${contract.contract_number}.pdf`);
}

module.exports = { listMyContracts, downloadMyContract };
