const { getDb } = require('../database/tenantDatabase');
const {
  ACTIVE_STATUSES,
  parseWorkingDays,
  isWorkingDay,
  nowDateTime,
  minutesOf,
  todayStr
} = require('../utils/helpers');
const {
  lunchConfig,
  dailyProductiveMinutes,
  serviceDuration,
  addDaysStr,
  computeEndDateTime,
  dateTimeStr,
  datetimeOverlap,
  isLongService
} = require('./durationService');

function getUnit(id) {
  return getDb().prepare('SELECT * FROM units WHERE id = ?').get(id);
}

function getModality(id) {
  return getDb().prepare('SELECT * FROM service_modalities WHERE id = ?').get(id);
}

function getService(id) {
  return getDb().prepare('SELECT * FROM services WHERE id = ?').get(id);
}

function getBlocked(dateStr, unitIdForScope) {
  const db = getDb();
  const where = unitIdForScope
    ? 'blocked_date = ? AND (unit_id IS NULL OR unit_id = ?)'
    : 'blocked_date = ? AND unit_id IS NULL';
  const params = unitIdForScope ? [dateStr, unitIdForScope] : [dateStr];
  return db.prepare(`SELECT * FROM blocked_schedules WHERE ${where}`).all(...params);
}

function getFullDayBlockedDates(fromDate, toDate, unitIdForScope) {
  const db = getDb();
  if (unitIdForScope) {
    return db
      .prepare(
        `SELECT blocked_date FROM blocked_schedules
         WHERE blocked_date BETWEEN ? AND ? AND block_full_day = 1 AND (unit_id IS NULL OR unit_id = ?)`
      )
      .all(fromDate, toDate, unitIdForScope)
      .map((r) => r.blocked_date);
  }
  return db
    .prepare(
      `SELECT blocked_date FROM blocked_schedules
       WHERE blocked_date BETWEEN ? AND ? AND block_full_day = 1 AND unit_id IS NULL`
    )
    .all(fromDate, toDate)
    .map((r) => r.blocked_date);
}

/* Agendamentos ativos cujo intervalo toca a janela [fromDate, toDate]. */
function getConflicts(fromDate, toDate, unitIdForScope) {
  const db = getDb();
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const where = unitIdForScope
    ? `status IN (${placeholders}) AND unit_id = ? AND appointment_date <= ? AND COALESCE(end_date, appointment_date) >= ?`
    : `status IN (${placeholders}) AND appointment_date <= ? AND COALESCE(end_date, appointment_date) >= ?`;
  const params = unitIdForScope
    ? [...ACTIVE_STATUSES, unitIdForScope, toDate, fromDate]
    : [...ACTIVE_STATUSES, toDate, fromDate];
  return db
    .prepare(
      `SELECT id, appointment_date, end_date, start_time, end_time, appointment_code,
              customer_name, customer_phone, vehicle_model, vehicle_plate, status, service_name
       FROM appointments WHERE ${where}
       ORDER BY appointment_date ASC, start_time ASC`
    )
    .all(...params);
}

/* Calcula tudo que diz respeito a UM dia (funcionamento, bloqueios,
   agendamentos, capacidade) e gera a lista de horários. Extraído de
   getAvailability para ser reutilizado pelo calendário mensal — a lógica de
   agenda é uma única (nunca duplicada). */
function computeDayAvailability({ date, svcList, category = 'hatch', unit = null, settings }) {
  const opening = unit ? unit.opening_time : (settings && settings.default_opening_time) || '08:00';
  const closing = unit ? unit.closing_time : (settings && settings.default_closing_time) || '17:00';
  const interval = unit ? unit.appointment_interval : (settings && settings.default_interval) || 60;
  const capacity = unit ? (unit.capacity || 1) : (settings && settings.capacity) || 1;
  const workingDays = unit ? parseWorkingDays(unit.working_days) : parseWorkingDays((settings && settings.working_days) || []);
  const lunch = lunchConfig(unit, settings);

  const duration = svcList && svcList.length ? svcList.reduce((sum, s) => sum + serviceDuration(s, category), 0) : interval;
  const daily = dailyProductiveMinutes(opening, closing, lunch.start, lunch.end);
  const longService = isLongService(duration);

  const working = isWorkingDay(workingDays, date);
  const blocked = getBlocked(date, unit ? unit.id : null);
  const fullDayBlock = blocked.find((b) => b.block_full_day === 1);
  const blockedTimes = new Set(blocked.filter((b) => !b.block_full_day && b.blocked_time).map((b) => b.blocked_time));
  const blockedRanges = blocked
    .filter((b) => !b.block_full_day && b.blocked_time && b.blocked_time_end)
    .map((b) => ({ start: minutesOf(b.blocked_time), end: minutesOf(b.blocked_time_end) }));

  const fullDayBlockedDates = new Set(getFullDayBlockedDates(date, addDaysStr(date, 16), unit ? unit.id : null));
  const engineOpts = {
    opening,
    closing,
    lunchStart: lunch.start,
    lunchEnd: lunch.end,
    isDayAvailable: (d) => isWorkingDay(workingDays, d) && !fullDayBlockedDates.has(d)
  };

  const now = nowDateTime();

  const slotList = [];
  if (working && !fullDayBlock) {
    const startMinutes = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    for (let m = startMinutes(opening); m < startMinutes(closing); m += interval) {
      const time = fmt(m);
      if (blockedTimes.has(time)) continue;
      if (blockedRanges.some((r) => m >= r.start && m < r.end)) continue;
      if (date === now.date && time <= now.time) {
        slotList.push({ time, end_date: null, end_time: null, status: 'past', reason: 'Horário já passou' });
        continue;
      }

      const end = computeEndDateTime(date, time, duration, engineOpts);
      const fits = duration <= daily ? end.date === date : time === opening;
      if (!fits) continue;

      const startDT = dateTimeStr(date, time);
      const endDT = dateTimeStr(end.date, end.time);
      const overlapping = getConflicts(date, end.date, unit ? unit.id : null)
        .filter((c) => datetimeOverlap(startDT, endDT, dateTimeStr(c.appointment_date, c.start_time), dateTimeStr(c.end_date || c.appointment_date, c.end_time)));

      if (overlapping.length >= capacity) {
        slotList.push({
          time,
          end_date: end.date,
          end_time: end.time,
          status: 'occupied',
          reason: capacity === 1 ? 'Horário ocupado' : 'Capacidade esgotada',
          appointment: null
        });
      } else {
        slotList.push({ time, end_date: end.date, end_time: end.time, status: 'available' });
      }
    }
  }

  return {
    opening,
    closing,
    interval,
    capacity,
    workingDays,
    lunch,
    duration,
    daily,
    longService,
    working,
    fullDayBlock,
    blockedTimes,
    blockedRanges,
    fullDayBlockedDates,
    engineOpts,
    slotList,
    now
  };
}

