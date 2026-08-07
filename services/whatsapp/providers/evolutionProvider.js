/*
 * evolutionProvider.js
 *
 * Provider REAL de WhatsApp do PapiCore via Evolution API. Só é ativado quando
 * a plataforma está com envio habilitado (WHATSAPP_ENABLED=true) E a Evolution
 * configurada (URL + API key) — decisão tomada no whatsappService.
 *
 * Cada empresa tem UMA instância Evolution (1 QR Code por tenant), registrada
 * em evolution_instances no banco core. As credenciais globais ficam em
 * evolution_settings (1 linha) e podem vir do painel do desenvolvedor ou das
 * variáveis de ambiente EVOLUTION_*.
 *
 * Endpoints Evolution usados (validados contra o código-fonte da v2.3.7):
 *   POST   /instance/create                         criar instância
 *   GET    /instance/fetchInstances                 listar (teste de conexão)
 *   GET    /instance/connect/{instanceName}         obter QR (base64)
 *   GET    /instance/connectionState/{instanceName} estado da conexão
 *   DELETE /instance/logout/{instanceName}          desconectar
 *   DELETE /instance/delete/{instanceName}          excluir instância
 *   POST   /message/sendText/{instanceName}         enviar mensagem
 *   POST   /message/sendMedia/{instanceName}        enviar imagem/arquivo
 *   POST   /webhook/set/{instanceName}              configurar webhook
 *
 * Interface comum (mesma do mockProvider):
 *   name, testConnection(), createInstance(), deleteInstance(), connect(),
 *   disconnect(), generateQRCode(), sendText(), sendImage(), sendFile(),
 *   getStatus(), syncStatus(), receiveWebhook().
 */

'use strict';

const { getEvolutionSettings } = require('../../../database/coreDatabase');
const { normalizePhone } = require('../../../utils/helpers');

const NAME = 'evolution';
const INSTANCE_STATUSES = ['disconnected', 'connecting', 'connected', 'error'];
const DEFAULT_INSTANCE_NAME = 'papicore';
const DEFAULT_TIMEOUT_MS = 10000;
const ENDPOINTS = Object.freeze({
  listInstances: '/instance/fetchInstances',
  createInstance: '/instance/create',
  connect: (name) => `/instance/connect/${encodeURIComponent(name)}`,
  connectionState: (name) => `/instance/connectionState/${encodeURIComponent(name)}`,
  logout: (name) => `/instance/logout/${encodeURIComponent(name)}`,
  deleteInstance: (name) => `/instance/delete/${encodeURIComponent(name)}`,
  sendText: (name) => `/message/sendText/${encodeURIComponent(name)}`,
  sendMedia: (name) => `/message/sendMedia/${encodeURIComponent(name)}`,
  setWebhook: (name) => `/webhook/set/${encodeURIComponent(name)}`
});

/* Evolution (e o WhatsApp em geral) usa número no formato internacional.
   Para números brasileiros sem DDI (10-11 dígitos) adiciona o 55. Números que
   já vêm com código de país (12+ dígitos) são mantidos como estão. */
function toInternationalPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return '';
  let value = digits;
  if (digits.length === 10 || digits.length === 11) value = `55${digits}`;
  if (!/^\d{8,15}$/.test(value)) return '';
  if (value.startsWith('55')) {
    if (!/^55[1-9][0-9]\d{8,9}$/.test(value)) return '';
    const local = value.slice(4);
    if (local.length === 9 && local[0] !== '9') return '';
    if (local.length === 8 && !/^[2-8]/.test(local)) return '';
  } else if (value.length < 11) {
    return '';
  }
  return value;
}

