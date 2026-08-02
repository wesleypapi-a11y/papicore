const { minutesOf, formatMinutes, toDateStr } = require('../utils/helpers');

/* Produtivo diário = horário de atendimento menos o intervalo de almoço.
   Horário padrão 08:00-17:00 com almoço 12:00-13:00 => 8h úteis/dia. */
const LUNCH_DEFAULT = { start: '12:00', end: '13:00' };

function lunchConfig(unit, settings) {
  const start = (unit && unit.lunch_start) || (settings && settings.lunch_start) || LUNCH_DEFAULT.start;
  const end = (unit && unit.lunch_end) || (settings && settings.lunch_end) || LUNCH_DEFAULT.end;
  return { start: minutesOf(start), end: minutesOf(end) };
}

function dailyProductiveMinutes(opening, closing, lunchStart, lunchEnd) {
  const total = minutesOf(closing) - minutesOf(opening);
  const lunch = Math.max(0, lunchEnd - lunchStart);
  return Math.max(0, total - lunch);
}

/* Duração efetiva do serviço considerando o acréscimo para picape. */
function serviceDuration(service, category) {
  const base = Number(service && service.duration_minutes) || 60;
  const extra = category === 'pickup' ? (Number(service && service.pickup_extra_minutes) || 0) : 0;
  return base + extra;
}

function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/* Segmentos produtivos de um dia: [início, fim] em minutos (descontando o almoço). */
function segmentsForDate(dateStr, opts) {
  const { opening, closing, lunchStart, lunchEnd, isDayAvailable } = opts;
  if (!isDayAvailable(dateStr)) return [];
  const o = minutesOf(opening);
  const c = minutesOf(closing);
  if (c <= o) return [];
  const ls = lunchStart;
  const le = lunchEnd;
  const segs = [];
  if (le <= o || ls >= c) {
    segs.push([o, c]);
  } else {
    if (ls > o) segs.push([o, ls]);
    if (le < c) segs.push([le, c]);
  }
  return segs;
}

/* Calcula data/hora final de um serviço com duração em minutos, contando apenas
   horário produtivo: pula noite, almoço, domingos, dias fechados e bloqueados. */
function computeEndDateTime(startDate, startTime, durationMinutes, opts) {
  let remaining = Math.max(0, Number(durationMinutes) || 0);
  if (remaining === 0) return { date: startDate, time: startTime };

  let date = startDate;
  let time = minutesOf(startTime);
  const openingMin = minutesOf(opts.opening);
  let guard = 0;

  while (remaining > 0 && guard < 500) {
    guard += 1;
    const segs = segmentsForDate(date, opts);
    if (segs.length === 0) {
      date = addDaysStr(date, 1);
      time = openingMin;
      continue;
    }
    let idx = segs.findIndex(([s, e]) => time >= s && time < e);
    if (idx === -1) {
      idx = segs.findIndex(([s]) => s >= time);
      if (idx === -1) {
        date = addDaysStr(date, 1);
        time = openingMin;
        continue;
      }
      time = segs[idx][0];
    }
    const segEnd = segs[idx][1];
    const usable = segEnd - time;
    if (usable >= remaining) {
      return { date, time: formatMinutes(time + remaining) };
    }
    remaining -= usable;
    time = segEnd;
  }
  return { date, time: formatMinutes(time) };
}

/* Minutos produtivos entre dois instantes (data/hora), descontando períodos não produtivos. */
function productiveMinutesBetween(startDate, startTime, endDate, endTime, opts) {
  let total = 0;
  let date = startDate;
  const startMin = minutesOf(startTime);
  const endMin = minutesOf(endTime);
  let guard = 0;

  while (date <= endDate && guard < 500) {
    guard += 1;
    const segs = segmentsForDate(date, opts);
    if (segs.length) {
      const isFirst = date === startDate;
      const isLast = date === endDate;
      for (const [s, e] of segs) {
        let segStart = s;
        let segEnd = e;
        if (isFirst) segStart = Math.max(segStart, startMin);
        if (isLast) segEnd = Math.min(segEnd, endMin);
        if (segEnd > segStart) total += segEnd - segStart;
      }
    }
    date = addDaysStr(date, 1);
  }
  return total;
}

/* Converte data+hora em string comparável ('AAAA-MM-DDTHH:MM'). */
function dateTimeStr(date, time) {
  return `${date}T${time}`;
}

/* Regra de conflito: novoInicio < existenteFim && novoFim > existenteInicio */
function datetimeOverlap(newStartDT, newEndDT, existingStartDT, existingEndDT) {
  return newStartDT < existingEndDT && newEndDT > existingStartDT;
}

module.exports = {
  LUNCH_DEFAULT,
  lunchConfig,
  dailyProductiveMinutes,
  serviceDuration,
  addDaysStr,
  computeEndDateTime,
  productiveMinutesBetween,
  dateTimeStr,
  datetimeOverlap
};
