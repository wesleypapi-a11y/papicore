class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const STATUSES = ['pending', 'confirmed', 'rejected', 'completed', 'cancelled'];

const STATUS_LABELS = {
  pending: 'Aguardando confirmação',
  confirmed: 'Confirmado',
  rejected: 'Recusado',
  completed: 'Concluído',
  cancelled: 'Cancelado'
};

const ACTIVE_STATUSES = ['pending', 'confirmed', 'completed'];

const PAYMENT_METHODS = ['local', 'card', 'pix', 'qrcode'];

const PAYMENT_LABELS = {
  local: 'Pagamento no local',
  card: 'Crédito ou débito no local',
  pix: 'Pix (copia e cola)',
  qrcode: 'Pix (QR Code)'
};

const VEHICLE_CATEGORIES = ['hatch', 'sedan', 'suv', 'pickup'];

const VEHICLE_CATEGORY_LABELS = {
  hatch: 'Hatch',
  sedan: 'Sedan',
  suv: 'SUV',
  pickup: 'Picape'
};

const REJECTION_REASONS = [
  'Horário indisponível',
  'Serviço indisponível',
  'Área fora da região de atendimento',
  'Necessário avaliar o veículo',
  'Outro'
];

function todayStr() {
  return toDateStr(new Date());
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && toDateStr(d) === s;
}

function isValidTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function formatMinutes(m) {
  const mm = Math.max(0, Math.min(23 * 60 + 59, m));
  const h = String(Math.floor(mm / 60)).padStart(2, '0');
  const min = String(mm % 60).padStart(2, '0');
  return `${h}:${min}`;
}

const PRODUCTIVE_MINUTES_PER_DAY = 480;

function formatDuration(minutes, opts = {}) {
  const m = Math.max(0, Number(minutes) || 0);
  const days = Math.floor(m / PRODUCTIVE_MINUTES_PER_DAY);
  const rem = m % PRODUCTIVE_MINUTES_PER_DAY;
  const hm = (r) => {
    const h = Math.floor(r / 60);
    const mm = r % 60;
    if (h === 0) return `${mm}min`;
    if (mm === 0) return `${h}h`;
    return `${h}h${String(mm).padStart(2, '0')}`;
  };
  if (days === 0) return hm(rem);
  if (rem === 0) return `${days} dia${days > 1 ? 's' : ''}`;
  return `${days} dia${days > 1 ? 's' : ''} + ${hm(rem)}`;
}

function addMinutes(time, mins) {
  return formatMinutes(minutesOf(time) + mins);
}

function buildSlots(opening, closing, interval) {
  const start = minutesOf(opening);
  const end = minutesOf(closing);
  const lastStart = end - interval;
  const slots = [];
  if (lastStart < start) return slots;
  for (let m = start; m <= lastStart; m += interval) {
    slots.push(formatMinutes(m));
  }
  return slots;
}

function buildSlotsWithDuration(opening, closing, interval, durationMinutes) {
  const start = minutesOf(opening);
  const end = minutesOf(closing);
  const lastStart = end - durationMinutes;
  const slots = [];
  if (lastStart < start) return slots;
  for (let m = start; m <= lastStart; m += interval) {
    slots.push(formatMinutes(m));
  }
  return slots;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return bStart < aEnd && aStart < bEnd;
}

function parseWorkingDays(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function isWorkingDay(workingDays, dateStr) {
  const day = new Date(`${dateStr}T00:00:00`).getDay();
  return workingDays.includes(day);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function isValidPhone(phone) {
  const digits = normalizePhone(phone);
  return digits.length >= 10 && digits.length <= 13;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidCPF(cpf) {
  const digits = String(cpf || '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(digits[i]) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

function isValidPlate(plate) {
  const p = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (p.length !== 7) return false;
  return /^[A-Z]{3}[0-9]{4}$/.test(p) || /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p);
}

function formatPhone(phone) {
  const d = normalizePhone(phone);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

function formatMoney(value) {
  const v = Number(value || 0);
  const [intPart, decPart] = v.toFixed(2).split('.');
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${formattedInt},${decPart}`;
}

function generateCode(dateStr) {
  const compact = dateStr.replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let random = '';
  for (let i = 0; i < 4; i += 1) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }
  return `AG-${compact}-${random}`;
}

function nowDateTime() {
  const d = new Date();
  const date = toDateStr(d);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

function startOfWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay();
  const diff = (dow + 6) % 7;
  return addDays(d, -diff);
}

function weekRange(dateStr) {
  const monday = startOfWeek(dateStr);
  const sunday = addDays(monday, 6);
  return { start: toDateStr(monday), end: toDateStr(sunday) };
}

module.exports = {
  AppError,
  STATUSES,
  STATUS_LABELS,
  ACTIVE_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_LABELS,
  VEHICLE_CATEGORIES,
  VEHICLE_CATEGORY_LABELS,
  REJECTION_REASONS,
  todayStr,
  slugify,
  toDateStr,
  addDays,
  isValidDateStr,
  isValidTime,
  minutesOf,
  formatMinutes,
  formatDuration,
  addMinutes,
  buildSlots,
  buildSlotsWithDuration,
  overlaps,
  parseWorkingDays,
  isWorkingDay,
  normalizePhone,
  isValidPhone,
  isValidEmail,
  isValidCPF,
  isValidPlate,
  formatPhone,
  formatMoney,
  generateCode,
  nowDateTime,
  startOfWeek,
  weekRange
};
