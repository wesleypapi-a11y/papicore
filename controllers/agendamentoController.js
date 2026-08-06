const { getDb } = require('../database/tenantDatabase');
const { computeSetupStatus } = require('../database/tenantSchema');
const { storedFilePath } = require('../utils/assetStorage');
const {
  getAvailability,
  getUnit,
  getModality,
  getService
} = require('../services/availabilityService');
const { createAppointment } = require('../services/appointmentService');
const legalDocumentService = require('../services/legalDocumentService');
const {
  AppError,
  VEHICLE_CATEGORIES,
  todayStr,
  isValidDateStr,
  parseWorkingDays,
  PAYMENT_METHODS
} = require('../utils/helpers');

/* Cabeçalhos técnicos guardados na auditoria do aceite: truncados por
   segurança (nunca confiar no tamanho de um header vindo do navegador). */
function requestMeta(req) {
  const ip = String(req.ip || '').slice(0, 100) || null;
  const userAgent = String(req.get('user-agent') || '').slice(0, 300) || null;
  return { ip, userAgent };
}

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

function getPublicSettings(req, res) {
  const db = getDb();
  const s = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  if (!s) return res.json({});

  const ts = encodeURIComponent(s.updated_at || '');

  /* QR Code do Pix: a presença do arquivo em disco é a fonte da verdade. */
  const tenantId = req.tenantFromDomain ? req.tenantFromDomain.id : null;
  const hasPixQr = tenantId ? Boolean(storedFilePath(tenantId, 'pix_qr')) : false;

  const setup = computeSetupStatus(db);

  return res.json({
    company_name: s.company_name,
    phone: s.phone,
    whatsapp: s.whatsapp,
    logo_url: s.logo_url,
    default_opening_time: s.default_opening_time,
    default_closing_time: s.default_closing_time,
    default_interval: s.default_interval,
    capacity: s.capacity || 1,
    lunch_start: s.lunch_start,
    lunch_end: s.lunch_end,
    working_days: parseWorkingDays(s.working_days),
    confirmation_message: s.confirmation_message,
    pix_code: s.pix_code || null,
    pix_company_name: s.pix_company_name || null,
    payment_methods_enabled: parsePaymentMethods(s.payment_methods_enabled),
    pix_qr_url: hasPixQr ? `/api/payment/pix-qr?v=${ts}` : null,
    setup_status: setup.status,
    setup_missing: setup.missing
  });
}

function listActiveUnits(req, res) {
  const db = getDb();
  const units = db
    .prepare(
      `SELECT id, name, address, address_street, address_number, address_complement,
              address_neighborhood, address_city, address_state, address_zipcode,
              address_reference, maps_link, phone, opening_time, closing_time,
              lunch_start, lunch_end, appointment_interval, capacity, working_days
       FROM units WHERE active = 1 ORDER BY name ASC`
    )
    .all();

  const result = units.map((u) => ({
    ...u,
    working_days: parseWorkingDays(u.working_days)
  }));

  return res.json(result);
}

function listModalities(req, res) {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, name, slug, description, fee FROM service_modalities WHERE active = 1 ORDER BY id ASC')
    .all();
  return res.json(rows);
}

function getCatalog(req, res) {
  const db = getDb();
  const modalitySlug = req.query.modality_id ? (getModality(Number(req.query.modality_id)) || {}).slug : null;

  const categories = db
    .prepare('SELECT * FROM service_categories WHERE active = 1 ORDER BY display_order ASC, id ASC')
    .all();

  let servicesSql = `
    SELECT s.*, c.name AS category_name, c.slug AS category_slug
    FROM services s
    JOIN service_categories c ON c.id = s.category_id
    WHERE s.active = 1`;
  const params = [];

  if (modalitySlug === 'in-store') {
    servicesSql += ' AND s.available_at_unit = 1';
  } else if (modalitySlug === 'pickup') {
    servicesSql += ' AND s.available_pickup_delivery = 1';
  } else if (modalitySlug === 'delivery') {
    servicesSql += ' AND s.available_mobile_delivery = 1';
  }
  servicesSql += ' ORDER BY c.display_order ASC, s.display_order ASC, s.id ASC';

  const services = db.prepare(servicesSql).all(...params);

  const catalog = categories.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    services: services
      .filter((s) => s.category_id === c.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        price_type: s.price_type,
        fixed_price: s.fixed_price,
        price_hatch: s.price_hatch,
        price_sedan: s.price_sedan,
        price_suv: s.price_suv,
        price_pickup: s.price_pickup,
        starting_price: s.starting_price,
        duration_minutes: s.duration_minutes,
        pickup_extra_minutes: s.pickup_extra_minutes,
        package_items: s.package_items ? JSON.parse(s.package_items) : [],
        display_order: s.display_order
      }))
  }));

  return res.json({ vehicle_categories: VEHICLE_CATEGORIES, catalog });
}

