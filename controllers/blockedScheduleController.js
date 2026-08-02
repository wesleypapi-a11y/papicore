const db = require('../database/database');
const { AppError, isValidDateStr, isValidTime, todayStr } = require('../utils/helpers');

function list(req, res) {
  const { unit_id, date } = req.query;
  let sql = `
    SELECT b.*, u.name AS unit_name
    FROM blocked_schedules b
    LEFT JOIN units u ON u.id = b.unit_id
  `;
  const where = [];
  const params = [];

  if (unit_id && unit_id !== 'all') {
    where.push('b.unit_id = ?');
    params.push(Number(unit_id));
  }
  if (date && isValidDateStr(date)) {
    where.push('b.blocked_date = ?');
    params.push(date);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY b.blocked_date DESC, b.blocked_time ASC';

  return res.json(db.prepare(sql).all(...params));
}

function create(req, res) {
  const { unit_id, blocked_date, blocked_time, blocked_time_end, block_full_day, reason } = req.body || {};

  if (unit_id !== undefined && unit_id !== null && unit_id !== '' && unit_id !== 'null') {
    if (!Number.isInteger(Number(unit_id)) || Number(unit_id) <= 0) throw new AppError(400, 'Informe a unidade.');
    const unit = db.prepare('SELECT id FROM units WHERE id = ?').get(Number(unit_id));
    if (!unit) throw new AppError(404, 'Unidade não encontrada.');
  }

  if (!isValidDateStr(blocked_date)) throw new AppError(400, 'Data inválida. Use o formato AAAA-MM-DD.');

  const fullDay = block_full_day ? 1 : 0;
  if (!fullDay && !isValidTime(blocked_time)) {
    throw new AppError(400, 'Informe o horário a ser bloqueado ou marque a opção "dia inteiro".');
  }
  if (blocked_time_end) {
    if (!isValidTime(blocked_time_end)) throw new AppError(400, 'Horário final inválido.');
    if (fullDay) throw new AppError(400, 'O horário final não se aplica ao bloquear o dia inteiro.');
    if (blocked_time_end <= blocked_time) throw new AppError(400, 'O horário final deve ser maior que o horário inicial.');
  }
  if (blocked_date < todayStr()) {
    throw new AppError(400, 'Não é possível bloquear uma data no passado.');
  }

  const finalUnitId = unit_id === undefined || unit_id === null || unit_id === '' || unit_id === 'null'
    ? null
    : Number(unit_id);

  const info = db
    .prepare(
      `INSERT INTO blocked_schedules (unit_id, blocked_date, blocked_time, blocked_time_end, block_full_day, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(finalUnitId, blocked_date, fullDay ? null : blocked_time, fullDay ? null : (blocked_time_end || null), fullDay, reason ? String(reason).trim() : null);

  const row = db
    .prepare(
      `SELECT b.*, u.name AS unit_name FROM blocked_schedules b LEFT JOIN units u ON u.id = b.unit_id WHERE b.id = ?`
    )
    .get(info.lastInsertRowid);

  return res.status(201).json(row);
}

function remove(req, res) {
  const existing = db.prepare('SELECT id FROM blocked_schedules WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Bloqueio não encontrado.');
  db.prepare('DELETE FROM blocked_schedules WHERE id = ?').run(req.params.id);
  return res.json({ success: true });
}

module.exports = { list, create, remove };
