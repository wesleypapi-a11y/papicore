const path = require('path');
const { getDb } = require('../database/tenantDatabase');
const { computeSetupStatus } = require('../database/tenantSchema');
const {
  ASSETS_DIR,
  storedFilePath
} = require('../utils/assetStorage');
const {
  AppError,
  isValidTime,
  isValidPhone,
  isValidEmail,
  parseWorkingDays,
  PAYMENT_METHODS
} = require('../utils/helpers');

/* Interpreta o JSON armazenado em payment_methods_enabled, garantindo sempre
   uma lista válida dentro de PAYMENT_METHODS (padrão: todos habilitados). */
function parsePaymentMethods(raw) {
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return [...PAYMENT_METHODS];
  const valid = list.filter((m) => PAYMENT_METHODS.includes(m));
  return valid.length ? valid : [...PAYMENT_METHODS];
}

function get(req, res) {
  const db = getDb();
  const s = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  if (!s) throw new AppError(404, 'Configurações não encontradas.');
  s.working_days = parseWorkingDays(s.working_days);
  s.payment_methods_enabled = parsePaymentMethods(s.payment_methods_enabled);

  /* QR Code do Pix: o arquivo em disco é a fonte da verdade (mesmo padrão do
     serve público). A URL usa o updated_at como cache-buster. */
  const tenantId = req.tenant ? req.tenant.id : null;
  const stored = tenantId ? storedFilePath(tenantId, 'pix_qr') : null;
  s.pix_qr_path = stored ? path.relative(ASSETS_DIR, stored).split(path.sep).join('/') : null;
  s.pix_qr_url = stored ? `/api/payment/pix-qr?v=${encodeURIComponent(s.updated_at || '')}` : null;

  const setup = computeSetupStatus(db);
  s.setup_status = setup.status;
  s.setup_missing = setup.missing;

  return res.json(s);
}

