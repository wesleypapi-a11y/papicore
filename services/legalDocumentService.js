/*
 * legalDocumentService.js
 *
 * Documentos legais por tenant (Termos de Uso, Aviso de Privacidade).
 *
 * - Os documentos são versionados; o agendamento registra o instantâneo
 *   (título + versão) aceito pelo cliente, tornando o histórico imutável.
 * - O aceite é obrigatório antes de criar um agendamento público. A validação
 *   ocorre antes da transação e o registro é feito dentro da mesma transação
 *   do agendamento (ver appointmentService.createAppointment).
 */

const { AppError, todayStr } = require('../utils/helpers');

const REQUIRED_DOC_KEYS = ['terms', 'privacy'];

const LEGAL_DOCUMENT_KEY_RE = /^[a-z0-9_-]{2,50}$/;

/*
 * Dados cadastrais do tenant usados para identificar, nos documentos legais,
 * a empresa responsável pelo atendimento (nunca a PapiCore ou outro cliente).
 * `tenantDomain` vem do domínio resolvido da requisição atual
 * (domainTenantMiddleware) — nunca de um parâmetro enviado pelo navegador.
 */
function tenantCompanyInfo(db, tenantDomain) {
  const s = db
    .prepare('SELECT company_name, phone, whatsapp, document, email, address FROM company_settings WHERE id = 1')
    .get() || {};
  return {
    name: String(s.company_name || '').trim(),
    document: String(s.document || '').trim(),
    address: String(s.address || '').trim(),
    phone: String(s.phone || '').trim(),
    whatsapp: String(s.whatsapp || '').trim(),
    email: String(s.email || '').trim(),
    domain: String(tenantDomain || '').trim()
  };
}

/* Alias curto (compatibilidade e uso interno). */
function companyName(db) {
  return tenantCompanyInfo(db).name;
}

/* Parágrafo de identificação da empresa: cada dado só aparece se estiver
   cadastrado — nunca exibe "undefined", "null" ou dado fictício. */
function companyIdentificationBlock(info) {
  const name = info.name || 'A empresa responsável por este atendimento';
  const parts = [];
  if (info.document) parts.push(`inscrita sob o documento ${info.document}`);
  if (info.address) parts.push(`com atendimento em ${info.address}`);
  const contacts = [];
  if (info.phone) contacts.push(`telefone ${info.phone}`);
  if (info.whatsapp && info.whatsapp !== info.phone) contacts.push(`WhatsApp ${info.whatsapp}`);
  if (info.email) contacts.push(`e-mail ${info.email}`);
  if (contacts.length) parts.push(`contato pelo(a) ${contacts.join(', ')}`);
  if (info.domain) parts.push(`agendamento pelo site ${info.domain}`);
  const detail = parts.length ? `, ${parts.join('; ')}` : '';
  return `${name}${detail}, é quem presta o serviço automotivo e trata os dados necessários para o atendimento. A PapiCore é a fornecedora da tecnologia utilizada para operar e administrar este agendamento, sem participação na execução do serviço automotivo.`;
}

/* Canal de contato para assuntos de privacidade: usa o primeiro dado
   cadastrado (e-mail, WhatsApp ou telefone), sem inventar um contato. */
function privacyContact(info) {
  if (info.email) return `o e-mail ${info.email}`;
  if (info.whatsapp) return `o WhatsApp ${info.whatsapp}`;
  if (info.phone) return `o telefone ${info.phone}`;
  return 'os canais de contato informados nesta página';
}

/* Substitui os placeholders do conteúdo pelos dados reais do tenant. */
function renderContent(content, info) {
  const replacements = {
    '{{NOME_DA_EMPRESA}}': info.name || 'a empresa responsável por este atendimento',
    '{{IDENTIFICACAO_EMPRESA}}': companyIdentificationBlock(info),
    '{{CONTATO_PRIVACIDADE}}': privacyContact(info),
    '{{DOMINIO_EMPRESA}}': info.domain || ''
  };
  let out = String(content || '');
  for (const token of Object.keys(replacements)) {
    out = out.split(token).join(replacements[token]);
  }
  return out;
}

function publicSelect() {
  return 'id, doc_key, title, version, effective_at, published, updated_at';
}

function listDocuments(db) {
  return db
    .prepare(`SELECT ${publicSelect()} FROM legal_documents ORDER BY doc_key`)
    .all();
}

function getDocument(db, id) {
  return db.prepare(`SELECT * FROM legal_documents WHERE id = ?`).get(id);
}

function getDocumentByKey(db, docKey) {
  return db.prepare('SELECT * FROM legal_documents WHERE doc_key = ?').get(docKey);
}

function bumpVersion(version) {
  const parts = String(version || '1.0').split('.');
  const major = Number(parts[0]) || 1;
  const minor = (Number(parts[1]) || 0) + 1;
  return `${major}.${minor}`;
}

