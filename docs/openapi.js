/*
 * docs/openapi.js
 *
 * Especificação OpenAPI 3.0.0 da API pública do PapiCore (/api/v1).
 * Servida em GET /api/v1/openapi.json e documentada em /api/docs (ReDoc).
 * Não expõe nenhum segredo: apenas schemas, parâmetros e exemplos.
 */

'use strict';

const webhookService = require('../services/webhookService');

const scopesDescription = [
  'settings:read — configurações da empresa',
  'catalog:read — modalidades, unidades e catálogo de serviços',
  'availability:read — consulta de horários disponíveis',
  'appointments:read — leitura de agendamentos e clientes vinculados',
  'appointments:write — criar/concluir/cancelar agendamentos',
  'customers:read — leitura de clientes',
  'packages:read — leitura de pacotes de serviços'
].join('  \n');

const bearerAuth = {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'pk_live_...',
  description: `Chave de API gerada na aba "API" do Painel do Desenvolvedor.\n\nA chave pura é mostrada apenas uma vez no momento da criação.\n\nEscopos disponíveis:\n${scopesDescription}`
};

function appointmentSchema(ref = true) {
  const base = {
    type: 'object',
    properties: {
      id: { type: 'integer', example: 42 },
      appointment_code: { type: 'string', example: 'AG-20260806-K2T9' },
      status: { type: 'string', enum: ['pending', 'confirmed', 'rejected', 'completed', 'cancelled'] },
      customer_name: { type: 'string', example: 'João da Silva' },
      customer_phone: { type: 'string', example: '5511999999999' },
      customer_email: { type: ['string', 'null'] },
      vehicle_plate: { type: 'string', example: 'ABC1D23' },
      vehicle_model: { type: 'string', example: 'Gol' },
      vehicle_category: { type: 'string', enum: ['passeio', 'utilitario'] },
      modality_name: { type: 'string' },
      unit_name: { type: ['string', 'null'] },
      service_name: { type: 'string' },
      appointment_date: { type: 'string', example: '2026-08-10' },
      start_time: { type: 'string', example: '09:00' },
      end_date: { type: 'string' },
      end_time: { type: 'string' },
      total_price: { type: 'number' },
      payment_method: { type: ['string', 'null'] },
      payment_source: { type: 'string', enum: ['PACKAGE', null] },
      customer_notes: { type: ['string', 'null'] },
      created_at: { type: 'string' }
    }
  };
  return ref ? base : base;
}

const errorSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', example: 'Mensagem de erro.' }
  }
};

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'PapiCore API',
    description: `API pública de agendamento do PapiCore.

Autenticação: envie a chave de API no cabeçalho \`Authorization: Bearer <chave>\`.

Requisições de escrita exigem o cabeçalho \`Idempotency-Key\` (qualquer valor único, ex.: UUID). Se você repetir a mesma chave com o mesmo corpo, recebe a mesma resposta sem duplicar a operação.

Todas as datas usam o formato ISO \`AAAA-MM-DD\` (fuso local da empresa) e horários \`HH:MM\`.

Webhooks: assinatura HMAC-SHA256 no cabeçalho \`X-PapiCore-Signature\` (\`sha256=<hex>\`).`,
    version: '1.0.0',
    contact: { name: 'PapiCore' }
  },
  servers: [{ url: '/api/v1', description: 'API pública do PapiCore' }],
  tags: [
    { name: 'Configurações', description: 'Dados públicos da empresa' },
    { name: 'Catálogo', description: 'Modalidades, unidades e serviços' },
    { name: 'Disponibilidade', description: 'Horários livres' },
    { name: 'Agendamentos', description: 'CRUD de agendamentos' },
    { name: 'Clientes', description: 'Leitura de clientes' },
    { name: 'Pacotes', description: 'Pacotes de serviços' },
    { name: 'Webhooks', description: `Eventos de webhook: ${webhookService.WEBHOOK_EVENT_LIST.join(', ')}` }
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    '/settings': {
      get: {
        tags: ['Configurações'],
        summary: 'Configurações públicas da empresa',
        security: [{ bearerAuth: ['settings:read'] }],
        responses: {
          '200': {
            description: 'Configurações (horários, expediente, formas de pagamento).',
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        }
      }
    },
    '/modalities': {
      get: {
        tags: ['Catálogo'],
        summary: 'Formas de atendimento ativas',
        security: [{ bearerAuth: ['catalog:read'] }],
        responses: { '200': { description: 'Lista de modalidades.' } }
      }
    },
    '/units': {
      get: {
        tags: ['Catálogo'],
        summary: 'Unidades ativas',
        security: [{ bearerAuth: ['catalog:read'] }],
        responses: { '200': { description: 'Lista de unidades.' } }
      }
    },
    '/catalog': {
      get: {
        tags: ['Catálogo'],
        summary: 'Catálogo de serviços por categoria',
        parameters: [
          { name: 'modality_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'Filtra os serviços pela forma de atendimento.' }
        ],
        security: [{ bearerAuth: ['catalog:read'] }],
        responses: { '200': { description: 'Categorias e serviços.' } }
      }
    },
    '/availability': {
      get: {
        tags: ['Disponibilidade'],
        summary: 'Horários disponíveis em uma data',
        parameters: [
          { name: 'modality_id', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'service_ids', in: 'query', required: true, schema: { type: 'string' }, description: 'IDs dos serviços separados por vírgula (ex.: 1,2).' },
          { name: 'date', in: 'query', required: true, schema: { type: 'string', example: '2026-08-10' } },
          { name: 'unit_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'Obrigatório para a modalidade "in-store".' },
          { name: 'vehicle_category', in: 'query', required: false, schema: { type: 'string', enum: ['passeio', 'utilitario'] } }
        ],
        security: [{ bearerAuth: ['availability:read'] }],
        responses: { '200': { description: 'Slots disponíveis/ocupados para a data.' } }
      }
    },
    '/appointments': {
      get: {
        tags: ['Agendamentos'],
        summary: 'Lista agendamentos (com filtros)',
        parameters: [
          { name: 'date', in: 'query', required: false, schema: { type: 'string' }, description: 'Data exata (AAAA-MM-DD).' },
          { name: 'from', in: 'query', required: false, schema: { type: 'string' }, description: 'Início do intervalo de datas.' },
          { name: 'to', in: 'query', required: false, schema: { type: 'string' }, description: 'Fim do intervalo de datas.' },
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'confirmed', 'rejected', 'completed', 'cancelled'] } },
          { name: 'search', in: 'query', required: false, schema: { type: 'string' }, description: 'Busca por cliente, telefone, placa ou código.' }
        ],
        security: [{ bearerAuth: ['appointments:read'] }],
        responses: { '200': { description: 'Lista de agendamentos.', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Appointment' } } } } } }
      },
      post: {
        tags: ['Agendamentos'],
        summary: 'Cria um agendamento',
        description: 'Idempotente: envie o cabeçalho Idempotency-Key. Dispara o webhook "appointment.created".',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' }, description: 'Valor único por operação (ex.: UUID).' }
        ],
        security: [{ bearerAuth: ['appointments:write'] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['modality_id', 'service_ids', 'customer_name', 'customer_phone', 'vehicle_model', 'vehicle_plate', 'vehicle_color', 'vehicle_category', 'appointment_date', 'start_time'],
                properties: {
                  modality_id: { type: 'integer', example: 1 },
                  unit_id: { type: 'integer', description: 'Obrigatório para in-store.' },
                  service_ids: { type: 'array', items: { type: 'integer' }, example: [1, 2] },
                  customer_name: { type: 'string' },
                  customer_phone: { type: 'string', example: '(11) 98888-7777' },
                  customer_email: { type: 'string' },
                  customer_cpf: { type: 'string' },
                  vehicle_brand: { type: 'string' },
                  vehicle_model: { type: 'string' },
                  vehicle_year: { type: 'string' },
                  vehicle_plate: { type: 'string', example: 'ABC1D23' },
                  vehicle_color: { type: 'string' },
                  vehicle_category: { type: 'string', enum: ['passeio', 'utilitario'] },
                  appointment_date: { type: 'string', example: '2026-08-10' },
                  start_time: { type: 'string', example: '09:00' },
                  payment_method: { type: 'string', enum: ['local', 'card', 'pix', 'qrcode'] },
                  customer_notes: { type: 'string' }
                }
              },
              example: {
                modality_id: 1,
                unit_id: 1,
                service_ids: [1],
                customer_name: 'João da Silva',
                customer_phone: '(11) 98888-7777',
                customer_email: 'joao@example.com',
                vehicle_brand: 'Volkswagen',
                vehicle_model: 'Gol',
                vehicle_year: '2020',
                vehicle_plate: 'ABC1D23',
                vehicle_color: 'Branco',
                vehicle_category: 'passeio',
                appointment_date: '2026-08-10',
                start_time: '09:00'
              }
            }
          }
        },
        responses: {
          '201': { description: 'Agendamento criado.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Appointment' } } } },
          '400': { $ref: '#/components/responses/Error' },
          '409': { description: 'Horário ocupado ou requisição em andamento.' },
          '422': { description: 'Idempotency-Key já usada com corpo diferente.' },
          '429': { description: 'Limite de requisições excedido.' }
        }
      }
    },
    '/appointments/code/{code}': {
      get: {
        tags: ['Agendamentos'],
        summary: 'Consulta um agendamento pelo código',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' }, example: 'AG-20260806-K2T9' }],
        security: [{ bearerAuth: ['appointments:read'] }],
        responses: { '200': { description: 'Agendamento.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Appointment' } } } }, '404': { $ref: '#/components/responses/Error' } }
      }
    },
    '/appointments/{id}': {
      get: {
        tags: ['Agendamentos'],
        summary: 'Consulta um agendamento pelo ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        security: [{ bearerAuth: ['appointments:read'] }],
        responses: { '200': { description: 'Agendamento.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Appointment' } } } }, '404': { $ref: '#/components/responses/Error' } }
      }
    },
    '/appointments/{id}/complete': {
      post: {
        tags: ['Agendamentos'],
        summary: 'Conclui um agendamento',
        description: 'Consome o crédito do pacote quando aplicável e gera a entrada financeira automática. Idempotente (Idempotency-Key). Dispara o webhook "appointment.completed".',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }
        ],
        security: [{ bearerAuth: ['appointments:write'] }],
        responses: { '200': { description: 'Agendamento concluído.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Appointment' } } } } }
      }
    },
    '/appointments/{id}/cancel': {
      post: {
        tags: ['Agendamentos'],
        summary: 'Cancela um agendamento',
        description: 'Libera o crédito do pacote quando reservado. Idempotente (Idempotency-Key). Dispara o webhook "appointment.cancelled".',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }
        ],
        security: [{ bearerAuth: ['appointments:write'] }],
        responses: { '200': { description: 'Agendamento cancelado.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Appointment' } } } } }
      }
    },
    '/customers': {
      get: {
        tags: ['Clientes'],
        summary: 'Lista clientes',
        parameters: [{ name: 'search', in: 'query', required: false, schema: { type: 'string' } }],
        security: [{ bearerAuth: ['customers:read'] }],
        responses: { '200': { description: 'Lista de clientes.' } }
      }
    },
    '/customers/{id}': {
      get: {
        tags: ['Clientes'],
        summary: 'Detalhes de um cliente (com veículos e pacotes)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        security: [{ bearerAuth: ['customers:read'] }],
        responses: { '200': { description: 'Cliente.', content: { 'application/json': { schema: { type: 'object' } } } }, '404': { $ref: '#/components/responses/Error' } }
      }
    },
    '/packages': {
      get: {
        tags: ['Pacotes'],
        summary: 'Modelos de pacote de serviços',
        security: [{ bearerAuth: ['packages:read'] }],
        responses: { '200': { description: 'Lista de modelos de pacote.' } }
      }
    },
    '/customer-packages': {
      get: {
        tags: ['Pacotes'],
        summary: 'Pacotes vendidos a clientes',
        parameters: [
          { name: 'customer_id', in: 'query', required: false, schema: { type: 'integer' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'search', in: 'query', required: false, schema: { type: 'string' } }
        ],
        security: [{ bearerAuth: ['packages:read'] }],
        responses: { '200': { description: 'Lista de pacotes vendidos.' } }
      }
    },
    '/customer-packages/{id}': {
      get: {
        tags: ['Pacotes'],
        summary: 'Detalhes de um pacote vendido',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        security: [{ bearerAuth: ['packages:read'] }],
        responses: { '200': { description: 'Pacote vendido.', content: { 'application/json': { schema: { type: 'object' } } } }, '404': { $ref: '#/components/responses/Error' } }
      }
    }
  },
  components: {
    securitySchemes: { bearerAuth },
    schemas: { Appointment: appointmentSchema(), Error: errorSchema },
    responses: {
      Error: {
        description: 'Erro',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
      }
    }
  }
};

module.exports = { spec };
