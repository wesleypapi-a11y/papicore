const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { addMinutes } = require('../utils/helpers');

const rootDir = path.join(__dirname, '..');
const dbFile = path.resolve(rootDir, process.env.DB_FILE || 'data/app.db');

if (!fs.existsSync(path.dirname(dbFile))) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
}

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------- Introspection helpers ---------- */
function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function ensureColumn(table, column, ddl) {
  if (!columnNames(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/* ---------- DDL ---------- */
const BASE_DDL = `
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  opening_time TEXT NOT NULL DEFAULT '08:00',
  closing_time TEXT NOT NULL DEFAULT '17:00',
  appointment_interval INTEGER NOT NULL DEFAULT 60,
  working_days TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT 'Torque Detail',
  phone TEXT,
  whatsapp TEXT,
  logo_url TEXT,
  default_opening_time TEXT NOT NULL DEFAULT '08:00',
  default_closing_time TEXT NOT NULL DEFAULT '17:00',
  default_interval INTEGER NOT NULL DEFAULT 60,
  working_days TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',
  confirmation_message TEXT NOT NULL DEFAULT 'Solicitação enviada com sucesso! Nossa equipe analisará a disponibilidade e entrará em contato pelo WhatsApp para confirmar.',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS service_modalities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  fee REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS service_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  price_type TEXT NOT NULL DEFAULT 'category',
  fixed_price REAL,
  price_hatch REAL,
  price_sedan REAL,
  price_suv REAL,
  price_pickup REAL,
  starting_price REAL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  package_items TEXT,
  available_at_unit INTEGER NOT NULL DEFAULT 1,
  available_pickup_delivery INTEGER NOT NULL DEFAULT 1,
  available_mobile_delivery INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

const appointmentsDDL = (table) => `
CREATE TABLE ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_code TEXT NOT NULL UNIQUE,
  modality_id INTEGER NOT NULL REFERENCES service_modalities(id),
  unit_id INTEGER REFERENCES units(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  customer_cpf TEXT,
  vehicle_brand TEXT,
  vehicle_model TEXT NOT NULL,
  vehicle_year TEXT,
  vehicle_plate TEXT,
  vehicle_color TEXT,
  vehicle_category TEXT NOT NULL DEFAULT 'hatch',
  appointment_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  service_name TEXT,
  service_price REAL NOT NULL DEFAULT 0,
  modality_fee REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  price_is_estimate INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  address_zipcode TEXT,
  address_street TEXT,
  address_number TEXT,
  address_complement TEXT,
  address_neighborhood TEXT,
  address_city TEXT,
  address_state TEXT,
  address_reference TEXT,
  responsible_name TEXT,
  responsible_phone TEXT,
  has_water_access INTEGER NOT NULL DEFAULT 0,
  has_power_access INTEGER NOT NULL DEFAULT 0,
  key_delivery_confirmed INTEGER NOT NULL DEFAULT 0,
  rejection_reason TEXT,
  rejection_message TEXT,
  approved_at TEXT,
  rejected_at TEXT,
  approved_by TEXT,
  rejected_by TEXT,
  customer_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

const blockedDDL = (table) => `
CREATE TABLE ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER REFERENCES units(id) ON DELETE CASCADE,
  blocked_date TEXT NOT NULL,
  blocked_time TEXT,
  block_full_day INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

db.exec(BASE_DDL);

/* ---------- units: novos campos de endereço ---------- */
ensureColumn('units', 'address_street', 'TEXT');
ensureColumn('units', 'address_number', 'TEXT');
ensureColumn('units', 'address_complement', 'TEXT');
ensureColumn('units', 'address_neighborhood', 'TEXT');
ensureColumn('units', 'address_city', 'TEXT');
ensureColumn('units', 'address_state', 'TEXT');
ensureColumn('units', 'address_zipcode', 'TEXT');
ensureColumn('units', 'address_reference', 'TEXT');
ensureColumn('units', 'maps_link', 'TEXT');
ensureColumn('units', 'capacity', 'INTEGER NOT NULL DEFAULT 1');

ensureColumn('company_settings', 'capacity', 'INTEGER NOT NULL DEFAULT 1');

/* ---------- appointments: rebuild quando schema antigo ---------- */
const STATUS_MAP = {
  'aguardando confirmacao': 'pending',
  'confirmado': 'confirmed',
  'em atendimento': 'confirmed',
  'concluido': 'completed',
  'cancelado': 'cancelled'
};

function migrateAppointments() {
  const oldRows = db.prepare('SELECT * FROM appointments').all();
  db.exec('DROP TABLE IF EXISTS appointments_new');
  db.exec(appointmentsDDL('appointments_new'));

  const insert = db.prepare(`
    INSERT INTO appointments_new (
      id, appointment_code, modality_id, unit_id, service_id,
      customer_name, customer_phone, customer_email, customer_cpf,
      vehicle_brand, vehicle_model, vehicle_year, vehicle_plate, vehicle_color, vehicle_category,
      appointment_date, start_time, end_time, service_name,
      service_price, modality_fee, total_price, price_is_estimate,
      status,
      address_zipcode, address_street, address_number, address_complement, address_neighborhood,
      address_city, address_state, address_reference,
      responsible_name, responsible_phone,
      has_water_access, has_power_access, key_delivery_confirmed,
      rejection_reason, rejection_message, approved_at, rejected_at, approved_by, rejected_by,
      customer_notes, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?
    )
  `);

  const migrate = db.transaction(() => {
    for (const r of oldRows) {
      const end = addMinutes(r.appointment_time || '08:00', 60);
      insert.run(
        r.id, r.appointment_code, 1, r.unit_id, null,
        r.customer_name, r.customer_phone, r.customer_email, null,
        null, r.vehicle_model, null, r.vehicle_plate, null, 'hatch',
        r.appointment_date, r.appointment_time, end, null,
        0, 0, 0, 0,
        STATUS_MAP[r.status] || 'pending',
        null, null, null, null, null, null, null, null,
        null, null,
        0, 0, 0,
        null, null, null, null, null, null,
        r.notes, r.created_at, r.updated_at
      );
    }
    db.exec('DROP TABLE appointments');
    db.exec('ALTER TABLE appointments_new RENAME TO appointments');
  });
  migrate();
}

/* ---------- Seed ---------- */
const SEED_MODALITIES = [
  { id: 1, name: 'Lavagem na unidade', slug: 'in-store', description: 'Você traz o veículo até a nossa unidade e nós cuidamos de tudo por aqui.', fee: 0 },
  { id: 2, name: 'Leva e traz', slug: 'pickup', description: 'Buscamos o veículo no endereço informado, realizamos o serviço e devolvemos no mesmo local.', fee: 20 },
  { id: 3, name: 'Delivery', slug: 'delivery', description: 'Levamos toda a estrutura até você e realizamos o serviço no seu endereço.', fee: 30 }
];

const SEED_CATEGORIES = [
  { id: 1, name: 'Torque Wash', slug: 'torque-wash', description: 'Lavagens técnicas e serviços de rotina para manter seu veículo impecável.', display_order: 1 },
  { id: 2, name: 'Torque Detail Premium', slug: 'torque-detail-premium', description: 'Higienização e detalhamento interno de alto padrão.', display_order: 2 },
  { id: 3, name: 'Torque Paint Correction', slug: 'torque-paint-correction', description: 'Polimento e correção de pintura com acabamento profissional.', display_order: 3 },
  { id: 4, name: 'Torque Ceramic Shield', slug: 'torque-ceramic-shield', description: 'Proteção cerâmica de longa duração para a pintura.', display_order: 4 },
  { id: 5, name: 'Torque Signature', slug: 'torque-signature', description: 'Pacotes completos de alto padrão para quem busca o melhor resultado.', display_order: 5 },
  { id: 6, name: 'Plano de Manutenção', slug: 'plano-de-manutencao', description: 'Os planos de manutenção são destinados principalmente a veículos que já realizaram vitrificação.', display_order: 6 }
];

const SEED_SERVICES = [
  // Torque Wash
  { id: 1, category_id: 1, name: 'Lavagem Técnica Premium', slug: 'lavagem-tecnica-premium', description: 'Lavagem técnica completa: pré-lavagem, espuma ativa, enxágue com água desmineralizada e acabamento.', price_type: 'category', price_hatch: 120, price_sedan: 140, price_suv: 160, price_pickup: 180, duration_minutes: 60, display_order: 1 },
  { id: 2, category_id: 1, name: 'Lavagem Detalhada', slug: 'lavagem-detalhada', description: 'Lavagem completa com atenção aos detalhes, incluindo soleiras, batentes e acabamentos.', price_type: 'category', price_hatch: 220, price_sedan: 250, price_suv: 290, price_pickup: 320, duration_minutes: 120, display_order: 2 },
  { id: 3, category_id: 1, name: 'Cristalização dos Vidros', slug: 'cristalizacao-dos-vidros', description: 'Aplicação de cristalização hidrofóbica em todos os vidros, melhorando a visibilidade e repelindo água.', price_type: 'category', price_hatch: 220, price_sedan: 250, price_suv: 300, price_pickup: 320, duration_minutes: 60, display_order: 3 },
  { id: 4, category_id: 1, name: 'Restauração de Faróis (par)', slug: 'restauracao-de-farois', description: 'Lixamento, polimento e aplicação de proteção UV para recuperar o brilho e a transparência dos faróis.', price_type: 'category', price_hatch: 250, price_sedan: 250, price_suv: 280, price_pickup: 280, duration_minutes: 90, display_order: 4 },
  { id: 5, category_id: 1, name: 'Limpeza Técnica do Motor', slug: 'limpeza-tecnica-do-motor', description: 'Limpeza segura do compartimento do motor com produtos específicos e proteção dos componentes.', price_type: 'category', price_hatch: 180, price_sedan: 180, price_suv: 220, price_pickup: 220, duration_minutes: 90, display_order: 5 },
  // Torque Detail Premium
  { id: 6, category_id: 2, name: 'Higienização Interna Completa', slug: 'higienizacao-interna-completa', description: 'Higienização profunda de bancos, carpetes, teto e painel, com extração de manchas e odores.', price_type: 'category', price_hatch: 380, price_sedan: 450, price_suv: 550, price_pickup: 600, duration_minutes: 180, display_order: 1 },
  // Torque Paint Correction
  { id: 7, category_id: 3, name: 'Polimento Comercial', slug: 'polimento-comercial', description: 'Polimento leve para renovar o brilho e remover marcas superficiais.', price_type: 'category', price_hatch: 450, price_sedan: 500, price_suv: 600, price_pickup: 650, duration_minutes: 240, display_order: 1 },
  { id: 8, category_id: 3, name: 'Polimento Técnico 1 etapa', slug: 'polimento-tecnico-1-etapa', description: 'Correção de pintura em 1 etapa, removendo marcas leves e hologramas.', price_type: 'category', price_hatch: 750, price_sedan: 850, price_suv: 950, price_pickup: 1050, duration_minutes: 360, display_order: 2 },
  { id: 9, category_id: 3, name: 'Polimento Técnico 2 etapas', slug: 'polimento-tecnico-2-etapas', description: 'Correção de pintura em 2 etapas, com remoção de marcas médias e leves.', price_type: 'category', price_hatch: 1150, price_sedan: 1300, price_suv: 1500, price_pickup: 1700, duration_minutes: 480, display_order: 3 },
  { id: 10, category_id: 3, name: 'Polimento Técnico 3 etapas', slug: 'polimento-tecnico-3-etapas', description: 'Correção de pintura em 3 etapas, o mais completo para pinturas muito danificadas.', price_type: 'category', price_hatch: 1600, price_sedan: 1850, price_suv: 2100, price_pickup: 2400, duration_minutes: 600, display_order: 4 },
  // Torque Ceramic Shield
  { id: 11, category_id: 4, name: 'Vitrificação 1 ano', slug: 'vitrificacao-1-ano', description: 'Aplicação de revestimento cerâmico com durabilidade de 1 ano.', price_type: 'category', price_hatch: 950, price_sedan: 1100, price_suv: 1250, price_pickup: 1350, duration_minutes: 480, display_order: 1 },
  { id: 12, category_id: 4, name: 'Vitrificação 3 anos', slug: 'vitrificacao-3-anos', description: 'Revestimento cerâmico de alta durabilidade com garantia de 3 anos.', price_type: 'category', price_hatch: 1750, price_sedan: 1950, price_suv: 2250, price_pickup: 2450, duration_minutes: 600, display_order: 2 },
  { id: 13, category_id: 4, name: 'Vitrificação 5 anos', slug: 'vitrificacao-5-anos', description: 'Revestimento cerâmico profissional com durabilidade de até 5 anos.', price_type: 'category', price_hatch: 2500, price_sedan: 2800, price_suv: 3100, price_pickup: 3500, duration_minutes: 720, display_order: 3 },
  // Torque Signature
  { id: 14, category_id: 5, name: 'Torque Signature Silver', slug: 'torque-signature-silver', description: 'Pacote premium de higienização e proteção.', price_type: 'fixed', fixed_price: 590, duration_minutes: 120, package_items: JSON.stringify(['Lavagem Técnica Premium', 'Limpeza interna completa', 'Higienização de rodas e pneus', 'Aplicação de cera de proteção', 'Aromatizador']), display_order: 1 },
  { id: 15, category_id: 5, name: 'Torque Signature Gold', slug: 'torque-signature-gold', description: 'Pacote completo com polimento e proteção de pintura.', price_type: 'fixed', fixed_price: 1490, duration_minutes: 240, package_items: JSON.stringify(['Tudo do pacote Silver', 'Polimento Comercial', 'Descontaminação de pintura', 'Proteção de pintura (selante)', 'Higienização interna com extração', 'Restauração de plásticos externos', 'Aromatizador premium']), display_order: 2 },
  { id: 16, category_id: 5, name: 'Torque Signature Black', slug: 'torque-signature-black', description: 'O pacote mais completo da casa, com correção de pintura e vitrificação. Valor a partir de R$ 2.590.', price_type: 'starting', starting_price: 2590, duration_minutes: 480, package_items: JSON.stringify(['Tudo do pacote Gold', 'Polimento Técnico 2 etapas', 'Vitrificação de pintura (1 ano)', 'Higienização interna de alto padrão', 'Tratamento de couro', 'Restauração de faróis (par)', 'Aromatizador premium', 'Revisão técnica completa']), display_order: 3 },
  // Plano de Manutenção
  { id: 17, category_id: 6, name: 'Lavagem Técnica + Inspeção', slug: 'lavagem-tecnica-inspecao', description: 'Lavagem técnica seguida de inspeção de pintura e superfícies.', price_type: 'fixed', fixed_price: 120, duration_minutes: 60, display_order: 1 },
  { id: 18, category_id: 6, name: 'Plano Mensal (2 lavagens)', slug: 'plano-mensal-2-lavagens', description: '2 lavagens técnicas por mês com prioridade de agendamento.', price_type: 'fixed', fixed_price: 220, duration_minutes: 60, display_order: 2 },
  { id: 19, category_id: 6, name: 'Plano Quinzenal (4 lavagens)', slug: 'plano-quinzenal-4-lavagens', description: '4 lavagens técnicas por mês com prioridade de agendamento.', price_type: 'fixed', fixed_price: 390, duration_minutes: 60, display_order: 3 }
];

seedCatalog();

if (!tableExists('appointments')) {
  db.exec(appointmentsDDL('appointments'));
} else if (!columnNames('appointments').includes('start_time')) {
  migrateAppointments();
}

/* ---------- blocked_schedules: unit_id passa a ser opcional ---------- */
function migrateBlockedSchedules() {
  const rows = db.prepare('SELECT * FROM blocked_schedules').all();
  db.exec('DROP TABLE IF EXISTS blocked_schedules_new');
  db.exec(blockedDDL('blocked_schedules_new'));
  const insert = db.prepare(
    'INSERT INTO blocked_schedules_new (id, unit_id, blocked_date, blocked_time, block_full_day, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const migrate = db.transaction(() => {
    for (const r of rows) insert.run(r.id, r.unit_id, r.blocked_date, r.blocked_time, r.block_full_day, r.reason, r.created_at);
    db.exec('DROP TABLE blocked_schedules');
    db.exec('ALTER TABLE blocked_schedules_new RENAME TO blocked_schedules');
  });
  migrate();
}

if (!tableExists('blocked_schedules')) {
  db.exec(blockedDDL('blocked_schedules'));
} else {
  const meta = db.prepare('PRAGMA table_info(blocked_schedules)').all();
  const unitCol = meta.find((c) => c.name === 'unit_id');
  if (unitCol && unitCol.notnull === 1) migrateBlockedSchedules();
}

/* ---------- índices ---------- */
db.exec(`
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments (appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status);
CREATE INDEX IF NOT EXISTS idx_appointments_modality ON appointments (modality_id);
CREATE INDEX IF NOT EXISTS idx_appointments_service ON appointments (service_id);
CREATE INDEX IF NOT EXISTS idx_appointments_unit_date ON appointments (unit_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_blocked_date ON blocked_schedules (blocked_date);
CREATE INDEX IF NOT EXISTS idx_blocked_unit ON blocked_schedules (unit_id);
`);

/* remove artefatos de migrações antigas que não tenham sido concluídas */
db.exec('DROP TABLE IF EXISTS appointments_new');
db.exec('DROP TABLE IF EXISTS blocked_schedules_new');

function seedCatalog() {
  const insertModality = db.prepare(
    'INSERT OR IGNORE INTO service_modalities (id, name, slug, description, fee, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  for (const m of SEED_MODALITIES) insertModality.run(m.id, m.name, m.slug, m.description, m.fee);

  const insertCategory = db.prepare(
    'INSERT OR IGNORE INTO service_categories (id, name, slug, description, display_order, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  for (const c of SEED_CATEGORIES) insertCategory.run(c.id, c.name, c.slug, c.description, c.display_order);

  const insertService = db.prepare(`
    INSERT OR IGNORE INTO services
      (id, category_id, name, slug, description, price_type, fixed_price,
       price_hatch, price_sedan, price_suv, price_pickup, starting_price,
       duration_minutes, package_items, available_at_unit, available_pickup_delivery,
       available_mobile_delivery, active, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?)
  `);
  for (const s of SEED_SERVICES) {
    insertService.run(
      s.id, s.category_id, s.name, s.slug, s.description, s.price_type,
      s.fixed_price ?? null, s.price_hatch ?? null, s.price_sedan ?? null,
      s.price_suv ?? null, s.price_pickup ?? null, s.starting_price ?? null,
      s.duration_minutes, s.package_items ?? null, s.display_order
    );
  }
}

function seed() {
  const insertSettings = db.prepare(`
    INSERT INTO company_settings
      (id, company_name, phone, whatsapp, logo_url,
       default_opening_time, default_closing_time, default_interval,
       working_days, confirmation_message)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const settings = db.prepare('SELECT id, company_name FROM company_settings WHERE id = 1').get();
  if (!settings) {
    insertSettings.run(
      'Torque Detail',
      '(34) 99999-0000',
      '(34) 99999-0000',
      '',
      '08:00',
      '17:00',
      60,
      JSON.stringify([1, 2, 3, 4, 5, 6]),
      'Solicitação enviada com sucesso! Nossa equipe analisará a disponibilidade e entrará em contato pelo WhatsApp para confirmar.'
    );
  } else if (settings.company_name === 'Lava Rápido') {
    db.prepare("UPDATE company_settings SET company_name = 'Torque Detail', updated_at = datetime('now', 'localtime') WHERE id = 1").run();
  }

  const unitCount = db.prepare('SELECT COUNT(*) AS total FROM units').get().total;
  if (unitCount === 0) {
    const insertUnit = db.prepare(`
      INSERT INTO units
        (name, address, phone, opening_time, closing_time, appointment_interval, working_days, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const working = JSON.stringify([1, 2, 3, 4, 5, 6]);
    insertUnit.run('Torque Detail — Centro', 'Rua das Flores, 123 — Centro', '(34) 99999-0001', '08:00', '17:00', 60, working);
  }

  const adminUser = db.prepare('SELECT id FROM users WHERE email = ?').get(process.env.ADMIN_EMAIL || 'admin@sistema.com');
  if (!adminUser) {
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
      process.env.ADMIN_NAME || 'Administrador',
      process.env.ADMIN_EMAIL || 'admin@sistema.com',
      hash,
      'admin'
    );
  }
}

seed();

module.exports = db;