function validateInput(db, body, { existing } = {}) {
  const { doc_key, title, content, published, effective_at } = body || {};

  let finalKey = doc_key;
  if (doc_key !== undefined) {
    finalKey = String(doc_key).trim().toLowerCase();
    if (!LEGAL_DOCUMENT_KEY_RE.test(finalKey)) {
      throw new AppError(400, 'Identificador do documento inválido (use letras minúsculas, números, hífen ou sublinhado).');
    }
    if (existing) {
      const dup = getDocumentByKey(db, finalKey);
      if (dup && dup.id !== existing.id) {
        throw new AppError(409, 'Já existe um documento com este identificador.');
      }
    }
  }

  const finalTitle = title !== undefined ? String(title).trim() : undefined;
  if (finalTitle !== undefined && finalTitle.length < 2) {
    throw new AppError(400, 'Informe o título do documento.');
  }
  if (title === undefined && existing && existing.title.length < 2) {
    throw new AppError(400, 'Informe o título do documento.');
  }

  const finalContent = content !== undefined ? String(content) : undefined;
  if (finalContent !== undefined && !String(finalContent).trim()) {
    throw new AppError(400, 'Informe o conteúdo do documento.');
  }

  let finalPublished;
  if (published !== undefined) {
    finalPublished = published === true || published === 1 ? 1 : 0;
  }

  const finalEffectiveAt = effective_at !== undefined && effective_at ? String(effective_at).trim() : undefined;

  return {
    doc_key: finalKey,
    title: finalTitle,
    content: finalContent,
    published: finalPublished,
    effective_at: finalEffectiveAt
  };
}

/* Cria um documento. O placeholder de empresa é mantido no conteúdo (a troca
   pelo nome real acontece apenas na leitura pública). */
function createDocument(db, body) {
  const { doc_key, title, content, published, effective_at } = validateInput(db, body, {});
  if (!doc_key) throw new AppError(400, 'Informe o identificador do documento.');
  if (!title) throw new AppError(400, 'Informe o título do documento.');
  if (content === undefined || !String(content).trim()) {
    throw new AppError(400, 'Informe o conteúdo do documento.');
  }
  if (getDocumentByKey(db, doc_key)) {
    throw new AppError(409, 'Já existe um documento com este identificador.');
  }

  const info = db
    .prepare(
      `INSERT INTO legal_documents (doc_key, title, content, version, effective_at, published)
       VALUES (?, ?, ?, '1.0', ?, ?)`
    )
    .run(
      doc_key,
      title,
      content,
      effective_at || todayStr(),
      published === undefined ? 1 : published
    );
  return getDocument(db, info.lastInsertRowid);
}

/* Atualiza um documento e cria versão nova quando o conteúdo muda. Nunca
   sobrescreve silenciosamente mantendo a mesma versão: antes de gravar o
   novo texto, arquiva a versão anterior INTEIRA (título + conteúdo) em
   legal_document_versions — o histórico completo fica preservado, não só o
   rótulo da versão. O título, a versão e a data de vigência de um aceite já
   registrado não são alterados retroativamente (o agendamento guarda o
   instantâneo em appointment_legal_acceptances). */
