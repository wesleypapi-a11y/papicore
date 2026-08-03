const { getDb } = require('../database/tenantDatabase');
const {
  AppError,
  isValidTime,
  isValidPhone,
  parseWorkingDays
} = require('../utils/helpers');

function listAll(req, res) {
  const db = getDb();
  const units = db.prepare('SELECT * FROM units ORDER BY name ASC').all();
  const result = units.map((u) => ({ ...u, working_days: parseWorkingDays(u.working_days) }));
  return res.json(result);
}

function getOne(req, res) {
  const db = getDb();
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  if (!unit) throw new AppError(404, 'Unidade não encontrada.');
  unit.working_days = parseWorkingDays(unit.working_days);
  return res.json(unit);
}

function buildAddress(data) {
  const street = data.address_street !== undefined ? String(data.address_street || '').trim() : '';
  const number = data.address_number !== undefined ? String(data.address_number || '').trim() : '';
  const complement = data.address_complement !== undefined ? String(data.address_complement || '').trim() : '';
  const neighborhood = data.address_neighborhood !== undefined ? String(data.address_neighborhood || '').trim() : '';
  const city = data.address_city !== undefined ? String(data.address_city || '').trim() : '';
  const state = data.address_state !== undefined ? String(data.address_state || '').trim() : '';
  const zipcode = data.address_zipcode !== undefined ? String(data.address_zipcode || '').trim() : '';

  const hasGranular = data.address_street !== undefined;
  const combined = String(data.address || '').trim();
  const granular = [street, number, complement, neighborhood, city, state].filter(Boolean).join(', ');
  const address = (hasGranular ? granular : '') || combined;

  if (!address) {
    throw new AppError(400, 'Informe o endereço da unidade.');
  }

  return {
    address,
    address_street: street,
    address_number: number,
    address_complement: complement,
    address_neighborhood: neighborhood,
    address_city: city,
    address_state: state,
    address_zipcode: zipcode
  };
}

function validateUnit(data) {
  const { name, address, phone, opening_time, closing_time, lunch_start, lunch_end, appointment_interval, working_days, active, capacity, maps_link, address_reference } = data;

  if (!name || String(name).trim().length < 2) throw new AppError(400, 'Informe o nome da unidade.');
  if (!isValidPhone(phone)) throw new AppError(400, 'Informe um telefone válido.');
  if (!isValidTime(opening_time)) throw new AppError(400, 'Horário de abertura inválido.');
  if (!isValidTime(closing_time)) throw new AppError(400, 'Horário de fechamento inválido.');
  if (closing_time <= opening_time) throw new AppError(400, 'O horário de fechamento deve ser após a abertura.');
  if (lunch_start && !isValidTime(lunch_start)) throw new AppError(400, 'Início do almoço inválido.');
  if (lunch_end && !isValidTime(lunch_end)) throw new AppError(400, 'Fim do almoço inválido.');
  if (lunch_start && lunch_end && lunch_end <= lunch_start) {
    throw new AppError(400, 'O fim do almoço deve ser após o início.');
  }

  const interval = Number(appointment_interval);
  if (!Number.isInteger(interval) || interval < 15 || interval > 240) {
    throw new AppError(400, 'O intervalo entre agendamentos deve estar entre 15 e 240 minutos.');
  }

  let cap = Number(capacity);
  if (!Number.isInteger(cap) || cap < 1 || cap > 20) {
    throw new AppError(400, 'A capacidade de atendimento deve estar entre 1 e 20.');
  }

  const days = Array.isArray(working_days)
    ? [...new Set(working_days.map(Number).filter((d) => d >= 0 && d <= 6))]
    : parseWorkingDays(working_days);
  if (days.length === 0) throw new AppError(400, 'Selecione pelo menos um dia de funcionamento.');

  const addr = buildAddress(data);

  return {
    name: String(name).trim(),
    ...addr,
    address_reference: address_reference ? String(address_reference).trim() : null,
    maps_link: maps_link ? String(maps_link).trim() : null,
    phone: String(phone).trim(),
    opening_time,
    closing_time,
    lunch_start: lunch_start ? String(lunch_start).trim() : '12:00',
    lunch_end: lunch_end ? String(lunch_end).trim() : '13:00',
    appointment_interval: interval,
    capacity: cap,
    working_days: JSON.stringify(days),
    active: active ? 1 : 0
  };
}

function create(req, res) {
  const db = getDb();
  const data = validateUnit(req.body || {});
  const info = db
    .prepare(
      `INSERT INTO units
        (name, address, address_street, address_number, address_complement, address_neighborhood,
         address_city, address_state, address_zipcode, address_reference, maps_link,
         phone, opening_time, closing_time, lunch_start, lunch_end, appointment_interval, capacity, working_days, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name, data.address, data.address_street, data.address_number, data.address_complement,
      data.address_neighborhood, data.address_city, data.address_state, data.address_zipcode,
      data.address_reference, data.maps_link, data.phone, data.opening_time, data.closing_time,
      data.lunch_start, data.lunch_end, data.appointment_interval, data.capacity, data.working_days, data.active
    );

  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(info.lastInsertRowid);
  unit.working_days = parseWorkingDays(unit.working_days);
  return res.status(201).json(unit);
}

function update(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Unidade não encontrada.');

  const body = { ...req.body };
  const hasAddress =
    Boolean(body.address && String(body.address).trim()) ||
    Boolean(body.address_street !== undefined && String(body.address_street).trim());
  if (!hasAddress && existing.address) body.address = existing.address;

  const data = validateUnit(body);
  db.prepare(
    `UPDATE units SET
       name = ?, address = ?, address_street = ?, address_number = ?, address_complement = ?,
       address_neighborhood = ?, address_city = ?, address_state = ?, address_zipcode = ?,
       address_reference = ?, maps_link = ?, phone = ?, opening_time = ?, closing_time = ?,
       lunch_start = ?, lunch_end = ?, appointment_interval = ?, capacity = ?, working_days = ?, active = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
    data.name, data.address, data.address_street, data.address_number, data.address_complement,
    data.address_neighborhood, data.address_city, data.address_state, data.address_zipcode,
    data.address_reference, data.maps_link, data.phone, data.opening_time, data.closing_time,
    data.lunch_start, data.lunch_end, data.appointment_interval, data.capacity, data.working_days, data.active, req.params.id
  );

  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  unit.working_days = parseWorkingDays(unit.working_days);
  return res.json(unit);
}

function remove(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM units WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Unidade não encontrada.');

  const count = db
    .prepare("SELECT COUNT(*) AS total FROM appointments WHERE unit_id = ? AND status NOT IN ('cancelled', 'rejected')")
    .get(req.params.id).total;

  if (count > 0) {
    throw new AppError(409, 'Não é possível excluir a unidade pois existem agendamentos vinculados. Desative a unidade em vez de excluí-la.');
  }

  db.prepare('DELETE FROM units WHERE id = ?').run(req.params.id);
  return res.json({ success: true });
}

module.exports = { listAll, getOne, create, update, remove };
