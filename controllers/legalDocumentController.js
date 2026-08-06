/*
 * legalDocumentController.js
 *
 * Painel administrativo (Configurações > Documentos e privacidade):
 * somente leitura nesta primeira implementação — ver services/legalDocumentService.js
 * para o motivo (evitar risco de edição livre de conteúdo jurídico sem
 * confirmação/versionamento na interface).
 */
const { getDb } = require('../database/tenantDatabase');
const { listDomains } = require('../database/coreDatabase');
const legalDocumentService = require('../services/legalDocumentService');
const { AppError } = require('../utils/helpers');

function primaryDomain(tenantId) {
  if (!tenantId) return null;
  const domains = listDomains(tenantId) || [];
  const primary = domains.find((d) => d.is_primary) || domains[0];
  return primary ? primary.domain : null;
}

function list(req, res) {
  const db = getDb();
  return res.json(legalDocumentService.listDocuments(db));
}

function getOne(req, res) {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'Documento inválido.');
  const doc = legalDocumentService.getDocument(db, id);
  if (!doc) throw new AppError(404, 'Documento não encontrado.');
  return res.json(legalDocumentService.renderDocument(db, doc, primaryDomain(req.tenantId)));
}

module.exports = { list, getOne };
