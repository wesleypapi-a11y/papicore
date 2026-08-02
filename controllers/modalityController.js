const { getDb } = require('../database/tenantDatabase');
const { AppError } = require('../utils/helpers');

function list(req, res) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM service_modalities ORDER BY id ASC')
    .all();
  return res.json(rows);
}

function update(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM service_modalities WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Forma de atendimento não encontrada.');

  const { name, description, fee, active } = req.body || {};

  if (name !== undefined && String(name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome da forma de atendimento.');
  }
  if (fee !== undefined) {
    const feeNum = Number(fee);
    if (!Number.isFinite(feeNum) || feeNum < 0 || feeNum > 1000) {
      throw new AppError(400, 'A taxa deve ser um valor entre 0 e 1000.');
    }
  }

  const current = db.prepare('SELECT * FROM service_modalities WHERE id = ?').get(req.params.id);

  db.prepare(
    `UPDATE service_modalities SET
       name = ?, description = ?, fee = ?, active = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
    name !== undefined ? String(name).trim() : current.name,
    description !== undefined ? (description ? String(description).trim() : null) : current.description,
    fee !== undefined ? Number(fee) : current.fee,
    active !== undefined ? (active ? 1 : 0) : current.active,
    req.params.id
  );

  const row = db.prepare('SELECT * FROM service_modalities WHERE id = ?').get(req.params.id);
  return res.json(row);
}

module.exports = { list, update };
