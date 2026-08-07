/*
 * customerService.js
 *
 * Base de clientes e veículos dos pacotes de serviços (Fase 1).
 *
 * Histórico: a plataforma armazenava cliente e veículo apenas de forma
 * desnormalizada dentro de `appointments`. Para os pacotes precisamos de
 * entidades `customers` e `vehicles` no banco do tenant. Este serviço
 * centraliza:
 *   - busca de clientes (para o seletor da venda de pacote);
 *   - find-or-create de cliente a partir de nome/telefone (dados do
 *     agendamento ou da venda);
 *   - find-or-create de veículo por placa dentro de um cliente.
 *
 * Nunca recebe tenant_id do frontend: o banco é sempre o do contexto
 * (getTenantDb / runWithTenant).
 */

const { AppError, normalizePhone, normalizeBrazilianPhone, isValidPhone } = require('../utils/helpers');

function findCustomerByPhone(db, phone) {
  const normalized = normalizeBrazilianPhone(phone);
  if (!normalized) return null;
  const conflict = db.prepare("SELECT * FROM customer_phone_conflicts WHERE phone_normalized = ? AND status = 'PENDING'").get(normalized);
  if (conflict) throw new AppError(409, 'Há cadastros duplicados para este telefone. Revise os clientes antes de utilizar pacotes.');
  return db.prepare('SELECT * FROM customers WHERE phone_normalized = ? LIMIT 1').get(normalized) || null;
}

function findCustomerById(db, id) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return null;
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
}

function searchCustomers(db, term) {
  const query = String(term || '').trim();
  if (!query) {
    return db.prepare('SELECT * FROM customers ORDER BY name ASC LIMIT 50').all();
  }
  const nameLike = `%${query}%`;
  const phoneLike = `%${normalizeBrazilianPhone(query) || normalizePhone(query)}%`;
  return db.prepare(
    `SELECT * FROM customers
     WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? OR cpf LIKE ?
     ORDER BY name ASC LIMIT 50`
  ).all(nameLike, phoneLike, nameLike, nameLike);
}

function listCustomerVehicles(db, customerId) {
  return db.prepare('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY id ASC').all(customerId);
}

function getVehicleById(db, id) {
  if (!Number.isInteger(Number(id)) || Number(id) <= 0) return null;
  return db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(id));
}

function findVehicleByPlate(db, customerId, plate) {
  const normalized = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized) return null;
  return db.prepare(
    'SELECT * FROM vehicles WHERE customer_id = ? AND REPLACE(UPPER(plate), \' \', \'\') = ? ORDER BY id ASC LIMIT 1'
  ).get(customerId, normalized);
}

function validateCustomerInput({ name, phone, email, cpf }) {
  if (!name || String(name).trim().length < 2) {
    throw new AppError(400, 'Informe o nome do cliente.');
  }
  if (phone && (!isValidPhone(phone) || !normalizeBrazilianPhone(phone))) {
    throw new AppError(400, 'Telefone inválido.');
  }
  return {
    name: String(name).trim(),
    phone: phone ? normalizeBrazilianPhone(phone) : null,
    email: email ? String(email).trim().toLowerCase() : null,
    cpf: cpf ? String(cpf).replace(/\D/g, '') : null
  };
}

/*
 * Retorna o cliente existente (por telefone, priorizando dados completos) ou
 * cria um novo dentro de uma transação controlada por quem chama.
 * `tx` é o wrapper de transação quando a chamada já está dentro de uma
 * db.transaction — para reuso de prepared statements.
 */
function findOrCreateCustomer(db, data, tx) {
  const clean = validateCustomerInput(data);
  const existing = findCustomerByPhone(db, clean.phone);
  if (existing) {
    /* atualiza dados em branco se a nova fonte trouxer informação */
    const updates = [];
    const params = [];
    for (const key of ['name', 'email', 'cpf']) {
      if (clean[key] && !existing[key]) {
        updates.push(`${key} = ?`);
        params.push(clean[key]);
      }
    }
    if (updates.length) {
      params.push(existing.id);
      db.prepare(
        `UPDATE customers SET ${updates.join(', ')}, updated_at = datetime('now', 'localtime') WHERE id = ?`
      ).run(...params);
    }
    return { customer: { ...existing }, created: false };
  }

  const conn = tx && tx.prepare ? tx : db;
  const info = conn.prepare(
    `INSERT INTO customers (name, phone, phone_normalized, email, cpf) VALUES (?, ?, ?, ?, ?)`
  ).run(clean.name, clean.phone, clean.phone, clean.email, clean.cpf);
  return { customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid), created: true };
}

function findOrCreateVehicle(db, customerId, data, tx) {
  const brand = data.brand ? String(data.brand).trim() : null;
  const model = data.model ? String(data.model).trim() : null;
  const plate = data.plate ? String(data.plate).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const year = data.year ? String(data.year).trim() : null;
  const color = data.color ? String(data.color).trim() : null;
  const category = data.category || 'passeio';

  if (!model) throw new AppError(400, 'Informe o modelo do veículo.');

  if (plate) {
    const existing = findVehicleByPlate(db, customerId, plate);
    if (existing) {
      const updates = [];
      const params = [];
      for (const [key, value] of [['brand', brand], ['model', model], ['year', year], ['color', color], ['category', category]]) {
        if (value && existing[key] !== value) {
          updates.push(`${key} = ?`);
          params.push(value);
        }
      }
      if (updates.length) {
        params.push(existing.id);
        db.prepare(
          `UPDATE vehicles SET ${updates.join(', ')}, updated_at = datetime('now', 'localtime') WHERE id = ?`
        ).run(...params);
      }
      return { vehicle: { ...existing }, created: false };
    }
  }

  const conn = tx && tx.prepare ? tx : db;
  const info = conn.prepare(
    `INSERT INTO vehicles (customer_id, brand, model, year, plate, color, category) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(customerId, brand, model, year, plate, color, category);
  return { vehicle: db.prepare('SELECT * FROM vehicles WHERE id = ?').get(info.lastInsertRowid), created: true };
}

/* Cria um cliente a partir dos dados de um agendamento (nome + telefone). */
function ensureCustomerFromAppointment(db, data, tx) {
  const phone = data.customer_phone ? normalizeBrazilianPhone(data.customer_phone) : null;
  const existing = phone ? findCustomerByPhone(db, phone) : null;
  if (existing) return { customer: existing, created: false };
  return findOrCreateCustomer(db, {
    name: data.customer_name,
    phone: data.customer_phone,
    email: data.customer_email,
    cpf: data.customer_cpf
  }, tx);
}

/* Cria um veículo a partir dos dados de um agendamento (dentro do cliente). */
function ensureVehicleFromAppointment(db, customerId, data, tx) {
  if (!data.vehicle_model) return null;
  return findOrCreateVehicle(db, customerId, {
    brand: data.vehicle_brand,
    model: data.vehicle_model,
    year: data.vehicle_year,
    plate: data.vehicle_plate,
    color: data.vehicle_color,
    category: data.vehicle_category
  }, tx);
}

module.exports = {
  findCustomerByPhone,
  findCustomerById,
  getVehicleById,
  searchCustomers,
  listCustomerVehicles,
  findVehicleByPlate,
  validateCustomerInput,
  findOrCreateCustomer,
  findOrCreateVehicle,
  ensureCustomerFromAppointment,
  ensureVehicleFromAppointment
};
