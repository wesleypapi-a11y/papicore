const db = require('../database/database');
const { getUnit, getModality, getService, getConflicts } = require('./availabilityService');
const {
  AppError,
  ACTIVE_STATUSES,
  STATUSES,
  VEHICLE_CATEGORIES,
  todayStr,
  isValidDateStr,
  isValidTime,
  isValidPhone,
  isValidEmail,
  isValidCPF,
  isValidPlate,
  normalizePhone,
  parseWorkingDays,
  isWorkingDay,
  buildSlotsWithDuration,
  addMinutes,
  overlaps,
  nowDateTime,
  generateCode
} = require('../utils/helpers');

function getSettings() {
  return db.prepare('SELECT * FROM company_settings WHERE id = 1').get() || {};
}

function calcServicePrice(service, category) {
  if (service.price_type === 'fixed') return Number(service.fixed_price || 0);
  if (service.price_type === 'starting') return Number(service.starting_price || 0);
  return Number(service[`price_${category}`] || 0);
}

function priceIsEstimate(service) {
  return service.price_type === 'starting';
}

function countOverlaps(date, unitIdForScope, start, end, excludeId = null) {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  let sql = `SELECT COUNT(*) AS c FROM appointments
             WHERE appointment_date = ? AND status IN (${placeholders})
               AND start_time < ? AND end_time > ?`;
  const params = [date, ...ACTIVE_STATUSES, end, start];
  if (unitIdForScope) {
    sql += ' AND unit_id = ?';
    params.push(unitIdForScope);
  }
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  return db.prepare(sql).get(...params).c;
}

function requireAddress(body) {
  const required = ['address_street', 'address_number', 'address_neighborhood', 'address_city', 'address_state', 'address_zipcode'];
  for (const field of required) {
    if (!body[field] || !String(body[field]).trim()) {
      throw new AppError(400, 'Informe o endereço completo, incluindo cidade, estado e CEP.');
    }
  }
}

