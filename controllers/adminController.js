const { getDb } = require('../database/tenantDatabase');
const { computeSetupStatus } = require('../database/tenantSchema');
const { getAvailability } = require('../services/availabilityService');
const { dateTimeStr } = require('../services/durationService');
const {
  validateAppointmentInput,
  insertAppointment,
  countOverlaps,
  getSettings
} = require('../services/appointmentService');
const {
  AppError,
  STATUSES,
  STATUS_LABELS,
  REJECTION_REASONS,
  todayStr,
  isValidDateStr,
  weekRange,
  normalizePhone
} = require('../utils/helpers');

const APPOINTMENT_SELECT = `
  SELECT a.*, u.name AS unit_name, m.name AS modality_name, m.slug AS modality_slug
  FROM appointments a
  LEFT JOIN units u ON u.id = a.unit_id
  LEFT JOIN service_modalities m ON m.id = a.modality_id
`;

function listAppointments(req, res) {
  const db = getDb();
  const { unit_id, modality_id, date, from, to, status, search } = req.query;
  const where = [];
  const params = [];

  if (unit_id && unit_id !== 'all') {
    where.push('a.unit_id = ?');
    params.push(Number(unit_id));
  }
  if (modality_id && modality_id !== 'all') {
    where.push('a.modality_id = ?');
    params.push(Number(modality_id));
  }
  if (date && isValidDateStr(date)) {
    where.push('a.appointment_date = ?');
    params.push(date);
  }
  /* Intervalo de datas (usado pela Agenda para carregar o mês inteiro em
     uma única consulta). Independente do filtro exato de "date" acima. */
  if (from && isValidDateStr(from)) {
    where.push('COALESCE(a.end_date, a.appointment_date) >= ?');
    params.push(from);
  }
  if (to && isValidDateStr(to)) {
    where.push('a.appointment_date <= ?');
    params.push(to);
  }
  if (status && status !== 'all') {
    where.push('a.status = ?');
    params.push(status);
  }
  if (search && String(search).trim()) {
    const term = String(search).trim();
    const nameLike = `%${term}%`;
    const phoneLike = `%${normalizePhone(term)}%`;
    where.push('(a.customer_name LIKE ? OR a.customer_phone LIKE ? OR a.appointment_code LIKE ? OR a.vehicle_plate LIKE ?)');
    params.push(nameLike, phoneLike, nameLike, nameLike);
  }

  let sql = APPOINTMENT_SELECT;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY a.appointment_date DESC, a.start_time DESC, a.id DESC';

  const rows = db.prepare(sql).all(...params);
  return res.json(rows);
}

function getAppointment(req, res) {
  const db = getDb();
  const appointment = db
    .prepare(APPOINTMENT_SELECT + ' WHERE a.id = ?')
    .get(req.params.id);

  if (!appointment) throw new AppError(404, 'Agendamento não encontrado.');
  return res.json(appointment);
}

function createAppointment(req, res) {
  const data = validateAppointmentInput(req.body, { allowStatus: true });
  const settings = getSettings();
  const capacity = data.unit ? (data.unit.capacity || 1) : (settings.capacity || 1);

  const c = countOverlaps(
    dateTimeStr(data.appointment_date, data.start_time),
    dateTimeStr(data.end_date, data.end_time),
    data.unit ? data.unit.id : null
  );
  if (c >= capacity) {
    throw new AppError(409, 'Este horário não está mais disponível. Escolha outro horário.');
  }

  const appointment = insertAppointment(data);
  return res.status(201).json(appointment);
}

