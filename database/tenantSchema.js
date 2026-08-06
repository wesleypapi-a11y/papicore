/*
 * tenantSchema.js
 *
 * Schema e migrações dos bancos de cada empresa (tenant).
 *
 * Cada empresa possui um arquivo SQLite próprio em data/tenants/tenant_XXXX_slug.db.
 * Este módulo centraliza:
 *   - DDL das tabelas de negócio (unidades, configurações, modalidades, categorias,
 *     serviços, agendamentos, bloqueios e entradas financeiras);
 *   - migrações idempotentes (colunas novas, rebuilds de tabelas, índices);
 *   - dados padrão criados ao abrir uma nova empresa (configurações, unidade,
 *     modalidades, categorias e — quando informado — catálogo completo).
 *
 * IMPORTANTE: tabelas de usuários/autenticação NÃO ficam aqui. Elas vivem no
 * banco central (papi_core.db). O banco da empresa armazena apenas dados de
 * negócio, garantindo isolamento total entre empresas.
 */

const { addMinutes, parseWorkingDays } = require('../utils/helpers');

/* ---------- Introspection ---------- */

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function ensureColumn(db, table, column, ddl) {
  if (!columnNames(db, table).includes(column)) {
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
  company_name TEXT NOT NULL DEFAULT 'Empresa',
  phone TEXT,
  whatsapp TEXT,
  logo_url TEXT,
  default_opening_time TEXT NOT NULL DEFAULT '08:00',
  default_closing_time TEXT NOT NULL DEFAULT '17:00',
  default_interval INTEGER NOT NULL DEFAULT 60,
  working_days TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',
  confirmation_message TEXT NOT NULL DEFAULT 'Solicitação enviada com sucesso! Nossa equipe analisará a disponibilidade e entrará em contato pelo WhatsApp para confirmar.',
  payment_methods_enabled TEXT NOT NULL DEFAULT '["local","card","pix","qrcode"]',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
  pickup_extra_minutes INTEGER NOT NULL DEFAULT 60,
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
  end_date TEXT,
  end_time TEXT NOT NULL,
  booked_duration_minutes INTEGER NOT NULL DEFAULT 60,
  service_name TEXT,
  services_json TEXT,
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
  payment_method TEXT,
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
  blocked_time_end TEXT,
  block_full_day INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

const financialDDL = `
CREATE TABLE IF NOT EXISTS financial_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT,
  amount REAL NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'entrada',
  entry_date TEXT NOT NULL,
  entry_time TEXT NOT NULL DEFAULT '00:00',
  payment_method TEXT,
  notes TEXT,
  appointment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

/* ---------- Pacotes de serviços (Fase 1) ---------- */

const customersDDL = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  cpf TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);
`;

const vehiclesDDL = `
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  brand TEXT,
  model TEXT NOT NULL,
  year TEXT,
  plate TEXT,
  color TEXT,
  category TEXT NOT NULL DEFAULT 'hatch',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles (customer_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles (plate);
`;

/* Modelo de pacote (oferta cadastrada pela empresa). */
const servicePackagesDDL = `
CREATE TABLE IF NOT EXISTS service_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  validity_days INTEGER,
  is_vehicle_bound INTEGER NOT NULL DEFAULT 0,
  is_transferable INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

const servicePackageItemsDDL = `
CREATE TABLE IF NOT EXISTS service_package_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES service_packages(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (package_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_sp_items_package ON service_package_items (package_id);
`;

/* Pacote vendido (compra específica de um cliente). */
const customerPackagesDDL = `
CREATE TABLE IF NOT EXISTS customer_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  package_id INTEGER NOT NULL REFERENCES service_packages(id),
  package_name_snapshot TEXT NOT NULL,
  price_cents_snapshot INTEGER NOT NULL,
  purchase_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  purchased_at TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL,
  notes TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customer_packages_customer ON customer_packages (customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_packages_status ON customer_packages (status);
`;

/* Saldo por serviço de um pacote vendido. available é sempre calculado:
   total + adjusted - reserved - consumed. */
const customerPackageBalancesDDL = `
CREATE TABLE IF NOT EXISTS customer_package_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_package_id INTEGER NOT NULL REFERENCES customer_packages(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  service_name_snapshot TEXT NOT NULL,
  total_quantity INTEGER NOT NULL,
  reserved_quantity INTEGER NOT NULL DEFAULT 0,
  consumed_quantity INTEGER NOT NULL DEFAULT 0,
  adjusted_quantity INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (customer_package_id, service_id)
);
CREATE INDEX IF NOT EXISTS idx_cpb_customer_package ON customer_package_balances (customer_package_id);
`;

/* Movimentações do pacote. Histórico imutável — nunca apagar.
   appointment_id é apenas uma referência suave (sem FK) para que o histórico
   sobreviva à exclusão de um agendamento. */
const packageTransactionsDDL = `
CREATE TABLE IF NOT EXISTS package_transactions (
  id TEXT PRIMARY KEY,
  customer_package_id INTEGER NOT NULL REFERENCES customer_packages(id),
  balance_id INTEGER NOT NULL REFERENCES customer_package_balances(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  appointment_id INTEGER,
  transaction_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_pt_customer_package ON package_transactions (customer_package_id);
CREATE INDEX IF NOT EXISTS idx_pt_balance ON package_transactions (balance_id);
CREATE INDEX IF NOT EXISTS idx_pt_appointment ON package_transactions (appointment_id);
CREATE INDEX IF NOT EXISTS idx_pt_created ON package_transactions (created_at);
`;

/* ---------- Dados padrão ---------- */

const SEED_MODALITIES = [
  { id: 1, name: 'Lavagem na unidade', slug: 'in-store', description: 'Você traz o veículo até a nossa unidade e nós cuidamos de tudo por aqui.', fee: 0 },
  { id: 2, name: 'Leva e traz', slug: 'pickup', description: 'Buscamos o veículo no endereço informado, realizamos o serviço e devolvemos no mesmo local.', fee: 0 },
  { id: 3, name: 'Delivery', slug: 'delivery', description: 'Levamos toda a estrutura até você e realizamos o serviço no seu endereço.', fee: 0 }
];

/* Catálogo completo do primeiro cliente (Torque Detail). */
const SEED_CATEGORIES = [
  { id: 1, name: 'Torque Wash', slug: 'torque-wash', description: 'Lavagens técnicas e serviços de rotina para manter seu veículo impecável.', display_order: 1 },
  { id: 2, name: 'Torque Detail Premium', slug: 'torque-detail-premium', description: 'Higienização e detalhamento interno de alto padrão.', display_order: 2 },
  { id: 3, name: 'Torque Paint Correction', slug: 'torque-paint-correction', description: 'Polimento e correção de pintura com acabamento profissional.', display_order: 3 },
  { id: 4, name: 'Torque Ceramic Shield', slug: 'torque-ceramic-shield', description: 'Proteção cerâmica de longa duração para a pintura.', display_order: 4 },
  { id: 5, name: 'Torque Signature', slug: 'torque-signature', description: 'Pacotes completos de alto padrão para quem busca o melhor resultado.', display_order: 5 },
  { id: 6, name: 'Plano de Manutenção', slug: 'plano-de-manutencao', description: 'Os planos de manutenção são destinados principalmente a veículos que já realizaram vitrificação.', display_order: 6 }
];

const SEED_SERVICES = [
  { id: 1, category_id: 1, name: 'Lavagem Técnica Premium', slug: 'lavagem-tecnica-premium', description: 'Lavagem técnica completa: pré-lavagem, espuma ativa, enxágue com água desmineralizada e acabamento.', price_type: 'category', price_hatch: 120, price_sedan: 140, price_suv: 160, price_pickup: 180, duration_minutes: 150, display_order: 1 },
  { id: 2, category_id: 1, name: 'Lavagem Detalhada', slug: 'lavagem-detalhada', description: 'Lavagem completa com atenção aos detalhes, incluindo soleiras, batentes e acabamentos.', price_type: 'category', price_hatch: 220, price_sedan: 250, price_suv: 290, price_pickup: 320, duration_minutes: 300, display_order: 2 },
  { id: 3, category_id: 1, name: 'Cristalização dos Vidros', slug: 'cristalizacao-dos-vidros', description: 'Aplicação de cristalização hidrofóbica em todos os vidros, melhorando a visibilidade e repelindo água.', price_type: 'category', price_hatch: 220, price_sedan: 250, price_suv: 300, price_pickup: 320, duration_minutes: 150, display_order: 3 },
  { id: 4, category_id: 1, name: 'Restauração de Faróis (par)', slug: 'restauracao-de-farois', description: 'Lixamento, polimento e aplicação de proteção UV para recuperar o brilho e a transparência dos faróis.', price_type: 'category', price_hatch: 250, price_sedan: 250, price_suv: 280, price_pickup: 280, duration_minutes: 180, display_order: 4 },
  { id: 5, category_id: 1, name: 'Limpeza Técnica do Motor', slug: 'limpeza-tecnica-do-motor', description: 'Limpeza segura do compartimento do motor com produtos específicos e proteção dos componentes.', price_type: 'category', price_hatch: 180, price_sedan: 180, price_suv: 220, price_pickup: 220, duration_minutes: 180, display_order: 5 },
  { id: 6, category_id: 2, name: 'Higienização Interna Completa', slug: 'higienizacao-interna-completa', description: 'Higienização profunda de bancos, carpetes, teto e painel, com extração de manchas e odores.', price_type: 'category', price_hatch: 380, price_sedan: 450, price_suv: 550, price_pickup: 600, duration_minutes: 960, display_order: 1 },
  { id: 7, category_id: 3, name: 'Polimento Comercial', slug: 'polimento-comercial', description: 'Polimento leve para renovar o brilho e remover marcas superficiais.', price_type: 'category', price_hatch: 450, price_sedan: 500, price_suv: 600, price_pickup: 650, duration_minutes: 360, display_order: 1 },
  { id: 8, category_id: 3, name: 'Polimento Técnico 1 etapa', slug: 'polimento-tecnico-1-etapa', description: 'Correção de pintura em 1 etapa, removendo marcas leves e hologramas.', price_type: 'category', price_hatch: 750, price_sedan: 850, price_suv: 950, price_pickup: 1050, duration_minutes: 480, display_order: 2 },
  { id: 9, category_id: 3, name: 'Polimento Técnico 2 etapas', slug: 'polimento-tecnico-2-etapas', description: 'Correção de pintura em 2 etapas, com remoção de marcas médias e leves.', price_type: 'category', price_hatch: 1150, price_sedan: 1300, price_suv: 1500, price_pickup: 1700, duration_minutes: 480, display_order: 3 },
  { id: 10, category_id: 3, name: 'Polimento Técnico 3 etapas', slug: 'polimento-tecnico-3-etapas', description: 'Correção de pintura em 3 etapas, o mais completo para pinturas muito danificadas.', price_type: 'category', price_hatch: 1600, price_sedan: 1850, price_suv: 2100, price_pickup: 2400, duration_minutes: 480, display_order: 4 },
  { id: 11, category_id: 4, name: 'Vitrificação 1 ano', slug: 'vitrificacao-1-ano', description: 'Aplicação de revestimento cerâmico com durabilidade de 1 ano.', price_type: 'category', price_hatch: 950, price_sedan: 1100, price_suv: 1250, price_pickup: 1350, duration_minutes: 960, display_order: 1 },
  { id: 12, category_id: 4, name: 'Vitrificação 3 anos', slug: 'vitrificacao-3-anos', description: 'Revestimento cerâmico de alta durabilidade com garantia de 3 anos.', price_type: 'category', price_hatch: 1750, price_sedan: 1950, price_suv: 2250, price_pickup: 2450, duration_minutes: 960, display_order: 2 },
  { id: 13, category_id: 4, name: 'Vitrificação 5 anos', slug: 'vitrificacao-5-anos', description: 'Revestimento cerâmico profissional com durabilidade de até 5 anos.', price_type: 'category', price_hatch: 2500, price_sedan: 2800, price_suv: 3100, price_pickup: 3500, duration_minutes: 960, display_order: 3 },
  { id: 14, category_id: 5, name: 'Torque Signature Silver', slug: 'torque-signature-silver', description: 'Pacote premium de higienização e proteção.', price_type: 'fixed', fixed_price: 590, duration_minutes: 120, package_items: JSON.stringify(['Lavagem Técnica Premium', 'Limpeza interna completa', 'Higienização de rodas e pneus', 'Aplicação de cera de proteção', 'Aromatizador']), display_order: 1 },
  { id: 15, category_id: 5, name: 'Torque Signature Gold', slug: 'torque-signature-gold', description: 'Pacote completo com polimento e proteção de pintura.', price_type: 'fixed', fixed_price: 1490, duration_minutes: 240, package_items: JSON.stringify(['Tudo do pacote Silver', 'Polimento Comercial', 'Descontaminação de pintura', 'Proteção de pintura (selante)', 'Higienização interna com extração', 'Restauração de plásticos externos', 'Aromatizador premium']), display_order: 2 },
  { id: 16, category_id: 5, name: 'Torque Signature Black', slug: 'torque-signature-black', description: 'O pacote mais completo da casa, com correção de pintura e vitrificação. Valor a partir de R$ 2.590.', price_type: 'starting', starting_price: 2590, duration_minutes: 480, package_items: JSON.stringify(['Tudo do pacote Gold', 'Polimento Técnico 2 etapas', 'Vitrificação de pintura (1 ano)', 'Higienização interna de alto padrão', 'Tratamento de couro', 'Restauração de faróis (par)', 'Aromatizador premium', 'Revisão técnica completa']), display_order: 3 },
  { id: 17, category_id: 6, name: 'Lavagem Técnica + Inspeção', slug: 'lavagem-tecnica-inspecao', description: 'Lavagem técnica seguida de inspeção de pintura e superfícies.', price_type: 'fixed', fixed_price: 120, duration_minutes: 60, display_order: 1 },
  { id: 18, category_id: 6, name: 'Plano Mensal (2 lavagens)', slug: 'plano-mensal-2-lavagens', description: '2 lavagens técnicas por mês com prioridade de agendamento.', price_type: 'fixed', fixed_price: 220, duration_minutes: 60, display_order: 2 },
  { id: 19, category_id: 6, name: 'Plano Quinzenal (4 lavagens)', slug: 'plano-quinzenal-4-lavagens', description: '4 lavagens técnicas por mês com prioridade de agendamento.', price_type: 'fixed', fixed_price: 390, duration_minutes: 60, display_order: 3 }
];

/* Categorias padrão genéricas para novas empresas (sem vínculo com a marca). */
const DEFAULT_CATEGORIES = [
  { name: 'Lavagem', slug: 'lavagem', description: 'Lavagens técnicas e serviços de rotina.', display_order: 1 },
  { name: 'Detalhamento', slug: 'detalhamento', description: 'Higienização e detalhamento de alto padrão.', display_order: 2 },
  { name: 'Proteção de Pintura', slug: 'protecao-de-pintura', description: 'Polimento, vitrificação e proteção cerâmica.', display_order: 3 }
];

/* ---------- Migrações ---------- */

const STATUS_MAP = {
  'aguardando confirmacao': 'pending',
  'confirmado': 'confirmed',
  'em atendimento': 'confirmed',
  'concluido': 'completed',
  'cancelado': 'cancelled'
};

function migrateAppointments(db) {
  const oldRows = db.prepare('SELECT * FROM appointments').all();
  db.exec('DROP TABLE IF EXISTS appointments_new');
  db.exec(appointmentsDDL('appointments_new'));

  const insert = db.prepare(`
    INSERT INTO appointments_new (
      id, appointment_code, modality_id, unit_id, service_id,
      customer_name, customer_phone, customer_email, customer_cpf,
      vehicle_brand, vehicle_model, vehicle_year, vehicle_plate, vehicle_color, vehicle_category,
      appointment_date, start_time, end_date, end_time, booked_duration_minutes, service_name,
      service_price, modality_fee, total_price, price_is_estimate,
      status,
      address_zipcode, address_street, address_number, address_complement, address_neighborhood,
      address_city, address_state, address_reference,
      responsible_name, responsible_phone,
      has_water_access, has_power_access, key_delivery_confirmed,
      payment_method,
      rejection_reason, rejection_message, approved_at, rejected_at, approved_by, rejected_by,
      customer_notes, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?, ?, ?, ?,
      ?, ?,       ?,
      ?, ?,
      ?, ?, ?,
      ?,
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
        r.appointment_date, r.appointment_time, r.appointment_date, end, 60, null,
        0, 0, 0, 0,
        STATUS_MAP[r.status] || 'pending',
        null, null, null, null, null, null, null, null,
        null, null,
        0, 0, 0,
        null, null, null,
        null,
        null, null, null, null, null, null,
        r.notes, r.created_at, r.updated_at
      );
    }
    db.exec('DROP TABLE appointments');
    db.exec('ALTER TABLE appointments_new RENAME TO appointments');
  });
  migrate();
}

function migrateBlockedSchedules(db) {
  const rows = db.prepare('SELECT * FROM blocked_schedules').all();
  db.exec('DROP TABLE IF EXISTS blocked_schedules_new');
  db.exec(blockedDDL('blocked_schedules_new'));
  const insert = db.prepare(
    'INSERT INTO blocked_schedules_new (id, unit_id, blocked_date, blocked_time, blocked_time_end, block_full_day, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const migrate = db.transaction(() => {
    for (const r of rows) insert.run(r.id, r.unit_id, r.blocked_date, r.blocked_time, r.blocked_time_end, r.block_full_day, r.reason, r.created_at);
    db.exec('DROP TABLE blocked_schedules');
    db.exec('ALTER TABLE blocked_schedules_new RENAME TO blocked_schedules');
  });
  migrate();
}

/* Modalidades de atendimento (in-store/pickup/delivery) são genéricas —
   toda empresa nova recebe as três, independente de ter catálogo completo. */
function seedModalities(db) {
  const insertModality = db.prepare(
    'INSERT OR IGNORE INTO service_modalities (id, name, slug, description, fee, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  for (const m of SEED_MODALITIES) insertModality.run(m.id, m.name, m.slug, m.description, m.fee);
}

/*
 * Catálogo de marca da Torque Detail (categorias + serviços com preços
 * específicos). Usado apenas na migração do primeiro cliente (fullCatalog),
 * nunca em empresas novas — do contrário, cada empresa nasceria com o
 * catálogo e os preços de um concorrente.
 */
function seedBrandedCatalog(db) {
  const insertCategory = db.prepare(
    'INSERT OR IGNORE INTO service_categories (id, name, slug, description, display_order, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  for (const c of SEED_CATEGORIES) insertCategory.run(c.id, c.name, c.slug, c.description, c.display_order);

  const insertService = db.prepare(`
    INSERT OR IGNORE INTO services
      (id, category_id, name, slug, description, price_type, fixed_price,
       price_hatch, price_sedan, price_suv, price_pickup, starting_price,
       duration_minutes, pickup_extra_minutes, package_items, available_at_unit, available_pickup_delivery,
       available_mobile_delivery, active, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?)
  `);
  for (const s of SEED_SERVICES) {
    insertService.run(
      s.id, s.category_id, s.name, s.slug, s.description, s.price_type,
      s.fixed_price ?? null, s.price_hatch ?? null, s.price_sedan ?? null,
      s.price_suv ?? null, s.price_pickup ?? null, s.starting_price ?? null,
      s.duration_minutes, s.pickup_extra_minutes ?? 60, s.package_items ?? null, s.display_order
    );
  }
}

/* Mantido por compatibilidade: catálogo completo (modalidades + marca). */
function seedCatalog(db) {
  seedModalities(db);
  seedBrandedCatalog(db);
}

/* Migração: aplica as durações padrão de catálogo em serviços já existentes. */
function migrateSeedDurations(db) {
  const applyDurations = db.transaction(() => {
    const update = db.prepare(
      "UPDATE services SET duration_minutes = ?, pickup_extra_minutes = ?, updated_at = datetime('now', 'localtime') WHERE slug = ?"
    );
    for (const s of SEED_SERVICES) {
      update.run(s.duration_minutes, s.pickup_extra_minutes ?? 60, s.slug);
    }
  });
  applyDurations();
}

/* Fase 1 — Pacotes de serviços. As tabelas já são criadas em createTables
   (CREATE TABLE IF NOT EXISTS); aqui garantimos índices de uso comum e o
   backfill das colunas novas de agendamentos antigos (payment_source e
   package_credit_status com valores padrão seguros). */
function migrateServicePackagesV1(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sp_items_package ON service_package_items (package_id);
    CREATE INDEX IF NOT EXISTS idx_customer_packages_customer ON customer_packages (customer_id);
    CREATE INDEX IF NOT EXISTS idx_customer_packages_status ON customer_packages (status);
    CREATE INDEX IF NOT EXISTS idx_cpb_customer_package ON customer_package_balances (customer_package_id);
    CREATE INDEX IF NOT EXISTS idx_pt_customer_package ON package_transactions (customer_package_id);
    CREATE INDEX IF NOT EXISTS idx_pt_balance ON package_transactions (balance_id);
    CREATE INDEX IF NOT EXISTS idx_pt_appointment ON package_transactions (appointment_id);
    CREATE INDEX IF NOT EXISTS idx_pt_created ON package_transactions (created_at);
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers (phone);
    CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles (customer_id);
    CREATE INDEX IF NOT EXISTS idx_vehicles_plate ON vehicles (plate);
    CREATE INDEX IF NOT EXISTS idx_appointments_package ON appointments (customer_package_id);
    CREATE INDEX IF NOT EXISTS idx_financial_package ON financial_entries (customer_package_id);
  `);

  db.prepare("UPDATE appointments SET payment_source = 'NORMAL' WHERE payment_source IS NULL").run();
  db.prepare("UPDATE appointments SET package_credit_status = 'NONE' WHERE package_credit_status IS NULL").run();
  db.prepare("UPDATE appointments SET package_quantity = 0 WHERE package_quantity IS NULL").run();
}

/* ---------- Aplicação do schema ---------- */

function createTables(db) {
  db.exec(BASE_DDL);
  if (!tableExists(db, 'appointments')) db.exec(appointmentsDDL('appointments'));
  if (!tableExists(db, 'blocked_schedules')) db.exec(blockedDDL('blocked_schedules'));
  db.exec(financialDDL);
  db.exec(customersDDL);
  db.exec(vehiclesDDL);
  db.exec(servicePackagesDDL);
  db.exec(servicePackageItemsDDL);
  db.exec(customerPackagesDDL);
  db.exec(customerPackageBalancesDDL);
  db.exec(packageTransactionsDDL);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')))"
  );
}

function migrationApplied(db, name) {
  return !!db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name);
}

function markMigration(db, name) {
  db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
}

/*
 * upgradeSchema: cria tabelas ausentes e aplica migrações idempotentes.
 * Deve ser chamado sempre que um banco de tenant for aberto.
 */
function upgradeSchema(db) {
  createTables(db);

  /* units: novos campos de endereço */
  ensureColumn(db, 'units', 'address_street', 'TEXT');
  ensureColumn(db, 'units', 'address_number', 'TEXT');
  ensureColumn(db, 'units', 'address_complement', 'TEXT');
  ensureColumn(db, 'units', 'address_neighborhood', 'TEXT');
  ensureColumn(db, 'units', 'address_city', 'TEXT');
  ensureColumn(db, 'units', 'address_state', 'TEXT');
  ensureColumn(db, 'units', 'address_zipcode', 'TEXT');
  ensureColumn(db, 'units', 'address_reference', 'TEXT');
  ensureColumn(db, 'units', 'maps_link', 'TEXT');
  ensureColumn(db, 'units', 'capacity', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'units', 'lunch_start', "TEXT NOT NULL DEFAULT '12:00'");
  ensureColumn(db, 'units', 'lunch_end', "TEXT NOT NULL DEFAULT '13:00'");

  ensureColumn(db, 'company_settings', 'capacity', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'company_settings', 'lunch_start', "TEXT NOT NULL DEFAULT '12:00'");
  ensureColumn(db, 'company_settings', 'lunch_end', "TEXT NOT NULL DEFAULT '13:00'");

  /* Pagamento via Pix: chave copia e cola e nome do recebedor. A imagem do
     QR Code fica como asset do tenant (assets/tenant_XXXX/pix_qr.*), sem
     coluna no banco — a presença do arquivo em disco é a fonte da verdade. */
  ensureColumn(db, 'company_settings', 'pix_code', 'TEXT');
  ensureColumn(db, 'company_settings', 'pix_company_name', 'TEXT');

  /* Formas de pagamento habilitadas (JSON array de 'local' | 'card' | 'pix' |
     'qrcode'). As desabilitadas não aparecem para o cliente no passo de pagamento. */
  ensureColumn(db, 'company_settings', 'payment_methods_enabled', "TEXT NOT NULL DEFAULT '[\"local\",\"card\",\"pix\",\"qrcode\"]'");

  ensureColumn(db, 'services', 'pickup_extra_minutes', 'INTEGER NOT NULL DEFAULT 60');
  ensureColumn(db, 'appointments', 'end_date', 'TEXT');
  ensureColumn(db, 'appointments', 'booked_duration_minutes', 'INTEGER NOT NULL DEFAULT 60');
  ensureColumn(db, 'appointments', 'services_json', 'TEXT');
  ensureColumn(db, 'appointments', 'payment_method', 'TEXT');

  /* Financeiro: distinção entre entrada (receita) e saída (despesa). O campo
     appointment_id vincula a entrada gerada automaticamente na conclusão de
     um agendamento, evitando lançamentos duplicados. */
  ensureColumn(db, 'financial_entries', 'type', "TEXT NOT NULL DEFAULT 'entrada'");
  ensureColumn(db, 'financial_entries', 'appointment_id', 'INTEGER');

  /* Pacotes de serviços (Fase 1): colunas de vínculo do agendamento com um
     pacote vendido e com o saldo de um serviço específico. */
  ensureColumn(db, 'financial_entries', 'customer_package_id', 'INTEGER');
  ensureColumn(db, 'appointments', 'payment_source', "TEXT NOT NULL DEFAULT 'NORMAL'");
  ensureColumn(db, 'appointments', 'customer_package_id', 'INTEGER');
  ensureColumn(db, 'appointments', 'package_balance_id', 'INTEGER');
  ensureColumn(db, 'appointments', 'package_credit_status', "TEXT NOT NULL DEFAULT 'NONE'");
  ensureColumn(db, 'appointments', 'package_quantity', 'INTEGER NOT NULL DEFAULT 0');

  /* appointments: rebuild quando schema antigo */
  if (!columnNames(db, 'appointments').includes('start_time')) {
    migrateAppointments(db);
  }

  /* backfill: agendamentos legados recebem end_date e duração reservada */
  db.prepare('UPDATE appointments SET end_date = appointment_date WHERE end_date IS NULL').run();
  db.prepare(
    `UPDATE appointments SET booked_duration_minutes = COALESCE(
       (SELECT duration_minutes FROM services WHERE services.id = appointments.service_id), 60
     ) WHERE booked_duration_minutes IS NULL OR booked_duration_minutes = 0`
  ).run();

  /* blocked_schedules: unit_id passa a ser opcional */
  if (!tableExists(db, 'blocked_schedules')) {
    db.exec(blockedDDL('blocked_schedules'));
  } else {
    const meta = db.prepare('PRAGMA table_info(blocked_schedules)').all();
    const unitCol = meta.find((c) => c.name === 'unit_id');
    if (unitCol && unitCol.notnull === 1) migrateBlockedSchedules(db);
  }

  ensureColumn(db, 'blocked_schedules', 'blocked_time_end', 'TEXT');

  if (!migrationApplied(db, 'seed_durations_v1')) {
    migrateSeedDurations(db);
    markMigration(db, 'seed_durations_v1');
  }

  /* Pacotes de serviços (Fase 1): as tabelas são criadas em createTables com
     CREATE TABLE IF NOT EXISTS; a migração garante índices e registra o marco
     em schema_migrations (refletido no manifest de backup). Idempotente. */
  if (!migrationApplied(db, 'service_packages_v1')) {
    migrateServicePackagesV1(db);
    markMigration(db, 'service_packages_v1');
  }

  /* índices */
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments (appointment_date);
    CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status);
    CREATE INDEX IF NOT EXISTS idx_appointments_modality ON appointments (modality_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_service ON appointments (service_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_unit_date ON appointments (unit_id, appointment_date);
    CREATE INDEX IF NOT EXISTS idx_blocked_date ON blocked_schedules (blocked_date);
    CREATE INDEX IF NOT EXISTS idx_blocked_unit ON blocked_schedules (unit_id);
    CREATE INDEX IF NOT EXISTS idx_financial_date ON financial_entries (entry_date);
    CREATE INDEX IF NOT EXISTS idx_financial_service ON financial_entries (service_id);
    CREATE INDEX IF NOT EXISTS idx_financial_customer ON financial_entries (customer_name);
    CREATE INDEX IF NOT EXISTS idx_financial_type ON financial_entries (type);
    CREATE INDEX IF NOT EXISTS idx_appointments_package ON appointments (customer_package_id);
    CREATE INDEX IF NOT EXISTS idx_financial_package ON financial_entries (customer_package_id);
  `);

  /* remove artefatos de migrações antigas que não tenham sido concluídas */
  db.exec('DROP TABLE IF EXISTS appointments_new');
  db.exec('DROP TABLE IF EXISTS blocked_schedules_new');
}

/*
 * seedDefaults: popula dados mínimos de uma empresa recém-criada.
 * Este seed é NEUTRO — nunca contém dados, textos, imagens ou preços de
 * nenhum cliente específico (ex.: Torque Detail). Dados de marca ficam
 * apenas no script exclusivo scripts/seedTorqueDetail.js.
 *
 * Opções:
 *   companyName: nome comercial vindo do cadastro (obrigatório usar o do
 *                formulário; nunca um placeholder).
 *   phone/whatsapp: contatos reais informados; nunca o e-mail do admin.
 *   unit: primeira unidade real informada no formulário "Nova empresa".
 *   fullCatalog: true insere o catálogo de marca (USO EXCLUSIVO do seed da
 *                Torque Detail / migração do tenant padrão).
 *   createDefaultUnit: true cria uma unidade neutra SEM placeholders (usado
 *                      apenas pelo bootstrap da Torque Detail; empresas novas
 *                      sempre enviam dados reais).
 *
 * Empresas novas NÃO recebem serviços: começam com setup_status PENDING e o
 * site público mostra a tela de configuração pendente até o administrador
 * cadastrar unidade/modalidades/serviços/horários.
 */
function seedDefaults(db, opts = {}) {
  const { companyName, phone, whatsapp, fullCatalog, unit, createDefaultUnit } = opts;

  db.prepare(
    `INSERT INTO company_settings
       (id, company_name, phone, whatsapp, logo_url,
        default_opening_time, default_closing_time, default_interval,
        lunch_start, lunch_end,
        working_days, confirmation_message)
     VALUES (1, ?, ?, ?, ?, '08:00', '17:00', 60, '12:00', '13:00', ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(
    companyName || 'Minha Empresa',
    phone || null,
    whatsapp || null,
    '',
    JSON.stringify([1, 2, 3, 4, 5, 6]),
    'Solicitação enviada com sucesso! Nossa equipe analisará a disponibilidade e entrará em contato pelo WhatsApp para confirmar.'
  );

  const unitCount = db.prepare('SELECT COUNT(*) AS total FROM units').get().total;
  /* Primeira unidade com dados reais vindos do formulário "Nova empresa".
     Nunca usa placeholders nem o e-mail do administrador como telefone. */
  if (unit && unit.name) {
    const working = Array.isArray(unit.working_days)
      ? JSON.stringify(unit.working_days)
      : (unit.working_days || JSON.stringify([1, 2, 3, 4, 5, 6]));
    db.prepare(`
      INSERT INTO units
        (name, address, address_street, address_number, address_complement, address_neighborhood,
         address_city, address_state, address_zipcode, address_reference, maps_link,
         phone, opening_time, closing_time, lunch_start, lunch_end, appointment_interval, capacity, working_days, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      unit.name,
      unit.address || '',
      unit.address_street || null,
      unit.address_number || null,
      unit.address_complement || null,
      unit.address_neighborhood || null,
      unit.address_city || null,
      unit.address_state || null,
      unit.address_zipcode || null,
      unit.address_reference || null,
      unit.maps_link || null,
      unit.phone || null,
      unit.opening_time || '08:00',
      unit.closing_time || '17:00',
      unit.lunch_start || '12:00',
      unit.lunch_end || '13:00',
      unit.appointment_interval || 60,
      unit.capacity || 1,
      working,
      unit.active === undefined ? 1 : unit.active
    );
  } else if (createDefaultUnit && unitCount === 0) {
    /* Bootstrap do tenant inicial (Torque Detail): unidade neutra, sem
       endereço/telefone placeholder. Empresas novas nunca chegam aqui. */
    const insertUnit = db.prepare(`
      INSERT INTO units
        (name, address, phone, opening_time, closing_time, appointment_interval, lunch_start, lunch_end, working_days, active)
      VALUES (?, '', '', '08:00', '17:00', 60, '12:00', '13:00', ?, 1)
    `);
    insertUnit.run(companyName || 'Minha Empresa', JSON.stringify([1, 2, 3, 4, 5, 6]));
  }

  seedModalities(db);

  if (fullCatalog) {
    seedBrandedCatalog(db);
  } else {
    const insertCategory = db.prepare(
      'INSERT OR IGNORE INTO service_categories (id, name, slug, description, display_order, active) VALUES (?, ?, ?, ?, ?, 1)'
    );
    let order = 1;
    for (const c of DEFAULT_CATEGORIES) {
      insertCategory.run(100 + order, c.name, c.slug, c.description, c.display_order || order);
      order += 1;
    }
  }
}

/*
 * Estado de configuração do tenant (onboarding), calculado a partir de dados
 * reais — nunca de branding/logo. Um tenant está READY quando tem:
 *   - pelo menos uma unidade ativa;
 *   - pelo menos uma forma de atendimento ativa;
 *   - pelo menos um serviço ativo;
 *   - horário de funcionamento configurado.
 * Enquanto PENDING, o site público exibe a tela "Agenda em configuração" e o
 * painel do desenvolvedor/administrador mostra o checklist pendente.
 */
function computeSetupStatus(db) {
  const missing = [];

  const activeUnits = db.prepare('SELECT COUNT(*) AS total FROM units WHERE active = 1').get().total;
  if (!activeUnits) missing.push('unidade');

  const activeModalities = db.prepare('SELECT COUNT(*) AS total FROM service_modalities WHERE active = 1').get().total;
  if (!activeModalities) missing.push('formas de atendimento');

  const activeServices = db.prepare('SELECT COUNT(*) AS total FROM services WHERE active = 1').get().total;
  if (!activeServices) missing.push('serviços');

  const settings = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  const hasHours = Boolean(
    settings &&
    settings.default_opening_time &&
    settings.default_closing_time &&
    settings.default_closing_time > settings.default_opening_time
  );
  if (!hasHours) missing.push('horários');

  return {
    status: missing.length === 0 ? 'READY' : 'PENDING',
    missing
  };
}

module.exports = {
  createTables,
  upgradeSchema,
  seedDefaults,
  seedCatalog,
  computeSetupStatus,
  SEED_MODALITIES,
  SEED_CATEGORIES,
  SEED_SERVICES,
  tableExists,
  columnNames,
  ensureColumn
};