function validateAppointmentInput(body, opts = {}) {
  const {
    modality_id,
    unit_id,
    service_id,
    customer_name,
    customer_phone,
    customer_email,
    customer_cpf,
    vehicle_brand,
    vehicle_model,
    vehicle_year,
    vehicle_plate,
    vehicle_color,
    vehicle_category,
    appointment_date,
    start_time,
    address_zipcode,
    address_street,
    address_number,
    address_complement,
    address_neighborhood,
    address_city,
    address_state,
    address_reference,
    responsible_name,
    responsible_phone,
    has_water_access,
    has_power_access,
    key_delivery_confirmed,
    customer_notes,
    status
  } = body || {};

  if (!Number.isInteger(modality_id) || modality_id <= 0) {
    throw new AppError(400, 'Selecione a forma de atendimento.');
  }
  const modality = getModality(modality_id);
  if (!modality || !modality.active) {
    throw new AppError(400, 'Forma de atendimento indisponível.');
  }

  if (!Number.isInteger(service_id) || service_id <= 0) {
    throw new AppError(400, 'Selecione um serviço.');
  }
  const service = getService(service_id);
  if (!service || !service.active) {
    throw new AppError(404, 'Serviço não encontrado ou desativado.');
  }

  if (modality.slug === 'in-store' && !service.available_at_unit) {
    throw new AppError(400, 'Este serviço não está disponível na modalidade Lavagem na unidade.');
  }
  if (modality.slug === 'pickup' && !service.available_pickup_delivery) {
    throw new AppError(400, 'Este serviço não está disponível na modalidade Leva e traz.');
  }
  if (modality.slug === 'delivery' && !service.available_mobile_delivery) {
    throw new AppError(400, 'Este serviço não está disponível na modalidade Delivery.');
  }

  let unit = null;
  if (modality.slug === 'in-store') {
    if (!Number.isInteger(unit_id) || unit_id <= 0) {
      throw new AppError(400, 'Selecione a unidade para a Lavagem na unidade.');
    }
    unit = getUnit(unit_id);
    if (!unit || !unit.active) throw new AppError(400, 'Unidade indisponível.');
  } else if (unit_id) {
    unit = getUnit(unit_id);
  }

  if (!customer_name || String(customer_name).trim().length < 3) {
    throw new AppError(400, 'Informe o nome completo.');
  }
  if (!isValidPhone(customer_phone)) {
    throw new AppError(400, 'Informe um telefone com DDD válido.');
  }
  if (customer_email && !isValidEmail(customer_email)) {
    throw new AppError(400, 'E-mail informado é inválido.');
  }
  if (customer_cpf && !isValidCPF(customer_cpf)) {
    throw new AppError(400, 'CPF informado é inválido.');
  }

  if (!vehicle_brand || String(vehicle_brand).trim().length < 2) {
    throw new AppError(400, 'Informe a marca do veículo.');
  }
  if (!vehicle_model || String(vehicle_model).trim().length < 2) {
    throw new AppError(400, 'Informe o modelo do veículo.');
  }
  if (vehicle_year && !/^\d{4}$/.test(String(vehicle_year).trim())) {
    throw new AppError(400, 'Ano do veículo inválido.');
  }
  if (vehicle_plate && !isValidPlate(vehicle_plate)) {
    throw new AppError(400, 'Placa inválida. Use o formato ABC-1234 ou Mercosul.');
  }
  const category = String(vehicle_category || '').toLowerCase();
  if (!VEHICLE_CATEGORIES.includes(category)) {
    throw new AppError(400, 'Categoria de veículo inválida (use hatch, sedan, suv ou pickup).');
  }

  if (!isValidDateStr(appointment_date)) {
    throw new AppError(400, 'Data inválida. Use o formato AAAA-MM-DD.');
  }
  if (appointment_date < todayStr()) {
    throw new AppError(400, 'Não é possível agendar para uma data no passado.');
  }
  if (!isValidTime(start_time)) {
    throw new AppError(400, 'Horário inválido. Use o formato HH:MM.');
  }

  const settings = getSettings();
  const duration = Number(service.duration_minutes);
  const opening = unit ? unit.opening_time : settings.default_opening_time;
  const closing = unit ? unit.closing_time : settings.default_closing_time;
  const interval = unit ? unit.appointment_interval : settings.default_interval;
  const workingDays = unit ? parseWorkingDays(unit.working_days) : parseWorkingDays(settings.working_days);

  if (!isWorkingDay(workingDays, appointment_date)) {
    throw new AppError(400, 'Não atendemos nesta data.');
  }
  const slots = buildSlotsWithDuration(opening, closing, interval, duration);
  if (!slots.includes(start_time)) {
    throw new AppError(400, 'Horário fora do expediente para este serviço.');
  }

  const endTime = addMinutes(start_time, duration);
  const now = nowDateTime();
  if (appointment_date === now.date && start_time <= now.time) {
    throw new AppError(400, 'Não é possível agendar para um horário que já passou.');
  }

  if (modality.slug === 'pickup') {
    requireAddress(body);
    if (!responsible_name || String(responsible_name).trim().length < 3) {
      throw new AppError(400, 'Informe o responsável pela entrega da chave.');
    }
    if (!key_delivery_confirmed) {
      throw new AppError(400, 'Confirme que a chave será entregue ao responsável.');
    }
  }
  if (modality.slug === 'delivery') {
    requireAddress(body);
    if (!has_water_access) {
      throw new AppError(400, 'Confirme que há ponto de água disponível no local.');
    }
    if (!has_power_access) {
      throw new AppError(400, 'Confirme que há tomada elétrica em funcionamento no local.');
    }
  }

  let finalStatus = 'pending';
  if (opts.allowStatus) {
    finalStatus = status || 'pending';
    if (!STATUSES.includes(finalStatus)) throw new AppError(400, 'Status inválido.');
  }

  const servicePrice = calcServicePrice(service, category);
  const modalityFee = Number(modality.fee || 0);
  const totalPrice = servicePrice + modalityFee;

  return {
    modality,
    service,
    unit,
    modality_id: modality.id,
    unit_id: unit ? unit.id : null,
    service_id: service.id,
    service_name: service.name,
    duration,
    end_time: endTime,
    service_price: servicePrice,
    modality_fee: modalityFee,
    total_price: totalPrice,
    price_is_estimate: priceIsEstimate(service) ? 1 : 0,
    status: finalStatus,
    customer_name: String(customer_name).trim(),
    customer_phone: normalizePhone(customer_phone),
    customer_email: customer_email ? String(customer_email).trim().toLowerCase() : null,
    customer_cpf: customer_cpf ? String(customer_cpf).replace(/\D/g, '') : null,
    vehicle_brand: String(vehicle_brand).trim(),
    vehicle_model: String(vehicle_model).trim(),
    vehicle_year: vehicle_year ? String(vehicle_year).trim() : null,
    vehicle_plate: vehicle_plate ? String(vehicle_plate).toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
    vehicle_color: vehicle_color ? String(vehicle_color).trim() : null,
    vehicle_category: category,
    appointment_date,
    start_time,
    address_zipcode: address_zipcode ? String(address_zipcode).trim() : null,
    address_street: address_street ? String(address_street).trim() : null,
    address_number: address_number ? String(address_number).trim() : null,
    address_complement: address_complement ? String(address_complement).trim() : null,
    address_neighborhood: address_neighborhood ? String(address_neighborhood).trim() : null,
    address_city: address_city ? String(address_city).trim() : null,
    address_state: address_state ? String(address_state).trim().toUpperCase() : null,
    address_reference: address_reference ? String(address_reference).trim() : null,
    responsible_name: responsible_name ? String(responsible_name).trim() : null,
    responsible_phone: responsible_phone ? normalizePhone(responsible_phone) : (customer_phone ? normalizePhone(customer_phone) : null),
    has_water_access: has_water_access ? 1 : 0,
    has_power_access: has_power_access ? 1 : 0,
    key_delivery_confirmed: key_delivery_confirmed ? 1 : 0,
    customer_notes: customer_notes ? String(customer_notes).trim() : null
  };
}

