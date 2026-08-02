const db = require('../database/database');
const {
  AppError,
  isValidTime,
  isValidPhone,
  parseWorkingDays
} = require('../utils/helpers');

function get(req, res) {
  const s = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  if (!s) throw new AppError(404, 'Configurações não encontradas.');
  s.working_days = parseWorkingDays(s.working_days);
  return res.json(s);
}

function update(req, res) {
  const data = req.body || {};
  const {
    company_name,
    phone,
    whatsapp,
    logo_url,
    default_opening_time,
    default_closing_time,
    default_interval,
    working_days,
    confirmation_message,
    capacity
  } = data;

  if (!company_name || String(company_name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome da empresa.');
  }
  if (!isValidTime(default_opening_time)) throw new AppError(400, 'Horário de abertura inválido.');
  if (!isValidTime(default_closing_time)) throw new AppError(400, 'Horário de fechamento inválido.');
  if (default_closing_time <= default_opening_time) {
    throw new AppError(400, 'O horário de fechamento deve ser após a abertura.');
  }
  if (phone && !isValidPhone(phone)) throw new AppError(400, 'Telefone inválido.');
  if (whatsapp && !isValidPhone(whatsapp)) throw new AppError(400, 'WhatsApp inválido.');

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

  db.prepare(
    `INSERT INTO company_settings
       (id, company_name, phone, whatsapp, logo_url, default_opening_time, default_closing_time,
        default_interval, working_days, confirmation_message, capacity)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       company_name = excluded.company_name,
       phone = excluded.phone,
       whatsapp = excluded.whatsapp,
       logo_url = excluded.logo_url,
       default_opening_time = excluded.default_opening_time,
       default_closing_time = excluded.default_closing_time,
       default_interval = excluded.default_interval,
       working_days = excluded.working_days,
       confirmation_message = excluded.confirmation_message,
       capacity = excluded.capacity,
       updated_at = datetime('now', 'localtime')`
  ).run(
    String(company_name).trim(),
    phone ? String(phone).trim() : null,
    whatsapp ? String(whatsapp).trim() : null,
    logo_url ? String(logo_url).trim() : null,
    default_opening_time,
    default_closing_time,
    interval,
    JSON.stringify(days),
    confirmation_message ? String(confirmation_message).trim() : '',
    cap
  );

  const s = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  s.working_days = parseWorkingDays(s.working_days);
  return res.json(s);
}

module.exports = { get, update };
