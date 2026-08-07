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

const { addMinutes, parseWorkingDays, normalizeBrazilianPhone } = require('../utils/helpers');

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
  price_passeio REAL,
  price_utilitario REAL,
  starting_price REAL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  utilitario_extra_minutes INTEGER NOT NULL DEFAULT 60,
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
  vehicle_model TEXT NOT NULL,
  vehicle_year TEXT,
  vehicle_plate TEXT,
  vehicle_category TEXT NOT NULL DEFAULT 'passeio',
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
  model TEXT NOT NULL,
  year TEXT,
  plate TEXT,
  category TEXT NOT NULL DEFAULT 'passeio',
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

/* ---------- Documentos legais (LGPD) ---------- */

/* Documentos legais versionados por tenant (Termos de Uso, Aviso de
   Privacidade). A versão vigente é a atual; edições criam uma versão nova e
   o agendamento registra a versão exata aceita pelo cliente. */
const legalDocumentsDDL = `
CREATE TABLE IF NOT EXISTS legal_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '1.0',
  effective_at TEXT,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

/* Histórico imutável de versões: sempre que o conteúdo de um documento muda
   (updateDocument), a versão ANTERIOR inteira (título + texto) é arquivada
   aqui antes de ser sobrescrita em legal_documents — nunca silenciosamente
   perdida. legal_documents guarda apenas a versão vigente (leitura rápida no
   fluxo público); esta tabela guarda o histórico completo para auditoria. */
const legalDocumentVersionsDDL = `
CREATE TABLE IF NOT EXISTS legal_document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legal_document_id INTEGER NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
  doc_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version TEXT NOT NULL,
  published INTEGER NOT NULL,
  effective_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (legal_document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_ldv_document ON legal_document_versions (legal_document_id);
`;

/* Aceites registrados por agendamento: guarda o instantâneo (título + versão)
   aceitos, tornando o histórico imutável mesmo que o documento mude depois.
   O registro é feito na mesma transação do agendamento. ip_address/user_agent
   são metadados técnicos do momento do aceite (auditoria), nunca usados para
   outra finalidade. */
const appointmentLegalAcceptancesDDL = `
CREATE TABLE IF NOT EXISTS appointment_legal_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  legal_document_id INTEGER NOT NULL REFERENCES legal_documents(id),
  document_version TEXT NOT NULL,
  document_title TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (appointment_id, legal_document_id)
);
CREATE INDEX IF NOT EXISTS idx_ala_appointment ON appointment_legal_acceptances (appointment_id);
`;

/*
 * Conteúdo jurídico inicial sujeito à revisão profissional antes da
 * publicação definitiva.
 *
 * Conteúdo padrão NEUTRO (sem marca, sem nome de cliente fixado). Usa
 * placeholders substituídos pelos dados reais do tenant somente na leitura
 * pública (ver legalDocumentService.renderContent):
 *   {{NOME_DA_EMPRESA}}       nome da empresa (ou frase neutra, se ausente)
 *   {{IDENTIFICACAO_EMPRESA}} parágrafo com os dados cadastrados da empresa
 *                              (documento, endereço, contato, domínio — cada
 *                              dado só aparece se estiver cadastrado)
 *   {{CONTATO_PRIVACIDADE}}   canal de contato para assuntos de privacidade
 *   {{DOMINIO_EMPRESA}}       domínio configurado da empresa
 * As empresas podem editar o conteúdo no painel administrativo; cada edição
 * relevante cria uma nova versão (ver legalDocumentService.updateDocument).
 */
const DEFAULT_LEGAL_DOCUMENTS = [
  {
    doc_key: 'terms',
    title: 'Termos de Uso',
    content: [
      'Estes Termos de Uso regulam o uso da página pública de agendamento online. Ao marcar a caixa de aceite antes de concluir uma solicitação de agendamento, você declara que leu e concorda com estas condições.',
      '',
      '1. Identificação da empresa prestadora do serviço',
      '{{IDENTIFICACAO_EMPRESA}}',
      '',
      '2. Finalidade desta página de agendamento',
      'Esta página permite solicitar, de forma online, o agendamento de serviços automotivos oferecidos por {{NOME_DA_EMPRESA}}. A PapiCore é a fornecedora da tecnologia utilizada para operar este agendamento; quem presta o serviço automotivo, define preços e atende o veículo é {{NOME_DA_EMPRESA}}.',
      '',
      '3. Informações fornecidas pelo cliente',
      'Para solicitar um agendamento, são pedidos dados de identificação e contato, dados do veículo e, quando aplicável à modalidade escolhida, endereço de atendimento.',
      '',
      '4. Responsabilidade pela veracidade dos dados',
      'Você é responsável pela veracidade, exatidão e atualização dos dados informados. Dados incorretos ou incompletos podem impedir a confirmação ou a correta prestação do serviço.',
      '',
      '5. Solicitação e confirmação do agendamento',
      'O envio do formulário gera uma solicitação de agendamento, não uma confirmação automática. A reserva do horário é analisada e confirmada por {{NOME_DA_EMPRESA}}, que poderá entrar em contato pelos canais informados.',
      '',
      '6. Aceitar, recusar, alterar ou cancelar',
      '{{NOME_DA_EMPRESA}} pode aceitar, recusar, propor alteração de horário ou cancelar uma solicitação, especialmente em caso de indisponibilidade, dados incompletos ou impossibilidade de realizar o serviço solicitado.',
      '',
      '7. Preços e condições apresentados no agendamento',
      'Os preços, prazos e condições exibidos no momento do agendamento são os praticados por {{NOME_DA_EMPRESA}} naquele momento e podem ser revistos antes da confirmação, especialmente quando dependem de avaliação do veículo.',
      '',
      '8. Serviços com preço fixo ou "a partir de"',
      'Serviços com preço fixo têm valor determinado antecipadamente. Serviços exibidos como "a partir de" são estimativas: o valor final é confirmado por {{NOME_DA_EMPRESA}} conforme as características do veículo ou do serviço solicitado, antes da execução.',
      '',
      '9. Modalidades de atendimento',
      'Conforme a disponibilidade configurada por {{NOME_DA_EMPRESA}}, o serviço pode ser prestado na unidade, por leva e traz (retirada e devolução do veículo) ou por delivery (atendimento no endereço informado pelo cliente).',
      '',
      '10. Taxas adicionais',
      'Taxas adicionais eventualmente aplicáveis à modalidade escolhida (como deslocamento) são exibidas antes da confirmação do agendamento, dentro do resumo apresentado ao cliente.',
      '',
      '11. Formas de pagamento',
      'As formas de pagamento disponíveis são as habilitadas por {{NOME_DA_EMPRESA}} e exibidas na etapa de pagamento deste agendamento.',
      '',
      '12. Atrasos e tolerância',
      'Quando {{NOME_DA_EMPRESA}} configurar uma política de tolerância a atrasos, ela será informada ao cliente pelos canais de atendimento. Na ausência de configuração específica, atrasos podem afetar a disponibilidade do horário reservado.',
      '',
      '13. Cancelamento e reagendamento',
      'O cliente pode solicitar o cancelamento ou o reagendamento pelos canais de contato de {{NOME_DA_EMPRESA}}. Condições específicas de cancelamento, quando existirem, são informadas pela empresa no momento da solicitação.',
      '',
      '14. Objetos deixados no veículo',
      '{{NOME_DA_EMPRESA}} não se responsabiliza por objetos pessoais deixados no veículo. Recomenda-se retirar pertences de valor antes do atendimento.',
      '',
      '15. Condições relevantes do veículo',
      'O cliente deve informar condições relevantes do veículo (como avarias preexistentes, itens soltos ou problemas mecânicos conhecidos) que possam ser importantes para a correta execução do serviço.',
      '',
      '16. Limitações técnicas da plataforma',
      'A PapiCore realiza esforços razoáveis para manter esta página disponível e funcionando corretamente, mas não garante disponibilidade ininterrupta nem ausência total de falhas técnicas, que podem ocasionalmente afetar o envio ou a exibição de informações.',
      '',
      '17. Uso adequado desta página',
      'Esta página deve ser utilizada exclusivamente para solicitar agendamentos reais de serviços oferecidos por {{NOME_DA_EMPRESA}}, de forma lícita e de boa-fé.',
      '',
      '18. Proibição de agendamentos fraudulentos',
      'É proibido enviar solicitações de agendamento com dados falsos, de terceiros sem autorização, ou com o objetivo de fraudar, sobrecarregar ou testar indevidamente o sistema.',
      '',
      '19. Propriedade intelectual da plataforma',
      'O software, o layout e os recursos técnicos desta página de agendamento são de propriedade da PapiCore ou de seus licenciantes, não sendo cedidos ao cliente pelo uso do serviço.',
      '',
      '20. Alterações destes Termos',
      'Estes Termos de Uso podem ser atualizados. Alterações relevantes geram uma nova versão, sem afetar o registro do aceite já vinculado a agendamentos anteriores.',
      '',
      '21. Canal de contato',
      'Dúvidas sobre estes Termos podem ser esclarecidas diretamente com {{NOME_DA_EMPRESA}}, pelo(s) canal(is) de contato informado(s) nesta página.',
      '',
      '22. Legislação aplicável e foro',
      'Estes Termos são regidos pela legislação brasileira. Fica eleito o foro do domicílio da empresa prestadora do serviço para dirimir eventuais controvérsias, ressalvada disposição legal em contrário.'
    ].join('\n')
  },
  {
    doc_key: 'privacy',
    title: 'Aviso de Privacidade',
    content: [
      'Este Aviso de Privacidade explica como os dados pessoais informados nesta página de agendamento são tratados, em conformidade com a Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018).',
      '',
      '1. Quem trata os seus dados',
      '{{IDENTIFICACAO_EMPRESA}}',
      '',
      '2. Papel da empresa responsável pelo atendimento',
      '{{NOME_DA_EMPRESA}} é responsável pelo atendimento, pela execução do serviço automotivo solicitado e pelos dados dos seus clientes coletados para essa finalidade.',
      '',
      '3. Papel da PapiCore como fornecedora da plataforma',
      'A PapiCore fornece a tecnologia (software de agendamento) utilizada por {{NOME_DA_EMPRESA}} para operar e administrar os agendamentos, atuando como operadora dos dados tratados nesta página, conforme instruções da empresa contratante.',
      '',
      '4. Dados que podem ser coletados',
      'Conforme os campos preenchidos no agendamento, podem ser coletados: nome; telefone e/ou WhatsApp; dados do veículo (modelo, ano, placa e categoria); endereço, quando necessário para leva e traz ou delivery; serviço, data e horário escolhidos; dados de pagamento, somente quando aplicável à forma de pagamento selecionada; e informações técnicas de acesso e segurança (como endereço IP e navegador utilizado).',
      '',
      '5. Finalidades do tratamento',
      'Os dados são utilizados para: criar e administrar o agendamento; entrar em contato sobre o atendimento; organizar a agenda de {{NOME_DA_EMPRESA}}; executar o serviço solicitado; prevenir fraude e uso abusivo da plataforma; manter registros necessários à operação; e cumprir obrigações legais e regulatórias aplicáveis.',
      '',
      '6. Compartilhamento de dados',
      'Os dados podem ser compartilhados com: {{NOME_DA_EMPRESA}}, como responsável pelo atendimento; provedores de hospedagem e infraestrutura técnica essencial ao funcionamento da plataforma; meios de pagamento, quando efetivamente utilizados; e autoridades públicas, quando exigido por lei ou ordem judicial. Os dados não são vendidos a terceiros.',
      '',
      '7. Armazenamento e segurança',
      'Os dados ficam armazenados no banco de dados próprio da empresa dentro da plataforma PapiCore, com controles técnicos e administrativos de acesso destinados a reduzir riscos de acesso não autorizado, perda ou uso indevido.',
      '',
      '8. Período de retenção',
      'Os dados são mantidos pelo tempo necessário para cumprir as finalidades descritas neste Aviso, incluindo o histórico operacional do atendimento, e podem ser mantidos por período adicional quando exigido por obrigação legal, regulatória ou para exercício regular de direitos.',
      '',
      '9. Direitos do titular dos dados',
      'Nos termos da LGPD, você pode solicitar, entre outros direitos previstos em lei: confirmação da existência de tratamento; acesso aos dados; correção de dados incompletos, inexatos ou desatualizados; e, observadas as exceções legais (como obrigações de guarda de registros), a eliminação de dados tratados com base no consentimento.',
      '',
      '10. Como exercer seus direitos',
      'Solicitações relacionadas aos seus dados podem ser feitas junto a {{CONTATO_PRIVACIDADE}}, canal de contato de {{NOME_DA_EMPRESA}} para assuntos de privacidade.',
      '',
      '11. Cookies e dados técnicos essenciais',
      'Esta página utiliza apenas os recursos técnicos essenciais ao seu funcionamento (como armazenamento local do progresso do agendamento no seu próprio navegador), sem uso de cookies de rastreamento publicitário de terceiros.',
      '',
      '12. Dados de menores de idade',
      'Este serviço destina-se à solicitação de agendamentos por pessoas maiores de idade ou legalmente capazes. Dados de menores porventura informados (como no cadastro do responsável) são tratados apenas na medida necessária à prestação do serviço solicitado.',
      '',
      '13. Atualizações deste Aviso',
      'Este Aviso de Privacidade pode ser atualizado. Alterações relevantes geram uma nova versão, sem afetar o registro do aceite já vinculado a agendamentos anteriores.',
      '',
      '14. Canal de contato sobre privacidade',
      'Para dúvidas sobre este Aviso ou sobre o tratamento dos seus dados, utilize {{CONTATO_PRIVACIDADE}}.',
      '',
      'O aceite registrado nesta página confirma que você concorda com os Termos de Uso e que leu este Aviso de Privacidade. O tratamento necessário para solicitar e executar o agendamento pode se apoiar em bases legais além do consentimento, como a execução de um contrato ou o cumprimento de obrigação legal, conforme a finalidade específica de cada dado tratado. Este aceite não implica renúncia a nenhum direito previsto na LGPD.'
    ].join('\n')
  }
];

/* ---------- WhatsApp (mensagens automáticas) ---------- */

/* Modelos de mensagem automática, editáveis por tenant. O banco é por
   empresa, então event_key é único globalmente dentro do tenant. */
const whatsappMessageTemplatesDDL = `
CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

