/*
 * evolutionService.js
 *
 * Cliente da Evolution API (WhatsApp real) + registro de conexões no banco
 * core. Complementa o whatsappService: enquanto o desenvolvedor não habilitar
 * a Evolution no painel, o envio continua em MOCK/Graph (comportamento
 * existente intacto).
 *
 * Mapa tenancy:
 *   - A outbox e os templates vivem no banco do tenant (whatsappService).
 *   - Cada empresa tem UMA instância Evolution (1 QR Code), cujo registro
 *     fica no banco core em evolution_instances (tenant_id único).
 *   - As credenciais globais (server_url + api_key) ficam em
 *     evolution_settings (1 linha) e podem ser gravadas pelo desenvolvedor
 *     no painel ou via variáveis de ambiente EVOLUTION_*.
 *
 * Endpoints Evolution usados (padrão da v2):
 *   POST   /instance/create/{instanceName}          criar instância
 *   POST   /instance/fetchInstances                 listar (usado no teste de conexão)
 *   GET    /instance/connect/{instanceName}         obter QR (base64)
 *   GET    /instance/connectionState/{instanceName} estado da conexão
 *   DELETE /instance/disconnect/{instanceName}      desconectar
 *   POST   /message/sendText/{instanceName}         enviar mensagem
 */

const path = require('path');
const {
  getEvolutionSettings,
  getEvolutionInstance,
  getEvolutionInstanceByDatabaseName,
  upsertEvolutionInstance,
  deleteEvolutionInstance,
  getTenantById,
  listTenants
} = require('../database/coreDatabase');
const { normalizePhone } = require('../utils/helpers');

/* Evolution (e o WhatsApp em geral) usa número no formato internacional.
   Para números brasileiros sem DDI (10-11 dígitos) adiciona o 55. Números que
   já vêm com código de país (12+ dígitos) são mantidos como estão. */
function toInternationalPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return '';
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

const INSTANCE_STATUSES = ['disconnected', 'connecting', 'connected', 'error'];

const DEFAULT_INSTANCE_NAME = 'papicore';

function sanitizeSettings(settings) {
  return {
    enabled: Boolean(settings && settings.enabled),
    server_url: (settings && settings.server_url) || '',
    api_key: (settings && settings.api_key) || ''
  };
}

function isConfigured(settings) {
  const s = sanitizeSettings(settings);
  return Boolean(s.enabled && s.server_url && s.api_key);
}

function getStatus() {
  const settings = sanitizeSettings(getEvolutionSettings());
  return {
    configured: isConfigured(settings),
    enabled: settings.enabled,
    server_url: settings.server_url,
    mock: !settings.enabled
  };
}

/* Nome da instância deriva do arquivo do banco do tenant (único por empresa),
   com fallback para um nome genérico quando o caminho não estiver disponível
   (ex.: bancos em memória em testes). */
function instanceNameFromDatabaseName(databaseName) {
  const base = String(databaseName || '').trim();
  if (!base) return DEFAULT_INSTANCE_NAME;
  const file = base.includes('\\') || base.includes('/') ? path.basename(base) : base;
  return file.replace(/\.[^.]*$/, '').toLowerCase() || DEFAULT_INSTANCE_NAME;
}

function instanceNameFromDb(db) {
  if (!db) return DEFAULT_INSTANCE_NAME;
  return instanceNameFromDatabaseName(db.name);
}

/* ---------- HTTP ---------- */

