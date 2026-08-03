const { getDb } = require('../database/tenantDatabase');
const { getUnit, getModality, getService, getConflicts, getFullDayBlockedDates } = require('./availabilityService');
const {
  lunchConfig,
  dailyProductiveMinutes,
  serviceDuration,
  addDaysStr,
  computeEndDateTime,
  productiveMinutesBetween,
  dateTimeStr,
  datetimeOverlap,
  isLongService
} = require('./durationService');
const {
  AppError,
  ACTIVE_STATUSES,
  STATUSES,
  PAYMENT_METHODS,
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
  nowDateTime,
  generateCode
} = require('../utils/helpers');

function getSettings() {
  const db = getDb();
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

function countOverlaps(startDT, endDT, unitIdForScope, excludeId = null) {
  const db = getDb();
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  let sql = `SELECT COUNT(*) AS c FROM appointments
             WHERE status IN (${placeholders})
               AND ? < (COALESCE(end_date, appointment_date) || 'T' || end_time)
               AND ? > (appointment_date || 'T' || start_time)`;
  const params = [...ACTIVE_STATUSES, startDT, endDT];
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
    service_ids,
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
    payment_method,
    status
  } = body || {};

  let paymentMethod = null;
  if (payment_method) {
    paymentMethod = String(payment_method).toLowerCase();
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      throw new AppError(400, 'Forma de pagamento inválida.');
    }
  }

  if (!Number.isInteger(modality_id) || modality_id <= 0) {
    throw new AppError(400, 'Selecione a forma de atendimento.');
  }
  const modality = getModality(modality_id);
  if (!modality || !modality.active) {
    throw new AppError(400, 'Forma de atendimento indisponível.');
  }

  const serviceIds = Array.isArray(service_ids) && service_ids.length
    ? service_ids.map(Number)
    : (Number.isInteger(service_id) && service_id > 0 ? [service_id] : []);

  if (!serviceIds.length || serviceIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new AppError(400, 'Selecione ao menos um serviço.');
  }
  const services = serviceIds.map((id) => getService(id));
  if (services.some((s) => !s || !s.active)) {
    throw new AppError(404, 'Serviço não encontrado ou desativado.');
  }

  for (const s of services) {
    if (modality.slug === 'in-store' && !s.available_at_unit) {
      throw new AppError(400, `O serviço "${s.name}" não está disponível na modalidade Lavagem na unidade.`);
    }
    if (modality.slug === 'pickup' && !s.available_pickup_delivery) {
      throw new AppError(400, `O serviço "${s.name}" não está disponível na modalidade Leva e traz.`);
    }
    if (modality.slug === 'delivery' && !s.available_mobile_delivery) {
      throw new AppError(400, `O serviço "${s.name}" não está disponível na modalidade Delivery.`);
    }
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
  if (!vehicle_year || !/^\d{4}$/.test(String(vehicle_year).trim())) {
    throw new AppError(400, 'Informe o ano do veículo.');
  }
  if (!vehicle_plate || !isValidPlate(vehicle_plate)) {
    throw new AppError(400, 'Informe uma placa válida. Use o formato ABC-1234 ou Mercosul.');
  }
  if (!vehicle_color || String(vehicle_color).trim().length < 2) {
    throw new AppError(400, 'Informe a cor do veículo.');
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

  const settings = getSettings();
  const duration = services.reduce((sum, s) => sum + serviceDuration(s, category), 0);
  const opening = unit ? unit.opening_time : settings.default_opening_time;
  const closing = unit ? unit.closing_time : settings.default_closing_time;
  const interval = unit ? unit.appointment_interval : settings.default_interval;
  const workingDays = unit ? parseWorkingDays(unit.working_days) : parseWorkingDays(settings.working_days);
  const lunch = lunchConfig(unit, settings);
  const daily = dailyProductiveMinutes(opening, closing, lunch.start, lunch.end);

  /* Serviço de longa duração: o cliente não escolhe horário na tela. Internamente
     usa-se o primeiro horário comercial do dia; o horário real é confirmado depois. */
  let startTime = start_time;
  if (isLongService(duration) && (!startTime || !isValidTime(startTime))) {
    startTime = opening;
  }
  if (!isValidTime(startTime)) {
    throw new AppError(400, 'Horário inválido. Use o formato HH:MM.');
  }

  if (!isWorkingDay(workingDays, appointment_date)) {
    throw new AppError(400, 'Não atendemos nesta data.');
  }

  const fullDayBlockedDates = new Set(getFullDayBlockedDates(appointment_date, addDaysStr(appointment_date, 16), unit ? unit.id : null));
  const engineOpts = {
    opening,
    closing,
    lunchStart: lunch.start,
    lunchEnd: lunch.end,
    isDayAvailable: (d) => isWorkingDay(workingDays, d) && !fullDayBlockedDates.has(d)
  };

  const validSlots = [];
  const startMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  for (let m = startMin(opening); m < startMin(closing); m += interval) {
    const time = fmt(m);
    const end = computeEndDateTime(appointment_date, time, duration, engineOpts);
    const fits = duration <= daily ? end.date === appointment_date : time === opening;
    if (fits) validSlots.push(time);
  }
  const manualEnd = opts.allowStatus && body.end_date && body.end_time && body.manual_end
    && isValidDateStr(body.end_date) && isValidTime(body.end_time);
  let end;
  let bookedDuration = duration;
  if (manualEnd) {
    end = { date: body.end_date, time: body.end_time };
    if (dateTimeStr(end.date, end.time) <= dateTimeStr(appointment_date, startTime)) {
      throw new AppError(400, 'O término deve ser após o início.');
    }
    bookedDuration = productiveMinutesBetween(appointment_date, startTime, end.date, end.time, engineOpts);
  } else {
    if (!validSlots.includes(startTime)) {
      throw new AppError(400, 'Horário fora do expediente para este serviço.');
    }
    end = computeEndDateTime(appointment_date, startTime, duration, engineOpts);
  }
  const now = nowDateTime();
  if (appointment_date === now.date && startTime <= now.time) {
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

  const servicePrice = services.reduce((sum, s) => sum + calcServicePrice(s, category), 0);
  const modalityFee = Number(modality.fee || 0);
  const totalPrice = servicePrice + modalityFee;
  const serviceName = services.map((s) => s.name).join(' + ');
  const servicesJson = JSON.stringify(services.map((s) => ({
    id: s.id,
    name: s.name,
    price: calcServicePrice(s, category),
    duration_minutes: serviceDuration(s, category)
  })));

  return {
    modality,
    services,
    unit,
    modality_id: modality.id,
    unit_id: unit ? unit.id : null,
    service_id: services[0].id,
    service_name: serviceName,
    services_json: servicesJson,
    duration,
    booked_duration_minutes: bookedDuration,
    end_date: end.date,
    end_time: end.time,
    service_price: servicePrice,
    modality_fee: modalityFee,
    total_price: totalPrice,
    price_is_estimate: services.some((s) => priceIsEstimate(s)) ? 1 : 0,
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
    start_time: startTime,
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
    payment_method: paymentMethod,
    customer_notes: customer_notes ? String(customer_notes).trim() : null
  };
}

function insertAppointment(data) {
  const db = getDb();
  const code = generateCode(data.appointment_date);

  const info = db
    .prepare(
      `INSERT INTO appointments
        (appointment_code, modality_id, unit_id, service_id,
         customer_name, customer_phone, customer_email, customer_cpf,
         vehicle_brand, vehicle_model, vehicle_year, vehicle_plate, vehicle_color, vehicle_category,
         appointment_date, start_time, end_date, end_time, booked_duration_minutes, service_name, services_json,
         service_price, modality_fee, total_price, price_is_estimate, status,
         address_zipcode, address_street, address_number, address_complement, address_neighborhood,
         address_city, address_state, address_reference,
         responsible_name, responsible_phone,
         has_water_access, has_power_access, key_delivery_confirmed,
         payment_method, customer_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      data.end_date,
      data.end_time,
      data.booked_duration_minutes,
      data.service_name,
      data.services_json,
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
      data.payment_method,
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

function assertSlotAvailable({ appointment_date, end_date, start_time, end_time, unit, capacity }) {
  const conflicts = getConflicts(appointment_date, end_date || appointment_date, unit ? unit.id : null)
    .filter((c) => datetimeOverlap(
      dateTimeStr(appointment_date, start_time),
      dateTimeStr(end_date || appointment_date, end_time),
      dateTimeStr(c.appointment_date, c.start_time),
      dateTimeStr(c.end_date || c.appointment_date, c.end_time)
    ));
  if (conflicts.length >= capacity) {
    throw new AppError(409, 'Este horário não está mais disponível. Escolha outro horário.');
  }
}

function createAppointment(body) {
  const db = getDb();
  const data = validateAppointmentInput(body, { allowStatus: false });

  const settings = getSettings();
  const capacity = data.unit ? (data.unit.capacity || 1) : (settings.capacity || 1);

  const tx = db.transaction(() => {
    const startDT = dateTimeStr(data.appointment_date, data.start_time);
    const endDT = dateTimeStr(data.end_date, data.end_time);
    const c = countOverlaps(startDT, endDT, data.unit ? data.unit.id : null);
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