function checkAvailability(req, res) {
  const modalityId = Number(req.query.modality_id);
  const serviceIdsRaw = String(req.query.service_ids || req.query.service_id || '').trim();
  const date = req.query.date;
  const unitId = req.query.unit_id ? Number(req.query.unit_id) : null;
  const category = req.query.vehicle_category ? String(req.query.vehicle_category).toLowerCase() : 'hatch';

  if (!modalityId) throw new AppError(400, 'Informe o campo modality_id.');
  if (!serviceIdsRaw) throw new AppError(400, 'Informe ao menos um serviço.');
  if (!isValidDateStr(date)) throw new AppError(400, 'Data inválida. Use o formato AAAA-MM-DD.');
  if (date < todayStr()) throw new AppError(400, 'Não é possível consultar uma data no passado.');
  if (!VEHICLE_CATEGORIES.includes(category)) {
    throw new AppError(400, 'Categoria de veículo inválida (use hatch, sedan, suv ou pickup).');
  }

  const modality = getModality(modalityId);
  if (!modality || !modality.active) throw new AppError(404, 'Forma de atendimento não encontrada.');

  const serviceIds = serviceIdsRaw.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const services = serviceIds.map((id) => getService(id));
  if (!services.length || services.some((s) => !s || !s.active)) {
    throw new AppError(404, 'Serviço não encontrado.');
  }

  const settings = getDb().prepare('SELECT * FROM company_settings WHERE id = 1').get() || {};

  let unit = null;
  if (modality.slug === 'in-store') {
    if (!unitId) throw new AppError(400, 'Informe o campo unit_id para esta modalidade.');
    unit = getUnit(unitId);
    if (!unit || !unit.active) throw new AppError(404, 'Unidade não encontrada.');
  } else if (unitId) {
    unit = getUnit(unitId);
  }

  const availability = getAvailability({ date, services, modality, unit, settings, category });
  return res.json(availability);
}

function createAppointmentPublic(req, res) {
  const appointment = createAppointment(req.body, requestMeta(req));
  const { enqueueEvent, EVENTS } = require('../services/whatsappService');
  try {
    enqueueEvent(EVENTS.REQUESTED_CUSTOMER, appointment, { linkAdmin: adminLink(req) });
    enqueueEvent(EVENTS.REQUESTED_STORE, appointment, { linkAdmin: adminLink(req) });
  } catch (err) {
    console.error('[whatsapp] Erro ao enfileirar avisos de novo agendamento:', err.message);
  }
  /* Webhook de saída da API pública. */
  const webhookService = require('../services/webhookService');
  webhookService.fire(req, webhookService.WEBHOOK_EVENTS.APPOINTMENT_CREATED, webhookService.buildAppointmentPayload(appointment));
  return res.status(201).json(appointment);
}

/* Link para o painel usado no placeholder {{LINK_ADMIN}}. */
function adminLink(req) {
  const host = req && req.get ? req.get('host') : '';
  return host ? `${req.protocol || 'https'}://${host}/admin` : '/admin';
}

/* Documentos legais públicos (Termos de Uso / Aviso de Privacidade) do tenant
   atual — usados nos modais do agendamento e nas páginas /termos-de-uso e
   /aviso-de-privacidade. O identificador vem da URL (whitelist fixa), nunca
   de um id de banco de dados exposto ao navegador. */
const PUBLIC_LEGAL_DOC_KEYS = ['terms', 'privacy'];

function getPublicLegalDocument(req, res) {
  const key = String(req.params.key || '').toLowerCase();
  if (!PUBLIC_LEGAL_DOC_KEYS.includes(key)) {
    throw new AppError(404, 'Documento não encontrado.');
  }
  const db = getDb();
  const domain = req.tenant ? req.tenant.domain : req.tenantDomain;
  const doc = legalDocumentService.publicDocument(db, key, domain);
  if (!doc) {
    throw new AppError(404, 'Documento ainda não publicado por esta empresa.');
  }
  return res.json(doc);
}

function getByCode(req, res) {
  const db = getDb();
  const code = String(req.params.code || '').trim().toUpperCase();
  const appointment = db
    .prepare(
      `SELECT a.*, u.name AS unit_name, u.address AS unit_address, u.maps_link AS unit_maps_link,
              m.name AS modality_name, m.slug AS modality_slug, m.fee AS modality_fee,
              s.name AS service_name, s.duration_minutes AS service_duration_minutes
       FROM appointments a
       LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN service_modalities m ON m.id = a.modality_id
       LEFT JOIN services s ON s.id = a.service_id
       WHERE a.appointment_code = ?`
    )
    .get(code);

  if (!appointment) throw new AppError(404, 'Agendamento não encontrado.');
  return res.json(appointment);
}

module.exports = {
  getPublicSettings,
  listActiveUnits,
  listModalities,
  getCatalog,
  checkAvailability,
  createAppointmentPublic,
  getPublicLegalDocument,
  getByCode
};