function update(req, res) {
  const db = getDb();
  const data = req.body || {};
  const {
    company_name,
    phone,
    whatsapp,
    document: companyDocument,
    email,
    address,
    logo_url,
    default_opening_time,
    default_closing_time,
    default_interval,
    lunch_start,
    lunch_end,
    working_days,
    confirmation_message,
    capacity,
    pix_code,
    pix_company_name,
    payment_methods_enabled
  } = data;

  if (!company_name || String(company_name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome da empresa.');
  }
  if (!isValidTime(default_opening_time)) throw new AppError(400, 'Horário de abertura inválido.');
  if (!isValidTime(default_closing_time)) throw new AppError(400, 'Horário de fechamento inválido.');
  if (default_closing_time <= default_opening_time) {
    throw new AppError(400, 'O horário de fechamento deve ser após a abertura.');
  }
  if (lunch_start && !isValidTime(lunch_start)) throw new AppError(400, 'Início do almoço inválido.');
  if (lunch_end && !isValidTime(lunch_end)) throw new AppError(400, 'Fim do almoço inválido.');
  if (lunch_start && lunch_end && lunch_end <= lunch_start) {
    throw new AppError(400, 'O fim do almoço deve ser após o início.');
  }
  if (phone && !isValidPhone(phone)) throw new AppError(400, 'Telefone inválido.');
  if (whatsapp && !isValidPhone(whatsapp)) throw new AppError(400, 'WhatsApp inválido.');

  /* Identificação empresarial (usada nos Termos de Uso e no Aviso de
     Privacidade). Todos opcionais — a empresa pode publicar os documentos
     sem preenchê-los, e o texto gerado só omite o dado ausente. */
  const companyDocumentValue = companyDocument == null ? null : String(companyDocument).trim().slice(0, 32) || null;
  if (email && !isValidEmail(email)) throw new AppError(400, 'E-mail inválido.');
  const emailValue = email == null ? null : String(email).trim().toLowerCase().slice(0, 160) || null;
  const addressValue = address == null ? null : String(address).trim().slice(0, 300) || null;

  /* Pagamento via Pix (opcional). */
  const pixCode = pix_code == null ? null : String(pix_code).trim();
  if (pixCode !== null && pixCode.length > 2000) {
    throw new AppError(400, 'O código Pix (copia e cola) é muito longo (máximo 2000 caracteres).');
  }
  const pixCompanyName = pix_company_name == null ? null : String(pix_company_name).trim();
  if (pixCompanyName !== null && pixCompanyName.length > 120) {
    throw new AppError(400, 'O nome do recebedor deve ter no máximo 120 caracteres.');
  }

  const current = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  const existingLunchStart = (current && current.lunch_start) || '12:00';
  const existingLunchEnd = (current && current.lunch_end) || '13:00';
  const finalLunchStart = lunch_start ? String(lunch_start).trim() : existingLunchStart;
  const finalLunchEnd = lunch_end ? String(lunch_end).trim() : existingLunchEnd;
  if (!isValidTime(finalLunchStart)) throw new AppError(400, 'Início do almoço inválido.');
  if (!isValidTime(finalLunchEnd)) throw new AppError(400, 'Fim do almoço inválido.');
  if (finalLunchEnd <= finalLunchStart) throw new AppError(400, 'O fim do almoço deve ser após o início.');

  const interval = Number(default_interval);
  if (!Number.isInteger(interval) || interval < 15 || interval > 240) {
    throw new AppError(400, 'A duração padrão deve estar entre 15 e 240 minutos.');
  }

  let cap = Number(capacity);
  if (!Number.isInteger(cap) || cap < 1 || cap > 20) {
    throw new AppError(400, 'A capacidade de atendimento deve estar entre 1 e 20.');
  }

  const days = Array.isArray(working_days)
    ? [...new Set(working_days.map(Number).filter((d) => d >= 0 && d <= 6))]
    : parseWorkingDays(working_days);
  if (days.length === 0) throw new AppError(400, 'Selecione pelo menos um dia de funcionamento.');

  /* Formas de pagamento habilitadas: se enviado, valida contra PAYMENT_METHODS
     e exige pelo menos uma ativa. Se não enviado, preserva o atual. */
  let enabledMethods = current && current.payment_methods_enabled
    ? parsePaymentMethods(current.payment_methods_enabled)
    : [...PAYMENT_METHODS];
  if (payment_methods_enabled != null) {
    const list = Array.isArray(payment_methods_enabled)
      ? payment_methods_enabled
      : String(payment_methods_enabled).split(',');
    const valid = [...new Set(list)].filter((m) => PAYMENT_METHODS.includes(m));
    if (valid.length === 0) throw new AppError(400, 'Selecione pelo menos uma forma de pagamento.');
    enabledMethods = valid;
  }
  const paymentMethodsJson = JSON.stringify(enabledMethods);

  db.prepare(
    `INSERT INTO company_settings
       (id, company_name, phone, whatsapp, document, email, address, logo_url,
        default_opening_time, default_closing_time,
        default_interval, lunch_start, lunch_end, working_days, confirmation_message, capacity,
        pix_code, pix_company_name, payment_methods_enabled)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       company_name = excluded.company_name,
       phone = excluded.phone,
       whatsapp = excluded.whatsapp,
       document = excluded.document,
       email = excluded.email,
       address = excluded.address,
       logo_url = excluded.logo_url,
       default_opening_time = excluded.default_opening_time,
       default_closing_time = excluded.default_closing_time,
       default_interval = excluded.default_interval,
       lunch_start = excluded.lunch_start,
       lunch_end = excluded.lunch_end,
       working_days = excluded.working_days,
       confirmation_message = excluded.confirmation_message,
       capacity = excluded.capacity,
       pix_code = excluded.pix_code,
       pix_company_name = excluded.pix_company_name,
       payment_methods_enabled = excluded.payment_methods_enabled,
       updated_at = datetime('now', 'localtime')`
  ).run(
    String(company_name).trim(),
    phone ? String(phone).trim() : null,
    whatsapp ? String(whatsapp).trim() : null,
    companyDocumentValue,
    emailValue,
    addressValue,
    logo_url ? String(logo_url).trim() : null,
    default_opening_time,
    default_closing_time,
    interval,
    finalLunchStart,
    finalLunchEnd,
    JSON.stringify(days),
    confirmation_message ? String(confirmation_message).trim() : '',
    cap,
    pixCode,
    pixCompanyName,
    paymentMethodsJson
  );

  const s = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  s.working_days = parseWorkingDays(s.working_days);
  s.payment_methods_enabled = parsePaymentMethods(s.payment_methods_enabled);
  return res.json(s);
}

module.exports = { get, update };
