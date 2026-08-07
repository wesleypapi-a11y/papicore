#!/usr/bin/env node
'use strict';

/* Suíte de prontidão sem rede externa. O único socket aberto é um servidor
   HTTP efêmero em 127.0.0.1 que simula a Evolution API 2.3.7. */
const http = require('http');
const assert = require('assert');

process.env.WHATSAPP_ENABLED = 'false';
process.env.WHATSAPP_PROVIDER = 'mock';
process.env.WHATSAPP_REQUEST_TIMEOUT_MS = '100';

const provider = require('../services/whatsapp/providers/evolutionProvider');
const mock = require('../services/whatsapp/providers/mockProvider');

const seen = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, apikey: req.headers.apikey, body: raw ? JSON.parse(raw) : null });
    if (mode === 'timeout') return;
    if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Unauthorized apikey=secret"}'); }
    if (mode === '500') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('internal failure'); }
    res.setHeader('content-type', 'application/json');
    if (mode === 'objstatus') return res.end('[{"name":"tenant_0001","connectionStatus":{"state":"connecting","status":"connecting"}}]');
    if (mode === 'rawqr') return res.end('"data:image/png;base64,RAW_QR"');
    if (mode === 'pairing') return res.end('{"qrcode":{"code":"PAPIPAIR","session":"SESSION-1"}}');
    if (mode === 'stateclose') return res.end('{"instance":{"instanceName":"tenant_0001","state":"close"}}');
    if (req.url === '/instance/fetchInstances') return res.end('[{"name":"tenant_0001","connectionStatus":"open"}]');
    if (req.url === '/instance/create') return res.end('{"instance":{"instanceName":"tenant_0001","status":"close"}}');
    if (req.url.includes('/instance/connect/')) return res.end('{"qrcode":"data:image/png;base64,SAFE_QR"}');
    if (req.url.includes('/instance/connectionState/')) return res.end('{"instance":{"instanceName":"tenant_0001","state":"open"}}');
    if (req.url.includes('/message/sendText/')) return res.end('{"key":{"id":"msg-1"}}');
    return res.end('{"ok":true}');
  });
});

function listen() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
function close() {
  return new Promise((resolve) => server.close(resolve));
}

(async () => {
  await listen();
  const settings = { enabled: true, server_url: `http://127.0.0.1:${server.address().port}`, api_key: 'secret', timeout_ms: 100 };
  let passed = 0;
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`ok ${name}`); }
    catch (err) { failed += 1; console.error(`FALHA ${name}: ${err.message}`); process.exitCode = 1; }
  };

  await check('provider mock não usa rede', async () => {
    const before = seen.length;
    const out = await mock.sendText('tenant_a', '11999999999', 'teste');
    assert(out.simulated && seen.length === before);
  });
  await check('telefone BR normalizado', () => assert.equal(provider.toInternationalPhone('(12) 99999-9999'), '5512999999999'));
  await check('telefone inválido rejeitado', () => assert.equal(provider.toInternationalPhone('123'), ''));
  await check('listar usa GET e apikey (2.3.7)', async () => {
    const out = await provider.listInstances(settings); assert(out.ok);
    assert.deepEqual(seen.at(-1), { method: 'GET', url: '/instance/fetchInstances', apikey: 'secret', body: null });
    /* fetchInstances 2.3.7: usa "name" + "connectionStatus" (string). */
    assert.equal(out.instances[0].name, 'tenant_0001');
    assert.equal(out.instances[0].status, 'open');
  });
  await check('fetchInstances com connectionStatus objeto', async () => {
    seen.length = 0;
    const saved = mode; mode = 'objstatus';
    try {
      const out = await provider.testConnection(settings);
      assert(out.ok && out.instances[0].status === 'connecting');
    } finally { mode = saved; }
  });
  await check('criar usa body v2', async () => {
    await provider.createInstance('tenant_0001', settings);
    assert.equal(seen.at(-1).url, '/instance/create');
    assert.equal(seen.at(-1).body.instanceName, 'tenant_0001');
    assert.equal(seen.at(-1).body.integration, 'WHATSAPP-BAILEYS');
  });
  await check('QR base64 v2 (qrcode string)', async () => assert((await provider.generateQRCode('tenant_0001', settings)).qr.includes('SAFE_QR')));
  await check('QR raw string (estado connecting 2.3.7)', async () => {
    seen.length = 0;
    const saved = mode; mode = 'rawqr';
    try { assert((await provider.generateQRCode('tenant_0001', settings)).qr.includes('RAW_QR')); }
    finally { mode = saved; }
  });
  await check('QR pairing code (qrcode objeto)', async () => {
    seen.length = 0;
    const saved = mode; mode = 'pairing';
    try {
      const out = await provider.generateQRCode('tenant_0001', settings);
      assert(out.ok === true && out.qrType === 'pairing_code');
      assert.equal(out.qr, 'SESSION-1');
      assert.equal(out.pairingCode, 'SESSION-1');
    } finally { mode = saved; }
  });
  await check('status open via state (2.3.7)', async () => assert((await provider.getStatus('tenant_0001', settings)).connected));
  await check('status close quando só state', async () => {
    seen.length = 0;
    const saved = mode; mode = 'stateclose';
    try {
      const out = await provider.getState('tenant_0001', settings);
      assert(out.ok && out.status === 'close' && !out.connected);
    } finally { mode = saved; }
  });
  await check('envio de texto', async () => assert.equal((await provider.sendText('tenant_0001', '12999999999', 'oi', settings)).id, 'msg-1'));
  await check('webhook exige HTTPS', async () => assert((await provider.setWebhook('tenant_0001', { url: 'http://inseguro' }, settings)).error));
  await check('webhook v2 usa byEvents (2.3.7)', async () => {
    const out = await provider.setWebhook('tenant_0001', { url: 'https://papi.test/api/webhooks/whatsapp', byEvents: true }, settings);
    assert(out.ok && seen.at(-1).url === '/webhook/set/tenant_0001');
    const body = seen.at(-1).body.webhook;
    assert.equal(body.byEvents, true);
    assert.ok(!('webhookByEvents' in body), 'não deve enviar webhookByEvents na v2.3.7');
    assert.equal(body.enabled, true);
    assert.ok(Array.isArray(body.events) && body.events.length > 0);
  });
  await check('logout usa rota oficial', async () => {
    await provider.logout('tenant_0001', settings); assert.equal(seen.at(-1).url, '/instance/logout/tenant_0001');
  });
  await check('delete usa rota oficial', async () => {
    await provider.deleteInstance('tenant_0001', settings); assert.equal(seen.at(-1).url, '/instance/delete/tenant_0001');
  });
  await check('401 sanitizado', async () => {
    mode = '401'; const out = await provider.testConnection(settings); mode = 'ok';
    assert(out.error && !out.message.includes('secret'));
  });
  await check('500 texto tratado', async () => {
    mode = '500'; const out = await provider.testConnection(settings); mode = 'ok'; assert(out.error);
  });
  await check('timeout abortado', async () => {
    mode = 'timeout'; const out = await provider.testConnection(settings); mode = 'ok';
    assert(out.error && /tempo limite/i.test(out.message));
  });
  await check('nenhum host externo acessado', () => assert(seen.every((call) => call.url.startsWith('/'))));

  await close();
  console.log(`${passed}/${passed + failed} testes passaram; nenhuma chamada externa real foi realizada.`);
})().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  try { await close(); } catch {}
});