function updateAppointment(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Agendamento não encontrado.');

  const data = validateAppointmentInput(req.body, { allowStatus: true });
  const settings = getSettings();
  const capacity = data.unit ? (data.unit.capacity || 1) : (settings.capacity || 1);

  const moved = (
    existing.appointment_date !== data.appointment_date ||
    existing.end_date !== data.end_date ||
    existing.start_time !== data.start_time ||
    existing.end_time !== data.end_time ||
    existing.unit_id !== data.unit_id ||
    existing.modality_id !== data.modality_id
  );
  if (moved) {
    const c = countOverlaps(
      dateTimeStr(data.appointment_date, data.start_time),
      dateTimeStr(data.end_date, data.end_time),
      data.unit ? data.unit.id : null,
      existing.id
    );
    if (c >= capacity) {
      throw new AppError(409, 'Este horário não está mais disponível. Escolha outro horário.');
    }
  }

  db.prepare(
    `UPDATE appointments SET
       modality_id = ?, unit_id = ?, service_id = ?,
       customer_name = ?, customer_phone = ?, customer_email = ?, customer_cpf = ?,
       vehicle_brand = ?, vehicle_model = ?, vehicle_year = ?, vehicle_plate = ?, vehicle_color = ?, vehicle_category = ?,
       appointment_date = ?, start_time = ?, end_date = ?, end_time = ?, booked_duration_minutes = ?, service_name = ?,
       service_price = ?, modality_fee = ?, total_price = ?, price_is_estimate = ?, status = ?,
       address_zipcode = ?, address_street = ?, address_number = ?, address_complement = ?, address_neighborhood = ?,
       address_city = ?, address_state = ?, address_reference = ?,
       responsible_name = ?, responsible_phone = ?,
       has_water_access = ?, has_power_access = ?, key_delivery_confirmed = ?,
       payment_method = ?, customer_notes = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
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
    data.customer_notes,
    existing.id
  );

  const appointment = db
    .prepare(APPOINTMENT_SELECT + ' WHERE a.id = ?')
    .get(existing.id);

  /* Conclusão pelo formulário de edição também gera a entrada automática. */
  if (data.status === 'completed' && existing.status !== 'completed') {
    registerEntryOnCompletion(db, appointment);
  }

  return res.json(appointment);
}

function updateStatus(req, res) {
  const db = getDb();
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) throw new AppError(400, 'Status inválido.');

  const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Agendamento não encontrado.');

  db.prepare("UPDATE appointments SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
    .run(status, req.params.id);

  /* Ao concluir um serviço, registra automaticamente no Financeiro o valor do
     agendamento como entrada (se ainda não houver lançamento vinculado). */
  if (status === 'completed' && existing.status !== 'completed') {
    registerEntryOnCompletion(db, existing);
  }

  const appointment = db
    .prepare(APPOINTMENT_SELECT + ' WHERE a.id = ?')
    .get(req.params.id);
  return res.json(appointment);
}

/*
 * Cria a entrada financeira automática ao concluir um agendamento.
 * Vincula o lançamento ao appointment_id e ignora caso o valor seja zero
 * (preço estimado sem valor definido) ou o lançamento já exista.
 */
function registerEntryOnCompletion(db, appointment) {
  const linked = db
    .prepare('SELECT id FROM financial_entries WHERE appointment_id = ? AND type = ?')
    .get(appointment.id, 'entrada');
  if (linked) return;

  const amount = Number(appointment.total_price) > 0
    ? Number(appointment.total_price)
    : (Number(appointment.service_price) > 0 ? Number(appointment.service_price) : 0);
  if (amount <= 0) return;

  let serviceId = appointment.service_id;
  if (serviceId) {
    const svc = db.prepare('SELECT id FROM services WHERE id = ?').get(serviceId);
    if (!svc) serviceId = null;
  }

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  db.prepare(
    `INSERT INTO financial_entries
      (customer_name, service_id, service_name, amount, type, entry_date, entry_time, payment_method, notes, appointment_id)
     VALUES (?, ?, ?, ?, 'entrada', ?, ?, ?, ?, ?)`
  ).run(
    appointment.customer_name,
    serviceId,
    appointment.service_name || null,
    amount,
    date,
    time,
    appointment.payment_method || null,
    `Entrada automática — agendamento ${appointment.appointment_code}`,
    appointment.id
  );
}

function acceptAppointment(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Agendamento não encontrado.');
  if (existing.status !== 'pending') {
    throw new AppError(400, 'Apenas agendamentos com status "Aguardando confirmação" podem ser aceitos.');
  }

  db.prepare(
    `UPDATE appointments SET status = 'confirmed', approved_at = datetime('now', 'localtime'),
       approved_by = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(req.user ? req.user.name : null, req.params.id);

  const appointment = db
    .prepare(APPOINTMENT_SELECT + ' WHERE a.id = ?')
    .get(req.params.id);

  const { notifyAppointmentConfirmed } = require('../services/whatsappService');
  notifyAppointmentConfirmed(appointment).catch((err) => {
    console.error('[whatsapp] Erro na confirmação ao cliente:', err.message);
  });

  return res.json(appointment);
}

function rejectAppointment(req, res) {
  const db = getDb();
  const { rejection_reason, rejection_message } = req.body || {};
  if (!REJECTION_REASONS.includes(rejection_reason)) {
    throw new AppError(400, 'Informe um motivo de recusa válido.');
  }

  const existing = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Agendamento não encontrado.');
  if (existing.status !== 'pending') {
    throw new AppError(400, 'Apenas agendamentos com status "Aguardando confirmação" podem ser recusados.');
  }

  db.prepare(
    `UPDATE appointments SET status = 'rejected', rejection_reason = ?, rejection_message = ?,
       rejected_at = datetime('now', 'localtime'), rejected_by = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
    rejection_reason,
    rejection_message ? String(rejection_message).trim() : null,
    req.user ? req.user.name : null,
    req.params.id
  );

  const appointment = db
    .prepare(APPOINTMENT_SELECT + ' WHERE a.id = ?')
    .get(req.params.id);
  return res.json(appointment);
}

function deleteAppointment(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM appointments WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Agendamento não encontrado.');
  db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  return res.json({ success: true });
}

function dashboard(req, res) {
  const db = getDb();
  const today = todayStr();
  const active = "status != 'cancelled' AND status != 'rejected'";

  const todayCount = db
    .prepare(`SELECT COUNT(*) AS total FROM appointments WHERE appointment_date = ? AND ${active}`)
    .get(today).total;

  const { start, end } = weekRange(today);
  const weekCount = db
    .prepare(`SELECT COUNT(*) AS total FROM appointments WHERE appointment_date BETWEEN ? AND ? AND ${active}`)
    .get(start, end).total;

  const month = today.slice(0, 7);
  const monthCount = db
    .prepare(`SELECT COUNT(*) AS total FROM appointments WHERE appointment_date LIKE ? AND ${active}`)
    .get(`${month}%`).total;

  const nowTime = new Date().toTimeString().slice(0, 5);
  const upcoming = db
    .prepare(
      `SELECT a.*, u.name AS unit_name, m.name AS modality_name
       FROM appointments a
       LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN service_modalities m ON m.id = a.modality_id
       WHERE a.status IN ('pending', 'confirmed')
         AND (a.appointment_date > ? OR (a.appointment_date = ? AND a.start_time >= ?))
       ORDER BY a.appointment_date ASC, a.start_time ASC
       LIMIT 5`
    )
    .all(today, today, nowTime);

  const units = db.prepare('SELECT * FROM units WHERE active = 1').all();
  let available = 0;
  let occupied = 0;
  let blocked = 0;

  for (const unit of units) {
    const availability = getAvailability({ date: today, service: null, modality: null, unit, settings: {} });
    for (const slot of availability.slots) {
      if (slot.status === 'available') available += 1;
      else if (slot.status === 'occupied') occupied += 1;
      else if (slot.status === 'blocked') blocked += 1;
    }
  }

  const pendingToday = db
    .prepare("SELECT COUNT(*) AS total FROM appointments WHERE appointment_date = ? AND status = 'pending'")
    .get(today).total;

  const setup = computeSetupStatus(db);

  return res.json({
    today: todayCount,
    week: weekCount,
    month: monthCount,
    upcoming,
    pending_today: pendingToday,
    today_slots: { available, occupied, blocked },
    setup_status: setup.status,
    setup_missing: setup.missing
  });
}

function agenda(req, res) {
  const db = getDb();
  const date = req.query.date && isValidDateStr(req.query.date) ? req.query.date : todayStr();
  const appointments = db
    .prepare(
      `SELECT a.*, u.name AS unit_name, m.name AS modality_name, m.slug AS modality_slug
       FROM appointments a
       LEFT JOIN units u ON u.id = a.unit_id
       LEFT JOIN service_modalities m ON m.id = a.modality_id
       WHERE a.appointment_date = ?
       ORDER BY a.start_time ASC, a.id ASC`
    )
    .all(date);

  return res.json({ date, appointments });
}

module.exports = {
  listAppointments,
  getAppointment,
  createAppointment,
  updateAppointment,
  updateStatus,
  acceptAppointment,
  rejectAppointment,
  deleteAppointment,
  dashboard,
  agenda,
  STATUS_LABELS
};
