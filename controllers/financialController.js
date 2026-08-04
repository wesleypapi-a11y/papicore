const { getDb } = require('../database/tenantDatabase');
const {
  AppError,
  todayStr,
  isValidDateStr,
  isValidTime,
  weekRange
} = require('../utils/helpers');

const ENTRY_TYPES = ['entrada', 'saida'];

const ENTRY_SELECT = `
  SELECT e.*, s.name AS current_service_name
  FROM financial_entries e
  LEFT JOIN services s ON s.id = e.service_id
`;

function validateEntry(body, existingId) {
  const {
    customer_name,
    service_id,
    amount,
    type,
    entry_date,
    entry_time,
    payment_method,
    notes,
    appointment_id
  } = body || {};

  const entryType = type || 'entrada';
  if (!ENTRY_TYPES.includes(entryType)) {
    throw new AppError(400, 'Tipo de lançamento inválido.');
  }

  if (entryType === 'entrada') {
    if (!customer_name || String(customer_name).trim().length < 2) {
      throw new AppError(400, 'Informe o nome do cliente.');
    }
  }

  const date = entry_date || todayStr();
  if (!isValidDateStr(date)) {
    throw new AppError(400, 'Data inválida.');
  }

  const time = entry_time || '00:00';
  if (!isValidTime(time)) {
    throw new AppError(400, 'Horário inválido.');
  }

  const value = Number(amount);
  if (amount === undefined || amount === null || amount === '' || !Number.isFinite(value) || value < 0) {
    throw new AppError(400, 'Informe o valor (maior ou igual a zero).');
  }

  let svc = null;
  let serviceName = null;
  if (service_id && entryType === 'entrada') {
    const db = getDb();
    svc = db.prepare('SELECT id, name FROM services WHERE id = ?').get(service_id);
    if (!svc) throw new AppError(400, 'Serviço não encontrado.');
    serviceName = svc.name;
  }

  return {
    customer_name: entryType === 'entrada' ? String(customer_name).trim() : (customer_name ? String(customer_name).trim() : 'Saída'),
    service_id: svc ? svc.id : null,
    service_name: serviceName,
    amount: value,
    type: entryType,
    entry_date: date,
    entry_time: time,
    payment_method: payment_method ? String(payment_method).trim() : null,
    notes: notes ? String(notes).trim() : null,
    appointment_id: appointment_id != null && Number.isFinite(Number(appointment_id)) ? Number(appointment_id) : null
  };
}

function buildFilters(query) {
  const where = [];
  const params = [];

  if (query.from && isValidDateStr(query.from)) {
    where.push('e.entry_date >= ?');
    params.push(query.from);
  }
  if (query.to && isValidDateStr(query.to)) {
    where.push('e.entry_date <= ?');
    params.push(query.to);
  }
  if (query.service_id && query.service_id !== 'all' && query.service_id !== '') {
    where.push('e.service_id = ?');
    params.push(Number(query.service_id));
  }
  if (query.customer && String(query.customer).trim()) {
    where.push('e.customer_name LIKE ?');
    params.push(`%${String(query.customer).trim()}%`);
  }
  if (query.type && query.type !== 'all' && query.type !== '') {
    where.push('e.type = ?');
    params.push(query.type);
  }
  if (query.min !== undefined && query.min !== '' && Number.isFinite(Number(query.min))) {
    where.push('e.amount >= ?');
    params.push(Number(query.min));
  }
  if (query.max !== undefined && query.max !== '' && Number.isFinite(Number(query.max))) {
    where.push('e.amount <= ?');
    params.push(Number(query.max));
  }

  return { where, params };
}

function list(req, res) {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  let sql = ENTRY_SELECT;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY e.entry_date DESC, e.entry_time DESC, e.id DESC';

  const rows = db.prepare(sql).all(...params);
  return res.json(rows);
}

