const db = require('../database/database');
const {
  AppError,
  ACTIVE_STATUSES,
  buildSlotsWithDuration,
  parseWorkingDays,
  isWorkingDay,
  overlaps,
  addMinutes,
  nowDateTime
} = require('../utils/helpers');

function getUnit(id) {
  return db.prepare('SELECT * FROM units WHERE id = ?').get(id);
}

function getModality(id) {
  return db.prepare('SELECT * FROM service_modalities WHERE id = ?').get(id);
}

function getService(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
}

function getBlocked(dateStr, unitIdForScope) {
  const where = unitIdForScope
    ? 'blocked_date = ? AND (unit_id IS NULL OR unit_id = ?)'
    : 'blocked_date = ? AND unit_id IS NULL';
  const params = unitIdForScope ? [dateStr, unitIdForScope] : [dateStr];
  return db.prepare(`SELECT * FROM blocked_schedules WHERE ${where}`).all(...params);
}

function getConflicts(dateStr, unitIdForScope) {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const where = unitIdForScope
    ? 'appointment_date = ? AND status IN (' + placeholders + ') AND unit_id = ?'
    : 'appointment_date = ? AND status IN (' + placeholders + ')';
  const params = unitIdForScope
    ? [dateStr, ...ACTIVE_STATUSES, unitIdForScope]
    : [dateStr, ...ACTIVE_STATUSES];
  return db
    .prepare(
      `SELECT id, start_time, end_time, appointment_code, customer_name, customer_phone,
              vehicle_model, vehicle_plate, status, service_name
       FROM appointments WHERE ${where} ORDER BY start_time ASC`
    )
    .all(...params);
}

function getAvailability({ date, service, modality, unit = null, settings, includeAppointments = false }) {
  const duration = service ? Number(service.duration_minutes) : (unit ? unit.appointment_interval : (settings && settings.default_interval) || 60);
  const workingDays = unit ? parseWorkingDays(unit.working_days) : parseWorkingDays((settings && settings.working_days) || []);
  const opening = unit ? unit.opening_time : (settings && settings.default_opening_time) || '08:00';
  const closing = unit ? unit.closing_time : (settings && settings.default_closing_time) || '17:00';
  const interval = unit ? unit.appointment_interval : (settings && settings.default_interval) || 60;
  const capacity = unit ? (unit.capacity || 1) : (settings && settings.capacity) || 1;

  const working = isWorkingDay(workingDays, date);
  const slots = working ? buildSlotsWithDuration(opening, closing, interval, duration) : [];

  const blocked = getBlocked(date, unit ? unit.id : null);
  const fullDayBlock = blocked.find((b) => b.block_full_day === 1);
  const blockedTimes = new Set(blocked.filter((b) => !b.block_full_day && b.blocked_time).map((b) => b.blocked_time));

  const conflicts = getConflicts(date, unit ? unit.id : null);
  const now = nowDateTime();

  const slotList = slots.map((time) => {
    let status = 'available';
    let reason = null;
    let appointment = null;

    if (fullDayBlock) {
      status = 'blocked';
      reason = fullDayBlock.reason || 'Indisponível';
    } else if (blockedTimes.has(time)) {
      status = 'blocked';
      reason = 'Indisponível';
    } else if (date === now.date && time <= now.time) {
      status = 'past';
      reason = 'Horário já passou';
    } else {
      const end = addMinutes(time, duration);
      const overlapping = conflicts.filter((c) => overlaps(time, end, c.start_time, c.end_time));
      if (overlapping.length >= capacity) {
        status = 'occupied';
        reason = capacity === 1 ? 'Horário ocupado' : 'Capacidade esgotada';
        if (includeAppointments && overlapping.length) appointment = overlapping[0];
      }
    }

    return { time, status, reason, appointment };
  });

  return {
    date,
    working,
    full_day_blocked: Boolean(fullDayBlock),
    modality_id: modality ? modality.id : null,
    modality_slug: modality ? modality.slug : null,
    service_id: service ? service.id : null,
    service_name: service ? service.name : null,
    duration_minutes: duration,
    unit_id: unit ? unit.id : null,
    unit_name: unit ? unit.name : null,
    capacity,
    slots: slotList
  };
}

module.exports = { getAvailability, getUnit, getModality, getService, getBlocked, getConflicts };