function updateDocument(db, id, body) {
  const existing = getDocument(db, id);
  if (!existing) throw new AppError(404, 'Documento não encontrado.');

  const data = validateInput(db, body, { existing });

  const contentChanged = data.content !== undefined && data.content !== existing.content;
  const finalTitle = data.title !== undefined ? data.title : existing.title;
  const finalContent = data.content !== undefined ? data.content : existing.content;
  const finalPublished = data.published !== undefined ? data.published : existing.published;
  const finalEffectiveAt = data.effective_at !== undefined
    ? data.effective_at
    : existing.effective_at;
  const finalVersion = contentChanged ? bumpVersion(existing.version) : existing.version;

  const tx = db.transaction(() => {
    if (contentChanged) {
      db.prepare(
        `INSERT OR IGNORE INTO legal_document_versions
           (legal_document_id, doc_key, title, content, version, published, effective_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(existing.id, existing.doc_key, existing.title, existing.content, existing.version, existing.published, existing.effective_at);
    }
    db.prepare(
      `UPDATE legal_documents
       SET title = ?, content = ?, version = ?, published = ?, effective_at = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ?`
    ).run(finalTitle, finalContent, finalVersion, finalPublished, finalEffectiveAt, id);
  });
  tx();

  return getDocument(db, id);
}

/* Histórico de versões arquivadas de um documento (mais recente primeiro),
   para auditoria — a versão vigente fica em legal_documents/getDocument. */
function versionHistory(db, documentId) {
  return db
    .prepare(
      `SELECT id, legal_document_id, doc_key, title, version, published, effective_at, archived_at
       FROM legal_document_versions
       WHERE legal_document_id = ?
       ORDER BY id DESC`
    )
    .all(documentId);
}

function setPublished(db, id, published) {
  const existing = getDocument(db, id);
  if (!existing) throw new AppError(404, 'Documento não encontrado.');
  db.prepare(
    "UPDATE legal_documents SET published = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(published === true || published === 1 ? 1 : 0, id);
  return getDocument(db, id);
}

/* Documentos publicados (resumo) para o frontend de agendamento. */
function publicDocumentSummaries(db) {
  const docs = db
    .prepare(`SELECT ${publicSelect()} FROM legal_documents WHERE published = 1 ORDER BY doc_key`)
    .all();
  return docs.map((d) => ({ ...d, required: REQUIRED_DOC_KEYS.includes(d.doc_key) }));
}

/* Aplica os dados da empresa (tenant) sobre um documento já carregado — usado
   tanto na leitura pública quanto na visualização administrativa. */
function renderDocument(db, doc, tenantDomain) {
  if (!doc) return null;
  const info = tenantCompanyInfo(db, tenantDomain);
  return {
    id: doc.id,
    doc_key: doc.doc_key,
    title: doc.title,
    version: doc.version,
    effective_at: doc.effective_at,
    updated_at: doc.updated_at,
    published: !!doc.published,
    content: renderContent(doc.content, info),
    company: {
      name: info.name || null,
      document: info.document || null,
      address: info.address || null,
      phone: info.phone || null,
      whatsapp: info.whatsapp || null,
      email: info.email || null,
      domain: info.domain || null
    }
  };
}

/* Documento publicado completo, com os dados da empresa (tenant) substituídos. */
function publicDocument(db, docKey, tenantDomain) {
  const doc = db
    .prepare('SELECT * FROM legal_documents WHERE doc_key = ? AND published = 1')
    .get(docKey);
  if (!doc) return null;
  return renderDocument(db, doc, tenantDomain);
}

/*
 * Valida o aceite obrigatório enviado no corpo da requisição pública de
 * agendamento:
 *   { legalAcceptance: { termsAccepted: true, privacyAcknowledged: true } }
 *
 * Regras (nunca confiar em valores livres do navegador):
 *   - termsAccepted e privacyAcknowledged precisam ser exatamente `true`
 *     (não apenas "truthy") — falha com 422 LEGAL_ACCEPTANCE_REQUIRED;
 *   - as versões vigentes são sempre buscadas no servidor (getDocumentByKey),
 *     nunca aceitas do cliente — falha com 422 LEGAL_DOCUMENTS_UNAVAILABLE se
 *     algum documento obrigatório não estiver publicado.
 * Retorna os documentos vigentes para gravação na mesma transação do
 * agendamento (ver recordAcceptances).
 */
function validateLegalAcceptance(db, legalAcceptance) {
  const acceptance = legalAcceptance && typeof legalAcceptance === 'object' ? legalAcceptance : {};

  const termsDoc = getDocumentByKey(db, 'terms');
  const privacyDoc = getDocumentByKey(db, 'privacy');
  if (!termsDoc || !termsDoc.published || !privacyDoc || !privacyDoc.published) {
    throw new AppError(
      422,
      'Não foi possível carregar os documentos obrigatórios. Tente novamente em instantes.',
      { code: 'LEGAL_DOCUMENTS_UNAVAILABLE' }
    );
  }

  if (acceptance.termsAccepted !== true || acceptance.privacyAcknowledged !== true) {
    throw new AppError(
      422,
      'É necessário aceitar os Termos de Uso e confirmar a leitura do Aviso de Privacidade.',
      { code: 'LEGAL_ACCEPTANCE_REQUIRED' }
    );
  }

  return { termsDoc, privacyDoc };
}

/* Registra os aceites na mesma transação do agendamento (chamado com o db da
   transação). Guarda o instantâneo (título + versão) de cada documento — o
   histórico permanece correto mesmo que o conteúdo mude depois. meta traz
   metadados técnicos opcionais do momento do aceite (ip/user-agent), nunca
   dados de terceiros. */
function recordAcceptances(db, appointmentId, { termsDoc, privacyDoc }, meta = {}) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO appointment_legal_acceptances
       (appointment_id, legal_document_id, document_version, document_title, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const doc of [termsDoc, privacyDoc]) {
    insert.run(
      appointmentId,
      doc.id,
      doc.version,
      doc.title,
      meta.ip || null,
      meta.userAgent || null
    );
  }
}

/* Aceites registrados de um agendamento (exibição na administração). */
function acceptancesForAppointment(db, appointmentId) {
  return db
    .prepare(
      `SELECT id, appointment_id, legal_document_id, document_version, document_title,
              ip_address, user_agent, accepted_at
       FROM appointment_legal_acceptances
       WHERE appointment_id = ?
       ORDER BY id`
    )
    .all(appointmentId);
}

module.exports = {
  REQUIRED_DOC_KEYS,
  listDocuments,
  getDocument,
  getDocumentByKey,
  createDocument,
  updateDocument,
  versionHistory,
  setPublished,
  publicDocumentSummaries,
  publicDocument,
  renderDocument,
  tenantCompanyInfo,
  validateLegalAcceptance,
  recordAcceptances,
  acceptancesForAppointment
};