function insertAppointment(data) {
  const code = generateCode(data.appointment_date);

  const info = db
    .prepare(
      `INSERT INTO appointments
        (appointment_code, modality_id, unit_id, service_id,
         customer_name, customer_phone, customer_email, customer_cpf,
         vehicle_brand, vehicle_model, vehicle_year, vehicle_plate, vehicle_color, vehicle_category,
         appointment_date, start_time, end_time, service_name,
         service_price, modality_fee, total_price, price_is_estimate, status,
         address_zipcode, address_street, address_number, address_complement, address_neighborhood,
         address_city, address_state, address_reference,
         responsible_name, responsible_phone,
         has_water_access, has_power_access, key_delivery_confirmed,
         customer_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      data.modality_id,
      data.unit_id,
      data.service_id,
      data.customer_name,
      data.customer_phone,
      data.customer_email,
      data.customer_cpf,
      data.vehicle_brand,
      data.vehicle_model,
      data.vehicle_year,
      data.vehicle_plate,
      data.vehicle_color,
      data.vehicle_category,
      data.appointment_date,
      data.start_time,
      data.end_time,
      data.service_name,
      data.service_price,
      data.modality_fee,
      data.total_price,
      data.price_is_estimate,
      data.status,
      data.address_zipcode,
      data.address_street,
      data.address_number,
      data.address_complement,
      data.address_neighborhood,
      data.address_city,
      data.address_state,
      data.address_reference,
      data.responsible_name,
      data.responsible_phone,
      data.has_water_access,
      data.has_power_access,
      data.key_delivery_confirmed,
      data.customer_notes
    );

  return db
    .prepare(
      `SELECT a.*, u.name AS unit_name, u.address AS unit_address,
              m.name AS modality_name, m.slug AS modality_slug
       FROM appointments a
       LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN service_modalities m ON m.id = a.modality_id
       WHERE a.id = ?`
    )
    .get(info.lastInsertRowid);
}

function assertSlotAvailable({ appointment_date, start_time, end_time, unit, capacity }) {
  const conflicts = getConflicts(appointment_date, unit ? unit.id : null)
    .filter((c) => overlaps(start_time, end_time, c.start_time, c.end_time));
  if (conflicts.length >= capacity) {
    throw new AppError(409, 'Este horário não está mais disponível. Escolha outro horário.');
  }
}

function createAppointment(body) {
  const data = validateAppointmentInput(body, { allowStatus: false });

  const settings = getSettings();
  const capacity = data.unit ? (data.unit.capacity || 1) : (settings.capacity || 1);

  const tx = db.transaction(() => {
    const c = countOverlaps(data.appointment_date, data.unit ? data.unit.id : null, data.start_time, data.end_time);
    if (c >= capacity) {
      throw new AppError(409, 'Este horário não está mais disponível. Escolha outro horário.');
    }
    return insertAppointment(data);
  });

  return tx();
}

module.exports = {
  validateAppointmentInput,
  insertAppointment,
  createAppointment,
  assertSlotAvailable,
  countOverlaps,
  calcServicePrice,
  getSettings
};
