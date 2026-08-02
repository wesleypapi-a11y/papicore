const { getDb } = require('../database/tenantDatabase');
const { AppError } = require('../utils/helpers');

const PRICE_TYPES = ['category', 'fixed', 'starting'];
const PRICE_FIELDS = ['price_hatch', 'price_sedan', 'price_suv', 'price_pickup'];

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parsePackageItems(raw) {
  if (Array.isArray(raw)) {
    return raw.map((i) => String(i).trim()).filter(Boolean);
  }
  return String(raw || '')
    .split('\n')
    .map((i) => i.trim())
    .filter(Boolean);
}

function validateService(body, existingId) {
  const db = getDb();
  const {
    category_id,
    name,
    description,
    price_type,
    fixed_price,
    price_hatch,
    price_sedan,
    price_suv,
    price_pickup,
    starting_price,
    duration_minutes,
    pickup_extra_minutes,
    package_items,
    available_at_unit,
    available_pickup_delivery,
    available_mobile_delivery,
    active,
    display_order
  } = body || {};

  if (!Number.isInteger(category_id) || category_id <= 0) {
    throw new AppError(400, 'Selecione a categoria do serviço.');
  }
  const category = db.prepare('SELECT id FROM service_categories WHERE id = ?').get(category_id);
  if (!category) throw new AppError(400, 'Categoria não encontrada.');

  if (!name || String(name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome do serviço.');
  }

  const type = price_type || 'category';
  if (!PRICE_TYPES.includes(type)) {
    throw new AppError(400, 'Tipo de preço inválido (use category, fixed ou starting).');
  }

  const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  let fixed = toNum(fixed_price);
  let hatch = toNum(price_hatch);
  let sedan = toNum(price_sedan);
  let suv = toNum(price_suv);
  let pickup = toNum(price_pickup);
  let starting = toNum(starting_price);

  if (type === 'fixed' && (fixed === null || fixed < 0)) {
    throw new AppError(400, 'Informe o preço fixo do serviço.');
  }
  if (type === 'starting' && (starting === null || starting < 0)) {
    throw new AppError(400, 'Informe o preço "a partir de".');
  }
  if (type === 'category') {
    const allNull = PRICE_FIELDS.every((f) => ({ hatch, sedan, suv, pickup }[f.slice(6)] === null));
    if (allNull) {
      throw new AppError(400, 'Informe ao menos um preço por categoria de veículo.');
    }
  }

  if (type !== 'category') {
    hatch = sedan = suv = pickup = null;
  }
  if (type !== 'fixed') fixed = null;
  if (type !== 'starting') starting = null;

  const duration = Number(duration_minutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 1440) {
    throw new AppError(400, 'A duração deve estar entre 15 e 1440 minutos.');
  }

  const pickupExtra = Number(pickup_extra_minutes);
  if (!Number.isInteger(pickupExtra) || pickupExtra < 0 || pickupExtra > 1440) {
    throw new AppError(400, 'O acréscimo para picape deve ser entre 0 e 1440 minutos.');
  }

  const slug = slugify(name);
  const dup = db.prepare('SELECT id FROM services WHERE slug = ? AND id != ?').get(slug, existingId || 0);
  if (dup) throw new AppError(409, 'Já existe um serviço com este nome.');

  const order = Number.isInteger(Number(display_order)) ? Number(display_order) : 0;

  return {
    category_id,
    name: String(name).trim(),
    slug,
    description: description ? String(description).trim() : null,
    price_type: type,
    fixed_price: fixed,
    price_hatch: hatch,
    price_sedan: sedan,
    price_suv: suv,
    price_pickup: pickup,
    starting_price: starting,
    duration_minutes: duration,
    pickup_extra_minutes: pickupExtra,
    package_items: parsePackageItems(package_items),
    available_at_unit: available_at_unit ? 1 : 0,
    available_pickup_delivery: available_pickup_delivery ? 1 : 0,
    available_mobile_delivery: available_mobile_delivery ? 1 : 0,
    active: active ? 1 : 0,
    display_order: order
  };
}

function list(req, res) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.*, c.name AS category_name, c.slug AS category_slug
       FROM services s
       JOIN service_categories c ON c.id = s.category_id
       ORDER BY c.display_order ASC, s.display_order ASC, s.id ASC`
    )
    .all();
  const result = rows.map((r) => ({ ...r, package_items: r.package_items ? JSON.parse(r.package_items) : [] }));
  return res.json(result);
}

function getOne(req, res) {
  const db = getDb();
  const service = db
    .prepare(
      `SELECT s.*, c.name AS category_name FROM services s JOIN service_categories c ON c.id = s.category_id WHERE s.id = ?`
    )
    .get(req.params.id);
  if (!service) throw new AppError(404, 'Serviço não encontrado.');
  service.package_items = service.package_items ? JSON.parse(service.package_items) : [];
  return res.json(service);
}

function create(req, res) {
  const db = getDb();
  const data = validateService(req.body);
  const info = db
    .prepare(
      `INSERT INTO services
        (category_id, name, slug, description, price_type, fixed_price,
         price_hatch, price_sedan, price_suv, price_pickup, starting_price,
         duration_minutes, pickup_extra_minutes, package_items, available_at_unit, available_pickup_delivery,
         available_mobile_delivery, active, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.category_id,
      data.name,
      data.slug,
      data.description,
      data.price_type,
      data.fixed_price,
      data.price_hatch,
      data.price_sedan,
      data.price_suv,
      data.price_pickup,
      data.starting_price,
      data.duration_minutes,
      data.pickup_extra_minutes,
      data.package_items.length ? JSON.stringify(data.package_items) : null,
      data.available_at_unit,
      data.available_pickup_delivery,
      data.available_mobile_delivery,
      data.active,
      data.display_order
    );

  return getOne({ params: { id: info.lastInsertRowid } }, res);
}