/* Fila de envio (outbox). A operação de negócio é sempre concluída primeiro;
   só depois a mensagem é gravada aqui e processada em segundo plano. O
   idempotency_key (evento + id do agendamento) impede envios duplicados. */
const whatsappOutboxDDL = `
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL,
  recipient TEXT NOT NULL,
  recipient_kind TEXT NOT NULL DEFAULT 'customer',
  payload_json TEXT NOT NULL,
  message_text TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  sent_at TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_woutbox_status ON whatsapp_outbox (status);
CREATE INDEX IF NOT EXISTS idx_woutbox_created ON whatsapp_outbox (created_at);
`;

/* Histórico imutável de mensagens processadas (uma linha por envio com
   status final). A outbox é a fila; aqui fica o registro para auditoria. */
const whatsappMessageHistoryDDL = `
CREATE TABLE IF NOT EXISTS whatsapp_message_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_id INTEGER,
  event_key TEXT,
  recipient TEXT,
  recipient_kind TEXT NOT NULL DEFAULT 'customer',
  message_text TEXT,
  status TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  triggered_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_whistory_created ON whatsapp_message_history (created_at);
CREATE INDEX IF NOT EXISTS idx_whistory_event ON whatsapp_message_history (event_key);
CREATE INDEX IF NOT EXISTS idx_whistory_status ON whatsapp_message_history (status);
`;

