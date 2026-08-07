#!/usr/bin/env node
/*
 * testWhatsappEvolutionLive.js
 *
 * Teste LIVE contra a Evolution API real (2.3.7). SOMENTE LEITURA: NÃO cria
 * instância, NÃO gera QR, NÃO envia mensagem, NÃO desconecta e NÃO exclui
 * NENHUMA instância. Executa apenas:
 *   1. GET /instance/fetchInstances              listar todas as instâncias;
 *   2. GET /instance/connectionState/{instance}  estado real de cada uma;
 *   3. leitura (readonly) do banco local papi_core.db → evolution_instances.
 *
 * Saída: tabela "nome da instância | estado remoto | existe no banco local
 * | status local" para todas as instâncias remotas + os nomes-alvo de tenant
 * + os registros locais órfãos.
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
  console.log(`[test-live] 1. fetchInstances OK — ${list.instances.length} instância(s) na Evolution.`);

  /* 2. Estado real de cada instância remota (connectionState, somente leitura). */
  const remoteState = new Map();
  for (const i of list.instances) {
    const state = await provider.getState(i.name, settings);
    remoteState.set(i.name, state.ok ? (state.status || i.status || 'desconhecido') : `erro HTTP ${state.status}`);
  }

  /* 3. Banco local (readonly): evolution_instances. */
  const path = require('path');
  const corePath = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'papi_core.db');
  const localByName = new Map();
  try {
    const Database = require('better-sqlite3');
    const core = new Database(corePath, { readonly: true });
    for (const row of core.prepare('SELECT instance_name, status, tenant_id FROM evolution_instances').all()) {
      localByName.set(row.instance_name, row);
    }
    core.close();
    console.log(`[test-live] 3. banco local lido (readonly): ${corePath} — ${localByName.size} registro(s) de instância.`);
  } catch (err) {
    console.log(`[test-live] 3. aviso: banco local não lido (${err.message}).`);
  }

  /* 4. Tabela: instâncias remotas + nomes-alvo + registros locais órfãos. */
  const TARGETS = ['tenant_0001_torque_detail', 'tenant_0002_iva_detalhes'];
  const allNames = [...new Set([...remoteState.keys(), ...TARGETS, ...localByName.keys()])].sort();

  console.log('');
  console.log('nome da instância | estado remoto | existe no banco local | status local');
  console.log('------------------ | -------------- | ---------------------- | ------------');
  for (const name of allNames) {
    const remoteExists = remoteState.has(name);
    const remote = remoteExists ? remoteState.get(name) : 'não existe na Evolution';
    const local = localByName.get(name);
    const localYes = local ? 'sim' : 'não';
    const localStatus = local ? local.status : '—';
    console.log(`${name} | ${remote} | ${localYes} | ${localStatus}`);
  }
  console.log('');

  /* 5. Confirmação dos nomes-alvo (objetivo do comando). */
  const targetChecks = [];
  for (const name of TARGETS) {
    const remoteExists = remoteState.has(name);
    const local = localByName.get(name);
    targetChecks.push(
      `${name}: ${remoteExists ? 'EXISTE na Evolution' : 'NÃO existe na Evolution'}` +
      ` — ${local ? `no banco local (status ${local.status})` : 'sem registro no banco local'}`
    );
  }
  console.log('[test-live] 2. ' + targetChecks.join(' | '));

  console.log(
    '[test-live] SUCESSO. Nenhuma instância criada, nenhum QR, nenhuma mensagem enviada, nenhum logout/exclusão — somente leitura.'
  );
  await shutdown(0);
})().catch(async (err) => {
  fail(String((err && err.message) || err).slice(0, 500));
  await shutdown(1);
});
