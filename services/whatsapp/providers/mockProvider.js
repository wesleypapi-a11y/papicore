/*
 * mockProvider.js
 *
 * Provider SIMULADO de WhatsApp do PapiCore. É o provider ativo por padrão
 * (WHATSAPP_PROVIDER=mock e/ou WHATSAPP_ENABLED != true).
 *
 * NUNCA faz chamada de rede, NUNCA grava QR real e NUNCA envia mensagem. Ele
 * existe para que toda a cadeia (controller → whatsappService → provider)
 * funcione de ponta a ponta em simulação: a outbox é processada, as mensagens
 * ficam com status SIMULATED e o registro de conexão é atualizado localmente.
 *
 * Interface comum (mesma do evolutionProvider):
 *   name, testConnection(), createInstance(), deleteInstance(), connect(),
 *   disconnect(), generateQRCode(), sendText(), sendImage(), sendFile(),
 *   getStatus(), syncStatus(), receiveWebhook().
 */

'use strict';

const { normalizePhone } = require('../../../utils/helpers');

const NAME = 'mock';

/* Estado por instância (em memória — basta para a simulação). */
const states = new Map();

function stateOf(instanceName) {
  const key = String(instanceName || 'mock').trim() || 'mock';
  if (!states.has(key)) states.set(key, { status: 'disconnected', created_at: null });
  return states.get(key);
}

function isConfigured() {
  /* O MOCK está sempre disponível: não depende de servidor nem de chave. */
  return true;
}

async function testConnection() {
  return { ok: true, mock: true, instances: [{ name: 'mock', status: 'open' }] };
}

async function listInstances() {
  return { ok: true, mock: true, instances: Array.from(states.entries()).map(([name, value]) => ({ name, status: value.status })) };
}

async function createInstance(instanceName) {
  const s = stateOf(instanceName);
  s.status = 'disconnected';
  s.created_at = new Date().toISOString();
  return { ok: true, mock: true };
}

async function deleteInstance(instanceName) {
  const key = String(instanceName || 'mock').trim() || 'mock';
  states.delete(key);
  return { ok: true, mock: true };
}

/* Conecta simulando a geração de um QR Code. */
async function connect(instanceName) {
  return generateQRCode(instanceName);
}

async function disconnect(instanceName) {
  const s = stateOf(instanceName);
  s.status = 'disconnected';
  return { ok: true, status: 'disconnected', mock: true };
}

async function logout(instanceName) {
  return disconnect(instanceName);
}

/* QR Code de simulação: imagem SVG determinística (data URL), exibível no
   painel mas não escaneável — deixa explícito que está em MODO SIMULAÇÃO. */
function mockQrDataUrl(instanceName) {
  const label = String(instanceName || 'MOCK').toUpperCase().replace(/[^A-Z0-9]/g, ' ');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">' +
    '<rect width="220" height="220" fill="#ffffff"/>' +
    '<rect x="10" y="10" width="60" height="60" fill="none" stroke="#111111" stroke-width="8"/>' +
    '<rect x="22" y="22" width="14" height="14" fill="#111111"/>' +
    '<rect x="40" y="22" width="14" height="14" fill="#111111"/>' +
    '<rect x="22" y="40" width="14" height="14" fill="#111111"/>' +
    '<rect x="150" y="10" width="60" height="60" fill="none" stroke="#111111" stroke-width="8"/>' +
    '<rect x="162" y="22" width="14" height="14" fill="#111111"/>' +
    '<rect x="180" y="22" width="14" height="14" fill="#111111"/>' +
    '<rect x="162" y="40" width="14" height="14" fill="#111111"/>' +
    '<rect x="10" y="150" width="60" height="60" fill="none" stroke="#111111" stroke-width="8"/>' +
    '<rect x="22" y="162" width="14" height="14" fill="#111111"/>' +
    '<rect x="40" y="162" width="14" height="14" fill="#111111"/>' +
    '<rect x="22" y="180" width="14" height="14" fill="#111111"/>' +
    '<rect x="90" y="90" width="14" height="14" fill="#111111"/>' +
    '<rect x="108" y="90" width="14" height="14" fill="#111111"/>' +
    '<rect x="126" y="90" width="14" height="14" fill="#111111"/>' +
    '<rect x="90" y="108" width="14" height="14" fill="#111111"/>' +
    '<rect x="126" y="108" width="14" height="14" fill="#111111"/>' +
    '<rect x="90" y="126" width="14" height="14" fill="#111111"/>' +
    '<rect x="108" y="126" width="14" height="14" fill="#111111"/>' +
    '<rect x="126" y="126" width="14" height="14" fill="#111111"/>' +
    '<rect x="162" y="150" width="14" height="14" fill="#111111"/>' +
    '<rect x="180" y="150" width="14" height="14" fill="#111111"/>' +
    '<rect x="162" y="168" width="14" height="14" fill="#111111"/>' +
    '<rect x="180" y="168" width="14" height="14" fill="#111111"/>' +
    '<text x="110" y="202" font-family="monospace" font-size="11" fill="#666666" text-anchor="middle">MODO SIMULAÇÃO</text>' +
    '<text x="110" y="216" font-family="monospace" font-size="9" fill="#999999" text-anchor="middle">' + label.slice(0, 30) + '</text>' +
    '</svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

async function generateQRCode(instanceName) {
  const s = stateOf(instanceName);
  s.status = 'connecting';
  s.qr = mockQrDataUrl(instanceName);
  return { ok: true, status: 'connecting', qr: s.qr, mock: true };
}

async function sendText(instanceName, to, text) {
  const phone = normalizePhone(to);
  if (!phone) return { error: true, message: 'Destinatário inválido.' };
  return { ok: true, simulated: true, id: `mock-${Date.now()}` };
}

async function sendImage(instanceName, to, { url, caption } = {}) {
  const phone = normalizePhone(to);
  if (!phone) return { error: true, message: 'Destinatário inválido.' };
  return { ok: true, simulated: true, id: `mock-${Date.now()}` };
}

async function sendFile(instanceName, to, { url, filename } = {}) {
  const phone = normalizePhone(to);
  if (!phone) return { error: true, message: 'Destinatário inválido.' };
  return { ok: true, simulated: true, id: `mock-${Date.now()}` };
}

async function setWebhook(instanceName, webhook) {
  const s = stateOf(instanceName);
  s.webhook = webhook || null;
  return { ok: true, mock: true };
}

async function getStatus(instanceName) {
  const s = stateOf(instanceName);
  return {
    connected: s.status === 'open',
    status: s.status,
    owner_number: s.owner_number || '',
    owner_name: s.owner_name || ''
  };
}

/* Sincroniza o estado simulado: um "scan" do QR leva de connecting → open. */
async function syncStatus(instanceName) {
  const s = stateOf(instanceName);
  if (s.status === 'connecting') s.status = 'open';
  return {
    connected: s.status === 'open',
    status: s.status,
    owner_number: s.owner_number || '',
    owner_name: s.owner_name || ''
  };
}

/* Webhook de simulação: aceita e normaliza qualquer evento sem validação de
   rede — usado para exercitar o fluxo do webhook sem servidor real. */
async function receiveWebhook(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const event = body.event || body.type || 'unknown';
  return {
    ok: true,
    event,
    instanceName: body.instance || '',
    connected: event === 'connection.update' ? (body.state === 'open') : undefined
  };
}

module.exports = {
  name: NAME,
  isConfigured,
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
  getStatus,
  syncStatus,
  receiveWebhook,
  mockQrDataUrl
};