/* Modelos padrão NEUTROS: nunca contêm nome, telefone ou textos de cliente
   específico (ex.: Torque Detail). Usam apenas os placeholders permitidos. */
const WHATSAPP_DEFAULT_TEMPLATES = [
  {
    event_key: 'APPOINTMENT_REQUESTED_CUSTOMER',
    name: 'Novo agendamento — aviso ao cliente',
    content: [
      '*{{EMPRESA_NOME}}*',
      'Sua solicitação de agendamento foi recebida!',
      '',
      'Olá, {{CLIENTE_NOME}}!',
      'Código: *{{CODIGO_AGENDAMENTO}}*',
      'Data: *{{DATA_AGENDAMENTO}}*',
      'Horário: *{{HORARIO_AGENDAMENTO}}*',
      'Serviço: {{SERVICO}}',
      'Veículo: {{VEICULO}}',
      'Unidade: {{UNIDADE}}',
      'Modalidade: {{MODALIDADE}}',
      'Valor: *{{VALOR}}*',
      '',
      'Nossa equipe analisará a disponibilidade e entrará em contato para confirmar.'
    ].join('\n')
  },
  {
    event_key: 'APPOINTMENT_REQUESTED_STORE',
    name: 'Novo agendamento — aviso à loja',
    content: [
      '*{{EMPRESA_NOME}} — novo agendamento recebido*',
      '',
      'Código: {{CODIGO_AGENDAMENTO}}',
      'Cliente: {{CLIENTE_NOME}}',
      'Serviço: {{SERVICO}}',
      'Veículo: {{VEICULO}}',
      'Unidade: {{UNIDADE}}',
      'Modalidade: {{MODALIDADE}}',
      'Data: {{DATA_AGENDAMENTO}}',
      'Horário: {{HORARIO_AGENDAMENTO}}',
      'Valor: {{VALOR}}',
      '',
      'Acesse o painel para confirmar: {{LINK_ADMIN}}'
    ].join('\n')
  },
  {
    event_key: 'APPOINTMENT_CONFIRMED',
    name: 'Confirmação de agendamento',
    content: [
      '*{{EMPRESA_NOME}}*',
      '*Seu agendamento foi confirmado!*',
      '',
      'Olá, {{CLIENTE_NOME}}!',
      'Código: *{{CODIGO_AGENDAMENTO}}*',
      'Data: *{{DATA_AGENDAMENTO}}*',
      'Horário: *{{HORARIO_AGENDAMENTO}}*',
      'Serviço: {{SERVICO}}',
      'Veículo: {{VEICULO}}',
      'Unidade: {{UNIDADE}}',
      'Modalidade: {{MODALIDADE}}',
      'Valor: *{{VALOR}}*',
      '',
      'Agradecemos a preferência e esperamos você!'
    ].join('\n')
  },
  {
    event_key: 'APPOINTMENT_CANCELLED',
    name: 'Cancelamento de agendamento',
    content: [
      '*{{EMPRESA_NOME}}*',
      'Seu agendamento foi cancelado.',
      '',
      'Olá, {{CLIENTE_NOME}}!',
      'O agendamento *{{CODIGO_AGENDAMENTO}}* de {{DATA_AGENDAMENTO}} às {{HORARIO_AGENDAMENTO}} foi cancelado.',
      '',
      'Caso precise reagendar, é só entrar em contato conosco.'
    ].join('\n')
  },
  {
    event_key: 'APPOINTMENT_RESCHEDULED',
    name: 'Reagendamento de agendamento',
    content: [
      '*{{EMPRESA_NOME}}*',
      'Seu agendamento foi reagendado!',
      '',
      'Olá, {{CLIENTE_NOME}}!',
      'Novo horário do agendamento *{{CODIGO_AGENDAMENTO}}*:',
      'Data: *{{DATA_AGENDAMENTO}}*',
      'Horário: *{{HORARIO_AGENDAMENTO}}*',
      'Serviço: {{SERVICO}}',
      'Veículo: {{VEICULO}}',
      'Unidade: {{UNIDADE}}',
      'Modalidade: {{MODALIDADE}}',
      '',
      'Qualquer dúvida, é só falar com a gente.'
    ].join('\n')
  },
  {
    event_key: 'APPOINTMENT_COMPLETED',
    name: 'Agendamento concluído',
    content: [
      '*{{EMPRESA_NOME}}*',
      '*Seu veículo está pronto!*',
      '',
      'Olá, {{CLIENTE_NOME}}!',
      'O agendamento *{{CODIGO_AGENDAMENTO}}* foi concluído.',
      'Serviço: {{SERVICO}}',
      'Veículo: {{VEICULO}}',
      'Valor: *{{VALOR}}*',
      '',
      'Obrigado pela preferência!'
    ].join('\n')
  },
  {
    event_key: 'APPOINTMENT_COMPLETED_PACKAGE',
    name: 'Agendamento concluído — pacote',
    content: [
      '*{{EMPRESA_NOME}}*',
      '*Seu veículo está pronto!*',
      '',
      'Olá, {{CLIENTE_NOME}}!',
      'O agendamento *{{CODIGO_AGENDAMENTO}}* foi concluído.',
      'Serviço: {{SERVICO}}',
      'Veículo: {{VEICULO}}',
      '',
      'Saldo restante do seu pacote:',
      '{{SALDO_PACOTE}}',
      '',
      'Obrigado pela preferência!'
    ].join('\n')
  },
  {
    event_key: 'PACKAGE_CREDIT_USED',
    name: 'Créditos de pacote utilizados',
    content: [
      'Olá, {{CLIENTE_NOME}}! 👋',
      '',
      'Seu veículo já está pronto. 🚗✨',
      '',
      'Utilizamos os seguintes créditos do seu pacote:',
      '{{CREDITOS_USADOS}}',
      '',
      'Saldo restante:',
      '{{SALDO_PACOTE}}',
      '',
      'Obrigado por escolher {{EMPRESA_NOME}}.'
    ].join('\n')
  }
];

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
  { id: 1, category_id: 1, name: 'Lavagem Técnica Premium', slug: 'lavagem-tecnica-premium', description: 'Lavagem técnica completa: pré-lavagem, espuma ativa, enxágue com água desmineralizada e acabamento.', price_type: 'category', price_passeio: 120, price_utilitario: 180, duration_minutes: 150, display_order: 1 },
  { id: 2, category_id: 1, name: 'Lavagem Detalhada', slug: 'lavagem-detalhada', description: 'Lavagem completa com atenção aos detalhes, incluindo soleiras, batentes e acabamentos.', price_type: 'category', price_passeio: 220, price_utilitario: 320, duration_minutes: 300, display_order: 2 },
  { id: 3, category_id: 1, name: 'Cristalização dos Vidros', slug: 'cristalizacao-dos-vidros', description: 'Aplicação de cristalização hidrofóbica em todos os vidros, melhorando a visibilidade e repelindo água.', price_type: 'category', price_passeio: 220, price_utilitario: 320, duration_minutes: 150, display_order: 3 },
  { id: 4, category_id: 1, name: 'Restauração de Faróis (par)', slug: 'restauracao-de-farois', description: 'Lixamento, polimento e aplicação de proteção UV para recuperar o brilho e a transparência dos faróis.', price_type: 'category', price_passeio: 250, price_utilitario: 280, duration_minutes: 180, display_order: 4 },
  { id: 5, category_id: 1, name: 'Limpeza Técnica do Motor', slug: 'limpeza-tecnica-do-motor', description: 'Limpeza segura do compartimento do motor com produtos específicos e proteção dos componentes.', price_type: 'category', price_passeio: 180, price_utilitario: 220, duration_minutes: 180, display_order: 5 },
  { id: 6, category_id: 2, name: 'Higienização Interna Completa', slug: 'higienizacao-interna-completa', description: 'Higienização profunda de bancos, carpetes, teto e painel, com extração de manchas e odores.', price_type: 'category', price_passeio: 380, price_utilitario: 600, duration_minutes: 960, display_order: 1 },
  { id: 7, category_id: 3, name: 'Polimento Comercial', slug: 'polimento-comercial', description: 'Polimento leve para renovar o brilho e remover marcas superficiais.', price_type: 'category', price_passeio: 450, price_utilitario: 650, duration_minutes: 360, display_order: 1 },
  { id: 8, category_id: 3, name: 'Polimento Técnico 1 etapa', slug: 'polimento-tecnico-1-etapa', description: 'Correção de pintura em 1 etapa, removendo marcas leves e hologramas.', price_type: 'category', price_passeio: 750, price_utilitario: 1050, duration_minutes: 480, display_order: 2 },
  { id: 9, category_id: 3, name: 'Polimento Técnico 2 etapas', slug: 'polimento-tecnico-2-etapas', description: 'Correção de pintura em 2 etapas, com remoção de marcas médias e leves.', price_type: 'category', price_passeio: 1150, price_utilitario: 1700, duration_minutes: 480, display_order: 3 },
  { id: 10, category_id: 3, name: 'Polimento Técnico 3 etapas', slug: 'polimento-tecnico-3-etapas', description: 'Correção de pintura em 3 etapas, o mais completo para pinturas muito danificadas.', price_type: 'category', price_passeio: 1600, price_utilitario: 2400, duration_minutes: 480, display_order: 4 },
  { id: 11, category_id: 4, name: 'Vitrificação 1 ano', slug: 'vitrificacao-1-ano', description: 'Aplicação de revestimento cerâmico com durabilidade de 1 ano.', price_type: 'category', price_passeio: 950, price_utilitario: 1350, duration_minutes: 960, display_order: 1 },
  { id: 12, category_id: 4, name: 'Vitrificação 3 anos', slug: 'vitrificacao-3-anos', description: 'Revestimento cerâmico de alta durabilidade com garantia de 3 anos.', price_type: 'category', price_passeio: 1750, price_utilitario: 2450, duration_minutes: 960, display_order: 2 },
  { id: 13, category_id: 4, name: 'Vitrificação 5 anos', slug: 'vitrificacao-5-anos', description: 'Revestimento cerâmico profissional com durabilidade de até 5 anos.', price_type: 'category', price_passeio: 2500, price_utilitario: 3500, duration_minutes: 960, display_order: 3 },
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
      vehicle_model, vehicle_year, vehicle_plate, vehicle_category,
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
      ?, ?, ?, ?,
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
        r.vehicle_model, null, r.vehicle_plate, 'passeio',
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
       price_passeio, price_utilitario, starting_price,
       duration_minutes, utilitario_extra_minutes, package_items, available_at_unit, available_pickup_delivery,
       available_mobile_delivery, active, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?)
  `);
  for (const s of SEED_SERVICES) {
    insertService.run(
      s.id, s.category_id, s.name, s.slug, s.description, s.price_type,
      s.fixed_price ?? null, s.price_passeio ?? null, s.price_utilitario ?? null, s.starting_price ?? null,
      s.duration_minutes, s.utilitario_extra_minutes ?? 60, s.package_items ?? null, s.display_order
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
      "UPDATE services SET duration_minutes = ?, utilitario_extra_minutes = ?, updated_at = datetime('now', 'localtime') WHERE slug = ?"
    );
    for (const s of SEED_SERVICES) {
      update.run(s.duration_minutes, s.utilitario_extra_minutes ?? 60, s.slug);
    }
  });
  applyDurations();
}

/* Categorias de veículo: fluxo simplificado para Passeio/Utilitário.
   Migração idempotente de bancos antigos (precisa rodar ANTES de qualquer
   seed que use as colunas de preço/duração):
   - services: price_hatch → price_passeio, price_pickup → price_utilitario,
     pickup_extra_minutes → utilitario_extra_minutes; descarta price_sedan e
     price_suv (unificadas em Passeio);
   - appointments.vehicle_category e vehicles.category: hatch/sedan/suv →
     passeio, pickup → utilitario. */
function migrateCategoriesV2(db) {
  const cols = (t) => columnNames(db, t);

  if (cols('services').includes('price_hatch') && !cols('services').includes('price_passeio')) {
    db.exec('ALTER TABLE services RENAME COLUMN price_hatch TO price_passeio');
  }
  if (cols('services').includes('price_pickup') && !cols('services').includes('price_utilitario')) {
    db.exec('ALTER TABLE services RENAME COLUMN price_pickup TO price_utilitario');
  }
  if (cols('services').includes('pickup_extra_minutes') && !cols('services').includes('utilitario_extra_minutes')) {
    db.exec('ALTER TABLE services RENAME COLUMN pickup_extra_minutes TO utilitario_extra_minutes');
  }
  if (cols('services').includes('price_sedan')) db.exec('ALTER TABLE services DROP COLUMN price_sedan');
  if (cols('services').includes('price_suv')) db.exec('ALTER TABLE services DROP COLUMN price_suv');

  db.prepare(
    "UPDATE appointments SET vehicle_category = 'passeio' WHERE vehicle_category IN ('hatch', 'sedan', 'suv')"
  ).run();
  db.prepare(
    "UPDATE appointments SET vehicle_category = 'utilitario' WHERE vehicle_category = 'pickup'"
  ).run();

  if (tableExists(db, 'vehicles')) {
    db.prepare(
      "UPDATE vehicles SET category = 'passeio' WHERE category IN ('hatch', 'sedan', 'suv')"
    ).run();
    db.prepare(
      "UPDATE vehicles SET category = 'utilitario' WHERE category = 'pickup'"
    ).run();
  }
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

/* Identidade de clientes v2. Duplicados nunca são mesclados: ficam no
   relatório e sem phone_normalized, enquanto números inequívocos recebem a
   chave canônica e podem ser protegidos por índice UNIQUE parcial. */
function migrateCustomerIdentityV2(db) {
  ensureColumn(db, 'customers', 'phone_normalized', 'TEXT');
  ensureColumn(db, 'appointments', 'customer_id', 'INTEGER REFERENCES customers(id)');
  ensureColumn(db, 'appointments', 'vehicle_id', 'INTEGER REFERENCES vehicles(id)');
  ensureColumn(db, 'appointments', 'completion_payment_method', 'TEXT');
  ensureColumn(db, 'appointments', 'completed_by_user_id', 'INTEGER');
  ensureColumn(db, 'appointments', 'completed_at', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_phone_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_normalized TEXT NOT NULL,
      customer_ids_json TEXT NOT NULL,
      details_json TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      detected_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(phone_normalized)
    );
  `);

  const grouped = new Map();
  for (const row of db.prepare('SELECT id, name, phone, cpf FROM customers ORDER BY id').all()) {
    const normalized = normalizeBrazilianPhone(row.phone);
    if (!normalized) continue;
    if (!grouped.has(normalized)) grouped.set(normalized, []);
    grouped.get(normalized).push(row);
  }
  const setCanonical = db.prepare('UPDATE customers SET phone = ?, phone_normalized = ? WHERE id = ?');
  const clearCanonical = db.prepare('UPDATE customers SET phone_normalized = NULL WHERE id = ?');
  const conflict = db.prepare(`INSERT INTO customer_phone_conflicts
    (phone_normalized, customer_ids_json, details_json) VALUES (?, ?, ?)
    ON CONFLICT(phone_normalized) DO UPDATE SET customer_ids_json=excluded.customer_ids_json,
      details_json=excluded.details_json, detected_at=datetime('now', 'localtime')`);
  for (const [phone, rows] of grouped) {
    if (rows.length === 1) setCanonical.run(phone, phone, rows[0].id);
    else {
      rows.forEach((row) => clearCanonical.run(row.id));
      conflict.run(phone, JSON.stringify(rows.map((row) => row.id)), JSON.stringify(rows));
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_phone_normalized
      ON customers(phone_normalized) WHERE phone_normalized IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_vehicle ON appointments(vehicle_id);
  `);

  const uniqueCustomer = db.prepare('SELECT id FROM customers WHERE phone_normalized = ?');
  const linkAppointment = db.prepare('UPDATE appointments SET customer_id = ?, customer_phone = ? WHERE id = ?');
  for (const appt of db.prepare('SELECT id, customer_phone FROM appointments WHERE customer_id IS NULL').all()) {
    const phone = normalizeBrazilianPhone(appt.customer_phone);
    if (!phone) continue;
    const customer = uniqueCustomer.get(phone);
    if (customer) linkAppointment.run(customer.id, phone, appt.id);
  }
}

/* WhatsApp (mensagens automáticas): tabelas já nascem em createTables; aqui
   garantimos índices e o seed dos modelos padrão NEUTROS (sem sobrescrever
   edições do tenant — INSERT OR IGNORE). Idempotente via schema_migrations. */
function migrateWhatsappV1(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_woutbox_status ON whatsapp_outbox (status);
    CREATE INDEX IF NOT EXISTS idx_woutbox_created ON whatsapp_outbox (created_at);
  `);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO whatsapp_message_templates (event_key, name, content, enabled)
     VALUES (?, ?, ?, 1)`
  );
  for (const t of WHATSAPP_DEFAULT_TEMPLATES) {
    insert.run(t.event_key, t.name, t.content);
  }
}

/* WhatsApp v2 — histórico imutável de mensagens + processed_at na outbox.
   A tabela whatsapp_message_history já nasce em createTables (CREATE TABLE
   IF NOT EXISTS); aqui garantimos a coluna processed_at em bancos antigos. */
function migrateWhatsappV2(db) {
  db.exec(whatsappMessageHistoryDDL);
  ensureColumn(db, 'whatsapp_outbox', 'processed_at', 'TEXT');
}

function migratePackageCreditWhatsappV1(db) {
  const template = WHATSAPP_DEFAULT_TEMPLATES.find((item) => item.event_key === 'PACKAGE_CREDIT_USED');
  db.prepare(`INSERT OR IGNORE INTO whatsapp_message_templates (event_key, name, content, enabled)
    VALUES (?, ?, ?, 1)`).run(template.event_key, template.name, template.content);
}

/* Documentos legais v1 — tabelas + seed dos documentos padrão NEUTROS.
   INSERT OR IGNORE preserva edições da empresa (idempotente). */
function migrateLegalDocumentsV1(db) {
  db.exec(appointmentLegalAcceptancesDDL);
  db.exec(legalDocumentVersionsDDL);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO legal_documents (doc_key, title, content, version, effective_at, published)
     VALUES (?, ?, ?, '1.0', datetime('now', 'localtime'), 1)`
  );
  for (const d of DEFAULT_LEGAL_DOCUMENTS) {
    insert.run(d.doc_key, d.title, d.content);
  }
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
  db.exec(whatsappMessageTemplatesDDL);
  db.exec(whatsappOutboxDDL);
  db.exec(whatsappMessageHistoryDDL);
  db.exec(legalDocumentsDDL);
  db.exec(appointmentLegalAcceptancesDDL);
  db.exec(legalDocumentVersionsDDL);
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

  /* Identificação empresarial usada nos documentos legais (Termos de Uso e
     Aviso de Privacidade) e opcionalmente em outras telas. Todos opcionais:
     a ausência de um dado apenas o omite no texto gerado, sem "undefined". */
  ensureColumn(db, 'company_settings', 'document', 'TEXT');
  ensureColumn(db, 'company_settings', 'email', 'TEXT');
  ensureColumn(db, 'company_settings', 'address', 'TEXT');

  /* Pagamento via Pix: chave copia e cola e nome do recebedor. A imagem do
     QR Code fica como asset do tenant (assets/tenant_XXXX/pix_qr.*), sem
     coluna no banco — a presença do arquivo em disco é a fonte da verdade. */
  ensureColumn(db, 'company_settings', 'pix_code', 'TEXT');
  ensureColumn(db, 'company_settings', 'pix_company_name', 'TEXT');

  /* Formas de pagamento habilitadas (JSON array de 'local' | 'card' | 'pix' |
     'qrcode'). As desabilitadas não aparecem para o cliente no passo de pagamento. */
  ensureColumn(db, 'company_settings', 'payment_methods_enabled', "TEXT NOT NULL DEFAULT '[\"local\",\"card\",\"pix\",\"qrcode\"]'");

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

  /* Marca e cor deixaram de fazer parte dos dados de veículo. Remove as
     colunas legadas dos bancos existentes; bancos novos já nascem sem elas. */
  if (!migrationApplied(db, 'remove_vehicle_brand_color_v1')) {
    const removeVehicleDetails = db.transaction(() => {
      for (const [table, column] of [
        ['appointments', 'vehicle_brand'],
        ['appointments', 'vehicle_color'],
        ['vehicles', 'brand'],
        ['vehicles', 'color']
      ]) {
        if (columnNames(db, table).includes(column)) {
          db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        }
      }
      markMigration(db, 'remove_vehicle_brand_color_v1');
    });
    removeVehicleDetails();
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

  /* Categorias de veículo simplificadas: roda antes dos seeds que referenciam
     as colunas de preço/duração (seed_durations_v1). */
  if (!migrationApplied(db, 'categories_v2')) {
    migrateCategoriesV2(db);
    markMigration(db, 'categories_v2');
  }

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

  if (!migrationApplied(db, 'customer_identity_v2')) {
    migrateCustomerIdentityV2(db);
    markMigration(db, 'customer_identity_v2');
  }

  /* WhatsApp (mensagens automáticas): seed dos modelos padrão + marco. */
  if (!migrationApplied(db, 'whatsapp_v1')) {
    migrateWhatsappV1(db);
    markMigration(db, 'whatsapp_v1');
  }

  /* WhatsApp v2: histórico imutável + processed_at na outbox. */
  if (!migrationApplied(db, 'whatsapp_v2')) {
    migrateWhatsappV2(db);
    markMigration(db, 'whatsapp_v2');
  }
  if (!migrationApplied(db, 'package_credit_whatsapp_v1')) {
    migratePackageCreditWhatsappV1(db);
    markMigration(db, 'package_credit_whatsapp_v1');
  }

  /* Documentos legais (LGPD): tabelas + seed dos documentos padrão. */
  if (!migrationApplied(db, 'legal_documents_v1')) {
    migrateLegalDocumentsV1(db);
    markMigration(db, 'legal_documents_v1');
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
  WHATSAPP_DEFAULT_TEMPLATES,
  DEFAULT_LEGAL_DOCUMENTS,
  tableExists,
  columnNames,
  ensureColumn
};