function update(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM services WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Serviço não encontrado.');

  const data = validateService(req.body, existing.id);
  db.prepare(
    `UPDATE services SET
       category_id = ?, name = ?, slug = ?, description = ?, price_type = ?, fixed_price = ?,
       price_hatch = ?, price_sedan = ?, price_suv = ?, price_pickup = ?, starting_price = ?,
       duration_minutes = ?, pickup_extra_minutes = ?, package_items = ?, available_at_unit = ?, available_pickup_delivery = ?,
       available_mobile_delivery = ?, active = ?, display_order = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
    data.category_id,
    data.name,
    data.slug,
    data.description,
    data.price_type,
    data.fixed_price,
    data.price_hatch,
    data.price_sedan,
    data.price_suv,
    data.price_pickup,
    data.starting_price,
    data.duration_minutes,
    data.pickup_extra_minutes,
    data.package_items.length ? JSON.stringify(data.package_items) : null,
    data.available_at_unit,
    data.available_pickup_delivery,
    data.available_mobile_delivery,
    data.active,
    data.display_order,
    existing.id
  );

  return getOne({ params: { id: existing.id } }, res);
}

function remove(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM services WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Serviço não encontrado.');

  const count = db
    .prepare('SELECT COUNT(*) AS total FROM appointments WHERE service_id = ?')
    .get(req.params.id).total;

  if (count > 0) {
    throw new AppError(409, 'Não é possível excluir um serviço com agendamentos vinculados. Desative-o em vez de excluir.');
  }

  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  return res.json({ success: true });
}

/* ---------- Categorias ---------- */
function listCategories(req, res) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM service_categories ORDER BY display_order ASC, id ASC')
    .all();
  return res.json(rows);
}

function createCategory(req, res) {
  const db = getDb();
  const { name, display_order } = req.body || {};
  if (!name || String(name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome da categoria.');
  }
  const slug = slugify(name);
  const dup = db.prepare('SELECT id FROM service_categories WHERE slug = ?').get(slug);
  if (dup) throw new AppError(409, 'Já existe uma categoria com este nome.');

  const info = db
    .prepare('INSERT INTO service_categories (name, slug, display_order, active) VALUES (?, ?, ?, 1)')
    .run(String(name).trim(), slug, Number.isInteger(Number(display_order)) ? Number(display_order) : 0);

  const row = db.prepare('SELECT * FROM service_categories WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json(row);
}

function updateCategory(req, res) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM service_categories WHERE id = ?').get(req.params.id);
  if (!existing) throw new AppError(404, 'Categoria não encontrada.');

  const { name, description, display_order, active } = req.body || {};
  if (name && String(name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome da categoria.');
  }

  const current = db.prepare('SELECT * FROM service_categories WHERE id = ?').get(req.params.id);
  const finalName = name ? String(name).trim() : current.name;
  const slug = slugify(finalName);
  const dup = db.prepare('SELECT id FROM service_categories WHERE slug = ? AND id != ?').get(slug, req.params.id);
  if (dup) throw new AppError(409, 'Já existe uma categoria com este nome.');

  db.prepare(
    `UPDATE service_categories SET
       name = ?, slug = ?, description = ?, display_order = ?, active = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(
    finalName,
    slug,
    description !== undefined ? (description ? String(description).trim() : null) : current.description,
    display_order !== undefined && Number.isInteger(Number(display_order)) ? Number(display_order) : current.display_order,
    active !== undefined ? (active ? 1 : 0) : current.active,
    req.params.id
  );

  const row = db.prepare('SELECT * FROM service_categories WHERE id = ?').get(req.params.id);
  return res.json(row);
}

module.exports = { list, getOne, create, update, remove, listCategories, createCategory, updateCategory };
