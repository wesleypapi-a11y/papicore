#!/usr/bin/env node
/*
 * testWhatsappEvolutionLive.js
 *
 * Teste LIVE contra a Evolution API real (2.3.7). NÃO envia mensagem, NÃO
 * desconecta e NÃO exclui NENHUMA instância — apenas lê:
 *   1. GET /instance/fetchInstances            (conectividade + apikey)
 *   2. GET /instance/connectionState/{instance}(estado da papicore_support)
 *
 * Só executa com ALLOW_LIVE_EVOLUTION_TEST=true (proteção contra chamadas
 * acidentais em testes/CI). A API key nunca é impressa; o provider já
 * substitui a chave nas mensagens de erro ([REDACTED]).
 */

'use strict';

require('dotenv').config();

const liveAllowed = String(process.env.ALLOW_LIVE_EVOLUTION_TEST || '').trim().toLowerCase() === 'true';
if (!liveAllowed) {
  console.error(
    '[test-live] ABORTADO: defina ALLOW_LIVE_EVOLUTION_TEST=true para executar o teste live. Nenhuma chamada externa foi feita.'
  );
  process.exit(1);
}

const provider = require('../services/whatsapp/providers/evolutionProvider');

function fail(message) {
  console.error(`[test-live] FALHA: ${message}`);
}

/* Encerramento limpo no Windows.
   O fetch nativo (undici) mantém sockets keep-alive abertos; um
   process.exit() abrupto com handle em fechamento dispara o assertion
   "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" no libuv.
   Estratégia: fecha o dispatcher global (se alcançável), destrói os sockets
   clientes remanescentes e aguarda o loop drenar antes de sair. */
function isClientSocket(handle) {
  const kind = handle && handle._handle && handle._handle.constructor && handle._handle.constructor.name;
  return Boolean(
    handle &&
    typeof handle.destroy === 'function' &&
    handle.constructor &&
    /Socket|TCP/.test(handle.constructor.name) &&
    !handle.listening &&
    kind === 'TCP'
  );
}

function drainSockets(maxMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      const remaining = process._getActiveHandles().filter(isClientSocket);
      if (remaining.length === 0 || Date.now() > deadline) return resolve();
      setTimeout(check, 25);
    };
    check();
  });
}

async function closeUndiciDispatcher() {
  try {
    let dispatcher = null;
    try {
      const undici = require('undici');
      dispatcher = undici && typeof undici.getGlobalDispatcher === 'function' ? undici.getGlobalDispatcher() : null;
    } catch { /* Node sem undici exposto como módulo */ }
    if (!dispatcher) {
      try { dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')]; } catch { /* ignore */ }
    }
    if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
  } catch { /* encerramento é best-effort */ }
}

async function shutdown(code) {
  await closeUndiciDispatcher();
  for (const h of process._getActiveHandles()) {
    if (isClientSocket(h)) {
      try { h.destroy(); } catch { /* ignore */ }
    }
  }
  await drainSockets(3000);
  process.exit(code);
}

(async () => {
  const url = String(process.env.WHATSAPP_API_URL || process.env.EVOLUTION_SERVER_URL || '').trim().replace(/\/+$/, '');
  const key = String(process.env.WHATSAPP_API_KEY || process.env.EVOLUTION_API_KEY || '').trim();
  if (!url) { fail('WHATSAPP_API_URL (ou EVOLUTION_SERVER_URL) não configurada.'); return shutdown(1); }
  if (!key) { fail('WHATSAPP_API_KEY (ou EVOLUTION_API_KEY) não configurada.'); return shutdown(1); }

  const settings = {
    enabled: true,
    server_url: url,
    api_key: key,
    timeout_ms: Number(process.env.WHATSAPP_REQUEST_TIMEOUT_MS) || 10000
  };

  /* 1. Conectividade + apikey válida (fetchInstances). */
  const list = await provider.listInstances(settings);
  if (list.error) { fail(list.message); return shutdown(1); }
  if (!Array.isArray(list.instances)) { fail('fetchInstances não retornou uma lista.'); return shutdown(1); }
  console.log(`[test-live] 1. fetchInstances OK — ${list.instances.length} instância(s) na Evolution (papicore_support incluída).`);

  /* 2. Localiza a instância central de suporte. */
  const support = list.instances.find((i) => i.name === 'papicore_support');
  if (!support) { fail('instância papicore_support não encontrada na Evolution.'); return shutdown(1); }
  console.log(`[test-live] 2. papicore_support encontrada — status remoto: ${support.status}`);

  /* 3. connectionState da papicore_support (somente leitura). */
  const state = await provider.getState('papicore_support', settings);
  if (!state.ok) { fail(`connectionState(papicore_support) falhou: ${state.status || 'erro'}`); return shutdown(1); }
  console.log(`[test-live] 3. connectionState(papicore_support) OK — estado: ${state.status}${state.owner_number ? `, número: ${state.owner_number}` : ''}`);

  console.log(
    '[test-live] SUCESSO. Nenhuma instância excluída, nenhum logout executado, nenhuma mensagem enviada.'
  );
  await shutdown(0);
})().catch(async (err) => {
  fail(String((err && err.message) || err).slice(0, 500));
  await shutdown(1);
});