function sanitizeSettings(settings) {
  return {
    enabled: Boolean(settings && settings.enabled),
    server_url: ((settings && (settings.server_url || settings.api_url)) || '').trim().replace(/\/+$/, ''),
    api_key: ((settings && settings.api_key) || '').trim(),
    timeout_ms: Math.max(100, Number(settings && settings.timeout_ms) || Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  };
}

function getSettings() {
  return sanitizeSettings(getEvolutionSettings());
}

function isConfigured(settings) {
  const s = sanitizeSettings(settings || getSettings());
  return Boolean(s.enabled && s.server_url && s.api_key);
}

/* ---------- HTTP ---------- */

async function apiFetch(settings, endpoint, { method = 'GET', body } = {}) {
  const s = sanitizeSettings(settings);
  if (!/^https?:\/\/[^\s]+$/i.test(s.server_url)) throw new Error('URL da Evolution inválida.');
  const url = `${s.server_url}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  if (s.api_key) headers.apikey = s.api_key;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), s.timeout_ms);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const responseText = typeof res.text === 'function'
      ? await res.text()
      : JSON.stringify(typeof res.json === 'function' ? await res.json() : {});
    const raw = s.api_key ? responseText.split(s.api_key).join('[REDACTED]') : responseText;
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0, 500) }; }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const timeoutError = new Error('Tempo limite excedido ao consultar a Evolution API.');
      timeoutError.code = 'EVOLUTION_TIMEOUT';
      throw timeoutError;
    }
    throw new Error('Não foi possível acessar a Evolution API.');
  } finally {
    clearTimeout(timer);
  }
}

function extractErrorMessage(data, status) {
  const value = data && ((data.response && data.response.message) || data.message || data.error);
  const text = Array.isArray(value) ? value.join('; ') : String(value || `HTTP ${status}`);
  return text.replace(/apikey|authorization|token/gi, 'credencial').slice(0, 500);
}

/* ---------- Ações remotas ---------- */

async function testConnection(settingsOverride) {
  const settings = sanitizeSettings(settingsOverride || getSettings());
  if (!settings.server_url || !settings.api_key) {
    return { error: true, message: 'Informe a URL e a API key antes de testar a conexão.' };
  }
  try {
    const { ok, status, data } = await apiFetch(settings, ENDPOINTS.listInstances);
    if (!ok) {
      return { error: true, message: `Falha na conexão: ${extractErrorMessage(data, status)}` };
    }
    const instances = Array.isArray(data) ? data : (data && data.instances) || [];
    const statusOf = (i) => {
      const cs = i.connectionStatus;
      if (cs && typeof cs === 'object') return cs.state || cs.status || 'unknown';
      return cs || i.connectionState || i.status || 'unknown';
    };
    return {
      ok: true,
      instances: instances.map((i) => ({ name: i.instanceName || i.name || '', status: statusOf(i) }))
    };
  } catch (err) {
    return { error: true, message: `Falha de rede: ${err.message}` };
  }
}

async function listInstances(settingsOverride) {
  const result = await testConnection(settingsOverride);
  return result.error ? result : { ok: true, instances: result.instances };
}

async function createInstance(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, ENDPOINTS.createInstance, {
    method: 'POST',
    body: { instanceName, integration: 'WHATSAPP-BAILEYS', qrcode: true }
  });
  if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
  return { ok: true, data };
}

async function deleteInstance(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, ENDPOINTS.deleteInstance(instanceName), { method: 'DELETE' });
  if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
  return { ok: true };
}

async function generateQRCode(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, ENDPOINTS.connect(instanceName));
  if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
  const payload = data && typeof data === 'object' ? data : {};
  const qrcode = payload.qrcode;
  let qr = '';
  if (typeof data === 'string') {
    qr = data;
  } else if (typeof qrcode === 'string') {
    qr = qrcode;
  } else if (qrcode && typeof qrcode === 'object') {
    qr = qrcode.base64 || '';
  }
  const code = (qrcode && typeof qrcode === 'object' && (qrcode.code || qrcode.base64 || '')) || payload.code || '';
  const pairingCode = (qrcode && typeof qrcode === 'object' && (qrcode.session || qrcode.pairingCode || '')) || payload.pairingCode || '';
  const instanceState = payload.instance && (payload.instance.state || payload.instance.status);
  if (!qr) {
    if (instanceState === 'open') return { ok: true, qr: '', state: 'open', code, pairingCode };
    if (code || pairingCode) return { ok: true, qr: '', code, pairingCode };
    return { error: true, status, message: extractErrorMessage(payload, status), code, pairingCode };
  }
  return { ok: true, qr, base64: typeof qr === 'string' ? qr : '', code, pairingCode, state: instanceState };
}

/* connect = cria a instância (se preciso) e devolve o QR Code. */
async function connect(instanceName, settings) {
  const created = await createInstance(instanceName, settings);
  if (created.error) return { error: true, message: `Não foi possível criar a instância: ${created.message}` };
  return generateQRCode(instanceName, settings);
}

async function disconnect(instanceName, settings) {
  return logout(instanceName, settings);
}

async function logout(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, ENDPOINTS.logout(instanceName), { method: 'DELETE' });
  if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
  return { ok, status };
}

async function getState(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, ENDPOINTS.connectionState(instanceName));
  if (!ok) return { ok: false, status };
  const remote = (data && data.instance) || {};
  const state = remote.state || remote.status || remote.connectionStatus || 'closed';
  return {
    ok: true,
    connected: state === 'open',
    status: state,
    owner_number: remote.number || remote.ownerJid || '',
    owner_name: remote.name || remote.ownerName || ''
  };
}

async function syncStatus(instanceName, settings) {
  return getState(instanceName, settings);
}

async function sendText(instanceName, to, text, settings) {
  if (!isConfigured(settings)) {
    return { skipped: true, reason: 'not_configured' };
  }
  const phone = toInternationalPhone(to);
  if (!phone) return { skipped: true, reason: 'invalid_recipient' };
  try {
    const { ok, status, data } = await apiFetch(settings, ENDPOINTS.sendText(instanceName || DEFAULT_INSTANCE_NAME), {
      method: 'POST',
      body: { number: phone, text }
    });
    if (!ok) {
      const message = extractErrorMessage(data, status);
      console.error(`[evolution] Falha no envio para ${phone}: ${message}`);
      return { error: true, status, message };
    }
    return { ok: true, id: (data && (data.key && data.key.id)) || '' };
  } catch (err) {
    console.error(`[evolution] Erro de rede ao enviar para ${phone}:`, err.message);
    return { error: true, status: 0, message: err.message };
  }
}

async function sendImage(instanceName, to, { url, caption } = {}, settings) {
  if (!isConfigured(settings)) return { skipped: true, reason: 'not_configured' };
  const phone = toInternationalPhone(to);
  if (!phone || !url) return { skipped: true, reason: 'invalid_media' };
  try {
    const { ok, status, data } = await apiFetch(settings, ENDPOINTS.sendMedia(instanceName || DEFAULT_INSTANCE_NAME), {
      method: 'POST',
      body: { number: phone, mediatype: 'image', media: url, caption: caption || '' }
    });
    if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
    return { ok: true, id: (data && (data.key && data.key.id)) || '' };
  } catch (err) {
    return { error: true, status: 0, message: err.message };
  }
}

async function sendFile(instanceName, to, { url, filename } = {}, settings) {
  if (!isConfigured(settings)) return { skipped: true, reason: 'not_configured' };
  const phone = toInternationalPhone(to);
  if (!phone || !url) return { skipped: true, reason: 'invalid_media' };
  try {
    const { ok, status, data } = await apiFetch(settings, ENDPOINTS.sendMedia(instanceName || DEFAULT_INSTANCE_NAME), {
      method: 'POST',
      body: { number: phone, mediatype: 'document', media: url, fileName: filename || 'arquivo' }
    });
    if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
    return { ok: true, id: (data && (data.key && data.key.id)) || '' };
  } catch (err) {
    return { error: true, status: 0, message: err.message };
  }
}

async function setWebhook(instanceName, webhook, settings) {
  const config = webhook || {};
  const body = {
    webhook: {
      enabled: config.enabled !== false,
      url: String(config.url || ''),
      byEvents: Boolean(config.byEvents || config.webhookByEvents),
      base64: Boolean(config.base64),
      headers: config.headers && typeof config.headers === 'object' ? config.headers : {},
      events: config.events || ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'SEND_MESSAGE', 'STATUS_INSTANCE']
    }
  };
  if (!/^https:\/\//i.test(body.webhook.url)) return { error: true, message: 'O webhook precisa usar URL HTTPS.' };
  const { ok, status, data } = await apiFetch(settings, ENDPOINTS.setWebhook(instanceName), { method: 'POST', body });
  if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
  return { ok: true, data };
}

/* Webhook da Evolution: valida a presença da instância no payload e devolve
   um objeto normalizado. A validação de token/instância é feita pelo
   whatsappService (registro no core). */
async function receiveWebhook(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const event = String(body.event || body.type || 'unknown').toLowerCase().replace(/_/g, '.');
  const instanceName = body.instance || body.instanceName || (body.data && body.data.instanceName) || '';
  let connected;
  if (event === 'connection.update') {
    const state = body.data && (body.data.state || body.data.status);
    connected = state === 'open';
  }
  return {
    ok: true,
    event,
    instanceName: String(instanceName || '').trim(),
    connected: connected === undefined ? null : connected
  };
}

module.exports = {
  name: NAME,
  INSTANCE_STATUSES,
  DEFAULT_INSTANCE_NAME,
  ENDPOINTS,
  getSettings,
  isConfigured,
  sanitizeSettings,
  toInternationalPhone,
  testConnection,
  listInstances,
  createInstance,
  deleteInstance,
  connect,
  disconnect,
  logout,
  generateQRCode,
  sendText,
  sendImage,
  sendFile,
  setWebhook,
  getState,
  getStatus: getState,
  syncStatus,
  receiveWebhook
};