function getAvailability({ date, service = null, services = null, category = 'hatch', modality, unit = null, settings, includeAppointments = false }) {
  const svcList = services && services.length ? services : (service ? [service] : []);
  const info = computeDayAvailability({ date, svcList, category, unit, settings });

  const slotList = info.slotList.map((s) => {
    if (includeAppointments && s.status === 'occupied') {
      const startDT = dateTimeStr(date, s.time);
      const endDT = dateTimeStr(s.end_date || date, s.end_time);
      const overlap = getConflicts(date, s.end_date || date, unit ? unit.id : null)
        .filter((c) => datetimeOverlap(startDT, endDT, dateTimeStr(c.appointment_date, c.start_time), dateTimeStr(c.end_date || c.appointment_date, c.end_time)));
      return { ...s, appointment: overlap.length ? overlap[0] : null };
    }
    return s;
  });

  let estimatedEnd = null;
  if (info.longService) {
    estimatedEnd = computeEndDateTime(date, info.opening, info.duration, info.engineOpts);
  }

  return {
    date,
    working: info.working,
    full_day_blocked: Boolean(info.fullDayBlock),
    modality_id: modality ? modality.id : null,
    modality_slug: modality ? modality.slug : null,
    service_id: svcList.length === 1 ? svcList[0].id : null,
    service_name: svcList.length === 1 ? svcList[0].name : null,
    service_ids: svcList.map((s) => s.id),
    service_names: svcList.map((s) => s.name),
    vehicle_category: category,
    duration_minutes: info.duration,
    is_long_service: info.longService,
    estimated_end_date: estimatedEnd ? estimatedEnd.date : null,
    estimated_end_time: estimatedEnd ? estimatedEnd.time : null,
    unit_id: unit ? unit.id : null,
    unit_name: unit ? unit.name : null,
    capacity: info.capacity,
    slots: slotList
  };
}

/* Disponibilidade de um mês inteiro para o calendário público: marca cada dia
   como 'available' (clicável), 'no_capacity' (não comporta o serviço),
   'closed', 'blocked' (bloqueio de dia inteiro) ou 'past'. Reutiliza a MESMA
   engine de horários (computeDayAvailability) — um dia só é liberado quando
   existe ao menos um horário de início onde o serviço inteiro cabe. */
function getMonthAvailability({ year, month, services = null, category = 'hatch', modality, unit = null, settings }) {
  const svcList = services && services.length ? services : [];
  const monthIndex = month - 1;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const today = todayStr();

  const days = [];
  let duration = 0;
  let longService = false;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const info = computeDayAvailability({ date: dateStr, svcList, category, unit, settings });
    duration = info.duration;
    longService = info.longService;

    let state;
    let reason = null;
    if (dateStr < today) {
      state = 'past';
      reason = 'Data no passado';
    } else if (!info.working) {
      state = 'closed';
      reason = 'Sem atendimento neste dia';
    } else if (info.fullDayBlock) {
      state = 'blocked';
      reason = 'Dia bloqueado';
    } else if (info.slotList.some((s) => s.status === 'available')) {
      state = 'available';
    } else if (dateStr === today && info.slotList.some((s) => s.status === 'past')) {
      state = 'no_capacity';
      reason = 'Sem horários restantes neste dia';
    } else {
      state = 'no_capacity';
      reason = 'Sem horário suficiente para este serviço';
    }
    days.push({ date: dateStr, state, reason });
  }

  return {
    year,
    month: monthIndex + 1,
    modality_id: modality ? modality.id : null,
    modality_slug: modality ? modality.slug : null,
    service_ids: svcList.map((s) => s.id),
    service_names: svcList.map((s) => s.name),
    vehicle_category: category,
    duration_minutes: duration,
    is_long_service: longService,
    unit_id: unit ? unit.id : null,
    unit_name: unit ? unit.name : null,
    days
  };
}

module.exports = {
  getAvailability,
  getMonthAvailability,
  computeDayAvailability,
  getUnit,
  getModality,
  getService,
  getBlocked,
  getConflicts,
  getFullDayBlockedDates
};
