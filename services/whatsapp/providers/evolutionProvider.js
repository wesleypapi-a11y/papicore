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
 * Endpoints Evolution usados (padrão da v2):
 *   POST   /instance/create/{instanceName}          criar instância
 *   POST   /instance/fetchInstances                 listar (teste de conexão)
 *   GET    /instance/connect/{instanceName}         obter QR (base64)
 *   GET    /instance/connectionState/{instanceName} estado da conexão
 *   DELETE /instance/disconnect/{instanceName}      desconectar
 *   POST   /message/sendText/{instanceName}         enviar mensagem
 *   POST   /message/sendMedia/{instanceName}        enviar imagem
 *   POST   /message/sendFile/{instanceName}         enviar arquivo
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

/* Evolution (e o WhatsApp em geral) usa número no formato internacional.
   Para números brasileiros sem DDI (10-11 dígitos) adiciona o 55. Números que
   já vêm com código de país (12+ dígitos) são mantidos como estão. */
function toInternationalPhone(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return '';
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function sanitizeSettings(settings) {
  return {
    enabled: Boolean(settings && settings.enabled),
    server_url: ((settings && settings.server_url) || '').trim(),
    api_key: ((settings && settings.api_key) || '').trim()
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
  const url = `${s.server_url.replace(/\/+$/, '')}${endpoint}`;
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

function extractErrorMessage(data, status) {
  return (data && (data.response && data.response.message || data.message)) || `HTTP ${status}`;
}

/* ---------- Ações remotas ---------- */

async function testConnection(settingsOverride) {
  const settings = sanitizeSettings(settingsOverride || getSettings());
  if (!settings.server_url || !settings.api_key) {
    return { error: true, message: 'Informe a URL e a API key antes de testar a conexão.' };
  }
  try {
    const { ok, status, data } = await apiFetch(settings, '/instance/fetchInstances', { method: 'POST' });
    if (!ok) {
      return { error: true, message: `Falha na conexão: ${extractErrorMessage(data, status)}` };
    }
    const instances = Array.isArray(data) ? data : (data && data.instances) || [];
    return {
      ok: true,
      instances: instances.map((i) => ({ name: i.instanceName || i.name || '', status: i.connectionState || i.status || 'unknown' }))
    };
  } catch (err) {
    return { error: true, message: `Falha de rede: ${err.message}` };
  }
}

async function createInstance(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, `/instance/create/${instanceName}`, {
    method: 'POST',
    body: { integration: 'WHATSAPP', qrcode: true }
  });
  if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
  return { ok: true, data };
}

async function deleteInstance(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, `/instance/delete/${instanceName}`, { method: 'DELETE' });
  if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
  return { ok: true };
}

async function generateQRCode(instanceName, settings) {
  const { ok, status, data } = await apiFetch(settings, `/instance/connect/${instanceName}`);
  if (!ok || !data || !data.base64) {
    return { error: true, status, message: extractErrorMessage(data, status) };
  }
  return { ok: true, qr: data.base64 };
}

/* connect = cria a instância (se preciso) e devolve o QR Code. */
async function connect(instanceName, settings) {
  const created = await createInstance(instanceName, settings);
  if (created.error) return { error: true, message: `Não foi possível criar a instância: ${created.message}` };
  return generateQRCode(instanceName, settings);
}

async function disconnect(instanceName, settings) {
  const { ok, status } = await apiFetch(settings, `/instance/disconnect/${instanceName}`, { method: 'DELETE' });
  return { ok, status };
}

async function getState(instanceName, settings) {
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
    const { ok, status, data } = await apiFetch(settings, `/message/sendText/${instanceName || DEFAULT_INSTANCE_NAME}`, {
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
    const { ok, status, data } = await apiFetch(settings, `/message/sendMedia/${instanceName || DEFAULT_INSTANCE_NAME}`, {
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
    const { ok, status, data } = await apiFetch(settings, `/message/sendFile/${instanceName || DEFAULT_INSTANCE_NAME}`, {
      method: 'POST',
      body: { number: phone, media: url, filename: filename || 'arquivo' }
    });
    if (!ok) return { error: true, status, message: extractErrorMessage(data, status) };
    return { ok: true, id: (data && (data.key && data.key.id)) || '' };
  } catch (err) {
    return { error: true, status: 0, message: err.message };
  }
}

/* Webhook da Evolution: valida a presença da instância no payload e devolve
   um objeto normalizado. A validação de token/instância é feita pelo
   whatsappService (registro no core). */
async function receiveWebhook(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const event = body.event || body.type || 'unknown';
  const instanceName = body.instance || (body.data && body.data.instanceName) || '';
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
  getSettings,
  isConfigured,
  sanitizeSettings,
  toInternationalPhone,
  testConnection,
  createInstance,
  deleteInstance,
  connect,
  disconnect,
  generateQRCode,
  sendText,
  sendImage,
  sendFile,
  getState,
  getStatus: getState,
  syncStatus,
  receiveWebhook
};