function create(req, res) {
  const db = getDb();
  const data = validateEntry(req.body);
  const info = db
    .prepare(
      `INSERT INTO financial_entries
        (customer_name, service_id, service_name, amount, type, entry_date, entry_time, payment_method, notes, appointment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.customer_name,
      data.service_id,
      data.service_name,
      data.amount,
      data.type,
      data.entry_date,
      data.entry_time,
      data.payment_method,
      data.notes,
      data.appointment_id
    );

  const row = db.prepare(ENTRY_SELECT + ' WHERE e.id = ?').get(info.lastInsertRowid);
  return res.status(201).json(row);
}

function update(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM financial_entries WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Lançamento financeiro não encontrado.');

  const data = validateEntry(req.body, existing.id);
  db.prepare(
    `UPDATE financial_entries SET
       customer_name = ?, service_id = ?, service_name = ?, amount = ?,
       type = ?, entry_date = ?, entry_time = ?, payment_method = ?, notes = ?,
       appointment_id = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
    data.customer_name,
    data.service_id,
    data.service_name,
    data.amount,
    data.type,
    data.entry_date,
    data.entry_time,
    data.payment_method,
    data.notes,
    data.appointment_id,
    existing.id
  );

  const row = db.prepare(ENTRY_SELECT + ' WHERE e.id = ?').get(existing.id);
  return res.json(row);
}

function remove(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM financial_entries WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Lançamento financeiro não encontrado.');
  db.prepare('DELETE FROM financial_entries WHERE id = ?').run(req.params.id);
  return res.json({ success: true });
}

function summary(req, res) {
  const db = getDb();
  const today = todayStr();
  const { start, end } = weekRange(today);
  const month = today.slice(0, 7);

  /* Soma por tipo em um único GROUP BY para evitar consultas duplicadas. */
  const totalsByType = (sql, ...params) => {
    const rows = db.prepare(sql).all(...params);
    const entrada = rows.find((r) => r.type === 'entrada');
    const saida = rows.find((r) => r.type === 'saida');
    const e = entrada ? Number(entrada.total || 0) : 0;
    const s = saida ? Number(saida.total || 0) : 0;
    return { entrada: e, saida: s, saldo: e - s };
  };
  const TYPE_SUM = 'SELECT type, COALESCE(SUM(amount), 0) AS total FROM financial_entries WHERE ';

  const totals = {
    day: totalsByType(TYPE_SUM + 'entry_date = ? GROUP BY type', today),
    week: totalsByType(TYPE_SUM + 'entry_date BETWEEN ? AND ? GROUP BY type', start, end),
    month: totalsByType(TYPE_SUM + "entry_date LIKE ? GROUP BY type", `${month}%`)
  };

  const { where, params } = buildFilters(req.query);
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const entradaWhereSql = whereSql + (where.length ? ' AND ' : ' WHERE ') + "e.type = 'entrada'";

  const filtered = totalsByType(
    `SELECT type, COALESCE(SUM(amount), 0) AS total FROM financial_entries e${whereSql} GROUP BY type`,
    ...params
  );
  const filteredCount = db
    .prepare(`SELECT COUNT(*) AS total FROM financial_entries e${whereSql}`)
    .get(...params).total;

  const byDay = db
    .prepare(
      `SELECT e.entry_date AS date, COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN e.type = 'entrada' THEN e.amount END), 0) AS total,
              COALESCE(SUM(CASE WHEN e.type = 'saida' THEN e.amount END), 0) AS saida,
              COALESCE(SUM(CASE WHEN e.type = 'entrada' THEN e.amount ELSE -e.amount END), 0) AS saldo
       FROM financial_entries e${whereSql}
       GROUP BY e.entry_date
       ORDER BY e.entry_date ASC`
    )
    .all(...params);

  const byService = db
    .prepare(
      `SELECT COALESCE(e.service_id, 0) AS service_id,
              COALESCE(e.service_name, 'Sem serviço') AS service_name,
              COUNT(*) AS count, COALESCE(SUM(e.amount), 0) AS total
       FROM financial_entries e${entradaWhereSql}
       GROUP BY COALESCE(e.service_id, 0), COALESCE(e.service_name, 'Sem serviço')
       ORDER BY total DESC`
    )
    .all(...params);

  const byClient = db
    .prepare(
      `SELECT e.customer_name, COUNT(*) AS count, COALESCE(SUM(e.amount), 0) AS total
       FROM financial_entries e${entradaWhereSql}
       GROUP BY e.customer_name
       ORDER BY total DESC`
    )
    .all(...params);

  return res.json({
    totals,
    filtered: { ...filtered, count: filteredCount },
    by_day: byDay,
    by_service: byService,
    by_client: byClient
  });
}

module.exports = { list, create, update, remove, summary };