async function apiFetch(settings, endpoint, { method = 'GET', body } = {}) {
  const s = sanitizeSettings(settings);
  const url = `${String(s.server_url).replace(/\/+$/, '')}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  if (s.api_key) headers.apikey = s.api_key;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/* ---------- Ações remotas ---------- */

async function createInstance(settings, instanceName) {
  const { ok, status, data } = await apiFetch(settings, `/instance/create/${instanceName}`, {
    method: 'POST',
    body: { integration: 'WHATSAPP', qrcode: true }
  });
  if (!ok) {
    const message = (data && (data.response && data.response.message || data.message)) || `HTTP ${status}`;
    return { error: true, status, message };
  }
  return { ok: true, data };
}

async function fetchQRCode(settings, instanceName) {
  const { ok, status, data } = await apiFetch(settings, `/instance/connect/${instanceName}`);
  if (!ok || !data || !data.base64) {
    const message = (data && (data.response && data.response.message || data.message)) || `HTTP ${status}`;
    return { error: true, status, message };
  }
  return { ok: true, qr: data.base64 };
}

async function remoteConnectionState(settings, instanceName) {
  const { ok, status, data } = await apiFetch(settings, `/instance/connectionState/${instanceName}`);
  if (!ok) return { ok: false, status };
  const remote = (data && data.instance) || {};
  return {
    ok: true,
    connected: remote.status === 'open',
    status: remote.status || 'closed',
    owner_number: remote.number || remote.ownerJid || '',
    owner_name: remote.name || remote.ownerName || ''
  };
}

async function remoteDisconnect(settings, instanceName) {
  const { ok, status } = await apiFetch(settings, `/instance/disconnect/${instanceName}`, { method: 'DELETE' });
  return { ok, status };
}

/* ---------- Registro local (banco core) ---------- */

function safeInstance(instance) {
  if (!instance) return null;
  return {
    instance_name: instance.instance_name,
    status: INSTANCE_STATUSES.includes(instance.status) ? instance.status : 'disconnected',
    owner_number: instance.owner_number || '',
    owner_name: instance.owner_name || '',
    qr_base64: instance.qr_base64 || '',
    last_error: instance.last_error || ''
  };
}

/* ---------- Ações de alto nível (usadas pelas rotas) ---------- */

/* Estado combinado para o painel do cliente: informa se a Evolution está
   disponível, o status atual e o QR quando houver. */
function connectionState(tenant) {
  const settings = sanitizeSettings(getEvolutionSettings());
  const instance = getEvolutionInstance(tenant.id);
  const base = {
    provider: 'evolution',
    available: isConfigured(settings),
    settings_configured: settings.enabled
  };
  if (!isConfigured(settings)) {
    return {
      ...base,
      reason: settings.enabled ? 'api_key_ou_url_incompletos' : 'evolution_nao_configurada',
      status: instance && instance.status ? instance.status : 'disconnected',
      instance: safeInstance(instance)
    };
  }
  const state = instance && instance.status;
  if (state === 'connected') {
    return { ...base, status: 'connected', instance: safeInstance(instance) };
  }
  if (state === 'connecting' && instance && instance.qr_base64) {
    return { ...base, status: 'connecting', qr: instance.qr_base64, instance: safeInstance(instance) };
  }
  return { ...base, status: state || 'disconnected', instance: safeInstance(instance) };
}

/*
 * Conecta uma empresa: cria a instância na Evolution (se ainda não existe),
 * busca o QR Code e devolve ao front para exibição. O status fica
 * "connecting" até o usuário escanear; quando o cliente recarregar o painel,
 * connectionState() reflete "connected".
 */
async function connect(tenant, { force = false } = {}) {
  const settings = sanitizeSettings(getEvolutionSettings());
  if (!isConfigured(settings)) {
    return { error: true, code: 'evolution_not_configured', message: 'Evolution API ainda não está configurada no painel do desenvolvedor.' };
  }
  const instanceName = instanceNameFromDatabaseName(tenant.database_name);
  const current = getEvolutionInstance(tenant.id);

  if (force && current) {
    try { await remoteDisconnect(settings, current.instance_name); } catch (err) { /* ignora */ }
    deleteEvolutionInstance(tenant.id);
  }

  if (!current || force) {
    const created = await createInstance(settings, instanceName);
    if (created.error) {
      return { error: true, message: `Não foi possível criar a instância: ${created.message}` };
    }
  }

  upsertEvolutionInstance(tenant.id, {
    tenant_id: tenant.id,
    database_name: tenant.database_name,
    instance_name: instanceName,
    status: 'connecting',
    qr_base64: '',
    last_error: null
  });

  const qr = await fetchQRCode(settings, instanceName);
  if (qr.error) {
    upsertEvolutionInstance(tenant.id, { status: 'error', last_error: qr.message });
    return { error: true, message: `Não foi possível obter o QR Code: ${qr.message}` };
  }

  upsertEvolutionInstance(tenant.id, { status: 'connecting', qr_base64: qr.qr, last_error: null });
  return { ok: true, status: 'connecting', qr: qr.qr };
}

/*
 * Reconecta: desconecta a instância atual e gera um novo QR. Equivale a
 * connect(force = true) e é usado tanto pelo cliente quanto pelo desenvolvedor.
 */
async function reconnect(tenant) {
  return connect(tenant, { force: true });
}

async function disconnect(tenant) {
  const settings = sanitizeSettings(getEvolutionSettings());
  const current = getEvolutionInstance(tenant.id);
  if (current && isConfigured(settings)) {
    try { await remoteDisconnect(settings, current.instance_name); } catch (err) { /* ignora */ }
  }
  deleteEvolutionInstance(tenant.id);
  return { ok: true, status: 'disconnected' };
}

/* Verificação do servidor: tenta listar instâncias para validar URL + chave.
   Aceita um override de settings para testar valores ainda não salvos. */
async function testConnection(settingsOverride) {
  const settings = sanitizeSettings(settingsOverride || getEvolutionSettings());
  if (!settings.server_url || !settings.api_key) {
    return { error: true, message: 'Informe a URL e a API key antes de testar a conexão.' };
  }
  try {
    const { ok, status, data } = await apiFetch(settings, '/instance/fetchInstances', { method: 'POST' });
    if (!ok) {
      const message = (data && (data.response && data.response.message || data.message)) || `HTTP ${status}`;
      return { error: true, message: `Falha na conexão: ${message}` };
    }
    const instances = Array.isArray(data) ? data : (data && data.instances) || [];
    return { ok: true, instances: instances.map((i) => ({ name: i.instanceName || i.name || '', status: i.connectionState || i.status || 'unknown' })) };
  } catch (err) {
    return { error: true, message: `Falha de rede: ${err.message}` };
  }
}

/* ---------- Envio real (usado pelo whatsappService quando habilitada) ---------- */

async function sendTextMessage(to, text, instanceName) {
  const settings = sanitizeSettings(getEvolutionSettings());
  if (!isConfigured(settings)) {
    return { skipped: true, reason: 'not_configured' };
  }
  const phone = toInternationalPhone(to);
  if (!phone) {
    return { skipped: true, reason: 'invalid_recipient' };
  }
  try {
    const { ok, status, data } = await apiFetch(settings, `/message/sendText/${instanceName || DEFAULT_INSTANCE_NAME}`, {
      method: 'POST',
      body: { number: phone, text }
    });
    if (!ok) {
      const message = (data && (data.response && data.response.message || data.message)) || `HTTP ${status}`;
      console.error(`[evolution] Falha no envio para ${phone}: ${message}`);
      return { error: true, status, message };
    }
    return { ok: true, id: (data && (data.key && data.key.id)) || '' };
  } catch (err) {
    console.error(`[evolution] Erro de rede ao enviar para ${phone}:`, err.message);
    return { error: true, status: 0, message: err.message };
  }
}

/* Resumo por empresa para o painel do desenvolvedor. */
function overview() {
  const settings = sanitizeSettings(getEvolutionSettings());
  return {
    enabled: settings.enabled,
    configured: isConfigured(settings),
    server_url: settings.server_url,
    api_key_defined: Boolean(settings.api_key),
    instances: listInstancesOverview()
  };
}

function listInstancesOverview() {
  const tenants = listTenants();
  return tenants.map((t) => {
    const instance = getEvolutionInstance(t.id);
    return {
      tenant_id: t.id,
      name: t.name,
      slug: t.slug,
      database_name: t.database_name,
      status: instance ? instance.status : 'disconnected',
      instance_name: instance ? instance.instance_name : instanceNameFromDatabaseName(t.database_name),
      owner_number: instance ? instance.owner_number || '' : '',
      qr_base64: instance && instance.status === 'connecting' ? instance.qr_base64 || '' : '',
      last_error: instance ? instance.last_error || '' : ''
    };
  });
}

/*
 * Atualiza o status local a partir da Evolution (usado ao consultar o painel).
 * Não lança erro: em falha de rede mantém o último status conhecido.
 */
async function refreshStatus(tenant) {
  const settings = sanitizeSettings(getEvolutionSettings());
  const instance = getEvolutionInstance(tenant.id);
  if (!isConfigured(settings) || !instance) return { ok: true, status: instance ? instance.status : 'disconnected' };
  try {
    const remote = await remoteConnectionState(settings, instance.instance_name);
    if (remote.ok) {
      if (remote.connected) {
        upsertEvolutionInstance(tenant.id, {
          status: 'connected',
          owner_number: remote.owner_number,
          owner_name: remote.owner_name,
          qr_base64: '',
          last_error: null
        });
      } else if (remote.status === 'open') {
        upsertEvolutionInstance(tenant.id, { status: 'connected' });
      } else {
        upsertEvolutionInstance(tenant.id, { status: 'disconnected', qr_base64: '' });
      }
      return { ok: true, status: remote.connected ? 'connected' : 'disconnected' };
    }
  } catch (err) {
    console.error(`[evolution] Falha ao consultar status de ${instance.instance_name}:`, err.message);
  }
  return { ok: true, status: instance.status };
}

module.exports = {
  INSTANCE_STATUSES,
  DEFAULT_INSTANCE_NAME,
  getStatus,
  isConfigured,
  sanitizeSettings,
  toInternationalPhone,
  instanceNameFromDatabaseName,
  instanceNameFromDb,
  connectionState,
  connect,
  reconnect,
  disconnect,
  testConnection,
  sendTextMessage,
  refreshStatus,
  overview,
  getEvolutionSettings,
  getEvolutionInstanceByDatabaseName,
  getEvolutionInstance,
  getTenantById
};
