/*
 * testBackupsTab.js
 *
 * Testa a lógica da aba "Backups e Recuperação" do painel do desenvolvedor
 * (public/js/desenvolvedor.js) com um DOM mínimo e a função api() mockada.
 * Não toca em dados reais nem sobe servidor.
 *
 * Uso: node scripts/testBackupsTab.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'desenvolvedor.js'), 'utf8');

function extractFunction(name) {
  const prefix = name === 'backups' ? 'async function ' : 'function ';
  const re = new RegExp('^  (' + prefix + name + '\\([^)]*\\)\\{.*)$', 'm');
  const m = SRC.match(re);
  if (!m) throw new Error('função ' + name + ' não encontrada em desenvolvedor.js');
  return m[1];
}

let failures = 0;
let tests = 0;
function ok(cond, label) {
  tests++;
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures++;
    console.log('  FAIL ' + label);
  }
}

/* ---------- DOM mínimo ---------- */

function makeEl() {
  const el = {
    tag: 'div',
    value: '',
    _html: '',
    textContent: '',
    disabled: false,
    type: 'text',
    options: [],
    _classes: new Set(),
    classList: {
      add(c) { el._classes.add(c); },
      remove(c) { el._classes.delete(c); },
      toggle(c, f) { if (f === undefined) f = !el._classes.has(c); f ? el._classes.add(c) : el._classes.delete(c); },
      contains(c) { return el._classes.has(c); }
    },
    onclick: null,
    onchange: null,
    oninput: null,
    onsubmit: null,
    addEventListener() {},
    dispatch(type) {
      const ev = { target: el, preventDefault() {} };
      if (el['on' + type]) return el['on' + type](ev);
      return undefined;
    },
    close() { el._closed = true; },
    showModal() { el._open = true; },
    querySelector() { return makeEl(); },
    closest() { return null; },
    setAttribute() {},
    getAttribute() { return null; }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = v;
      el.options = [];
      const re = /<option value="([^"]*)"([^>]*)>([\s\S]*?)<\/option>/g;
      let m;
      while ((m = re.exec(v))) {
        el.options.push({ value: m[1], text: m[3].replace(/<[^>]+>/g, '').trim() });
      }
    }
  });
  return el;
}

function makeDocument() {
  const els = {};
  function $(sel) {
    if (!els[sel]) els[sel] = makeEl();
    return els[sel];
  }
  return { $, els };
}

/* ---------- helpers reais replicados ---------- */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="empty">Nenhum registro encontrado.</td></tr>`}</tbody></table></div>`;
}
function iconBtn(icon, cls, action, id, label) {
  return `<button data-action="${action}" data-id="${id}">${label}</button>`;
}
function formatBytes(b) { return String(b); }
function formatDuration(s) { return s ? String(s) + 's' : '—'; }
function backupTypeLabel(t) { return t; }
function backupStatusBadge(s) { return s; }
function restoreStatusBadge(s) { return s; }

/* ---------- estado e mock de api ---------- */

function buildSandbox() {
  const doc = makeDocument();
  const toasts = [];
  const calls = [];
  const state = { token: 't', user: null, view: 'backups', tenants: [], plans: [], backups: undefined, restores: [] };
  const shared = { tenantsResponse: [], backupsResponse: [], restoresResponse: [], storageResponse: { disk: null, backups_size_bytes: 0 }, failKeys: [] };
  let formData = {};

  const handlers = {
    'GET /api/developer/tenants': () => shared.tenantsResponse,
    'GET /api/developer/backups': () => shared.backupsResponse,
    'GET /api/developer/restores': () => shared.restoresResponse,
    'GET /api/developer/backups/storage': () => shared.storageResponse,
    'POST /api/developer/tenants/1/backup': () => ({ id: 'bk-1', status: 'SUCCESS' })
  };

  async function api(url, opt = {}) {
    const key = (opt.method || 'GET') + ' ' + url;
    calls.push(key);
    if (shared.failKeys.includes(key)) throw new Error('erro servidor simulado');
    if (!handlers[key]) throw new Error('endpoint inesperado: ' + key);
    return handlers[key]();
  }

  const sandbox = {
    console,
    state,
    $: doc.$,
    api,
    esc,
    table,
    iconBtn,
    formatBytes,
    formatDuration,
    backupTypeLabel,
    backupStatusBadge,
    restoreStatusBadge,
    renderStorageAlert(box) { box.innerHTML = 'STORAGE_OK'; },
    fetchDownload() {},
    backupAction() {},
    restoreAction() {},
    openRestoreConfirm() {},
    openModal() {},
    toast(msg) { toasts.push(msg); },
    confirm() { return false; },
    FormData: class {
      constructor() { this._d = formData; }
      [Symbol.iterator]() { return Object.entries(this._d)[Symbol.iterator](); }
    }
  };
  return { sandbox, doc, toasts, calls, state, shared, getFormData: () => formData, setFormData: (o) => { formData = o; } };
}

function loadBackups(sandbox) {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(extractFunction('eligibleTenants'), ctx);
  vm.runInContext(extractFunction('backupTenantLabel'), ctx);
  vm.runInContext(extractFunction('backups'), ctx);
  return ctx;
}

function tenant(id, name, status) {
  return { id, name, slug: name.toLowerCase().replace(/\s+/g, '-'), status };
}

function backupRun(id, t, extra = {}) {
  return Object.assign({
    id,
    tenant_id: t ? t.id : null,
    tenant: t ? { id: t.id, name: t.name, slug: t.slug } : null,
    backup_type: 'TENANT_MANUAL',
    status: 'SUCCESS',
    started_at: '2026-08-04T03:00:00.000Z',
    size_bytes: 1024,
    asset_file_count: 2,
    sha256: 'abc123',
    duration_seconds: 5
  }, extra);
}

async function tick() { await new Promise(r => setTimeout(r, 20)); }

async function main() {
  const t1 = tenant(1, 'Torque Detail', 'ACTIVE');
  const t2 = tenant(5, 'Iva Detalhes', 'ACTIVE');
  const tSus = tenant(7, 'Zap Suspensa', 'SUSPENDED');
  const tArch = tenant(9, 'Arquivada', 'ARCHIVED');

  /* 1. uma empresa cadastrada e nenhum backup */
  {
    const { sandbox, doc, toasts, state, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [];
    shared.restoresResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    const opts = doc.$('#bkTenant').options;
    ok(opts.length === 2, '1. dropdown tem "Todas as empresas" + 1 empresa');
    ok(opts.some(o => o.value === '1' && o.text === 'Torque Detail'), '1. Torque Detail listada');
    ok(doc.$('#backupsTable').innerHTML.includes('Nenhum backup encontrado.'), '1. estado vazio "Nenhum backup encontrado."');
    ok(toasts.length === 0, '1. nenhum toast de erro');
  }

  /* 2. uma empresa cadastrada com backup */
  {
    const { sandbox, doc, state, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [backupRun('b1', t1)];
    shared.restoresResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(doc.$('#backupsTable').innerHTML.includes('Torque Detail'), '2. linha de backup mostra a empresa');
  }

  /* 3. várias empresas, ordenadas alfabeticamente e sem duplicar */
  {
    const { sandbox, doc, shared } = buildSandbox();
    shared.tenantsResponse = [t1, t2, t1];
    shared.backupsResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    const texts = doc.$('#bkTenant').options.filter(o => o.value).map(o => o.text);
    ok(texts.join('|') === 'Iva Detalhes|Torque Detail', '3. opções únicas e ordenadas: ' + texts.join('|'));
  }

  /* 4. empresa suspensa aparece; arquivada não */
  {
    const { sandbox, doc, shared } = buildSandbox();
    shared.tenantsResponse = [t1, tSus, tArch];
    shared.backupsResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    const vals = doc.$('#bkTenant').options.map(o => o.value);
    ok(vals.includes('7'), '4. empresa SUSPENDED incluída');
    ok(!vals.includes('9'), '4. empresa ARCHIVED não incluída');
  }

  /* 5. tenant excluído com backup órfão (tenant_id null) */
  {
    const { sandbox, doc, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [backupRun('orphan', null, { filename: 'tenant_0001_torque_detail-backup-2026-08-04_03-00-00.zip' })];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(doc.$('#backupsTable').innerHTML.includes('torque_detail') && doc.$('#backupsTable').innerHTML.includes('empresa removida'), '5. órfão mostra slug do filename + "empresa removida"');
    ok(!doc.$('#bkTenant').options.some(o => o.text.includes('removida')), '5. órfão não entra no filtro');
  }

  /* 6 + 7. filtro Todas as empresas / por tenant (backups e restaurações) */
  {
    const { sandbox, doc, state, shared } = buildSandbox();
    shared.tenantsResponse = [t1, t2];
    shared.backupsResponse = [backupRun('b1', t1), backupRun('b2', t2)];
    shared.restoresResponse = [
      { id: 'r1', tenant: { id: 1, name: 'Torque Detail' }, status: 'SUCCESS', started_at: '2026-08-04T04:00:00.000Z' },
      { id: 'r2', tenant: { id: 5, name: 'Iva Detalhes' }, status: 'FAILED', started_at: '2026-08-04T05:00:00.000Z' }
    ];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(doc.$('#backupsTable').innerHTML.includes('Torque Detail') && doc.$('#backupsTable').innerHTML.includes('Iva Detalhes'), '6. "Todas as empresas" lista todos');
    doc.$('#bkTenant').value = '1';
    doc.$('#bkTenant').dispatch('change');
    ok(doc.$('#backupsTable').innerHTML.includes('Torque Detail') && !doc.$('#backupsTable').innerHTML.includes('Iva Detalhes'), '7. filtro por tenant filtra backups');
    ok(doc.$('#restoresTable').innerHTML.includes('Torque Detail') && !doc.$('#restoresTable').innerHTML.includes('Iva Detalhes'), '7. filtro por tenant filtra restaurações');
    ok(doc.$('#backupsTable').innerHTML.includes('Nenhum backup encontrado para esta empresa.') === false, '7. com backups, sem mensagem vazia');
  }

  /* 8. Novo backup sem seleção → modal; submeter vazio → mensagem */
  {
    const { sandbox, doc, toasts, shared, setFormData } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    doc.$('#newBackup').onclick();
    ok(doc.$('#modalBody').innerHTML.includes('Torque Detail'), '8. modal aberto com empresas para escolher');
    setFormData({ tenant_id: '' });
    await doc.$('#newBackupForm').onsubmit({ preventDefault() {}, submitter: makeEl() });
    ok(toasts.includes('Selecione uma empresa para gerar o backup.'), '8. mensagem "Selecione uma empresa para gerar o backup."');
  }

  /* 9. Novo backup com seleção → POST no tenant certo */
  {
    const { sandbox, doc, toasts, calls, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [backupRun('b1', t1)];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    doc.$('#bkTenant').value = '1';
    await doc.$('#newBackup').onclick();
    ok(calls.includes('POST /api/developer/tenants/1/backup'), '9. POST /api/developer/tenants/1/backup chamado');
    ok(calls.includes('POST /api/developer/tenants/1/backup') && !calls.some(c => c.includes('tenant//backup')), '9. nunca envia tenant_id vazio');
    ok(toasts.includes('Backup criado com sucesso.'), '9. toast de sucesso');
    ok(!doc.$('#backupsTable').innerHTML.includes('Nenhum backup'), '9. tabela atualizada após sucesso');
  }

  /* 10 + 11. recarregar aba preserva a seleção */
  {
    const { sandbox, doc, shared } = buildSandbox();
    shared.tenantsResponse = [t1, t2];
    shared.backupsResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    doc.$('#bkTenant').value = '5';
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(doc.$('#bkTenant').value === '5', '10/11. seleção preservada ao recarregar a aba');
  }

  /* 12 + 13. formato real da API (arrays) é usado corretamente */
  {
    const { sandbox, doc, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [backupRun('b1', t1)];
    shared.restoresResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(doc.$('#bkTenant').options.some(o => o.value === '1'), '12. lista de tenants (array) usada no filtro');
    ok(doc.$('#backupsTable').innerHTML.includes('Torque Detail'), '13. lista de backups (array) renderizada');
  }

  /* 14. erro ao carregar backups não afeta empresas */
  {
    const { sandbox, doc, toasts, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [backupRun('b1', t1)];
    shared.restoresResponse = [];
    shared.failKeys = ['GET /api/developer/backups'];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(toasts.includes('Não foi possível carregar os backups.'), '14. toast "Não foi possível carregar os backups."');
    ok(doc.$('#bkTenant').options.some(o => o.value === '1'), '14. empresas continuam no filtro');
  }

  /* 15. erro ao carregar storage não afeta empresas */
  {
    const { sandbox, doc, toasts, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [];
    shared.restoresResponse = [];
    shared.failKeys = ['GET /api/developer/backups/storage'];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(doc.$('#bkTenant').options.some(o => o.value === '1'), '15. empresas continuam no filtro');
    ok(!toasts.some(t => t.includes('empresas') || t.includes('backups')), '15. storage falhou sem derrubar os demais');
  }

  /* 16. erro ao carregar empresas → toast específico e aba não quebra */
  {
    const { sandbox, doc, toasts, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [];
    shared.restoresResponse = [];
    shared.failKeys = ['GET /api/developer/tenants'];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(toasts.includes('Não foi possível carregar as empresas.'), '16. toast "Não foi possível carregar as empresas."');
    ok(doc.$('#noTenantsNote').textContent.includes('Nenhuma empresa cadastrada.'), '16. nota "Nenhuma empresa cadastrada."');
  }

  /* 17. nenhum endpoint inesperado / 401/403/404 no fluxo feliz */
  {
    const { sandbox, calls, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [backupRun('b1', t1)];
    shared.restoresResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    const unexpected = calls.filter(c => !c.startsWith('GET /api/developer/tenants') && !c.startsWith('GET /api/developer/backups') && !c.startsWith('GET /api/developer/restores') && !c.startsWith('GET /api/developer/backups/storage'));
    ok(unexpected.length === 0, '17. só chamadas esperadas: ' + (unexpected.join(', ') || 'ok'));
  }

  /* 18. Torque Detail aparece no dropdown */
  {
    const { sandbox, doc, shared } = buildSandbox();
    shared.tenantsResponse = [t1];
    shared.backupsResponse = [];
    const ctx = loadBackups(sandbox);
    await vm.runInContext('backups()', ctx);
    await tick();
    ok(doc.$('#bkTenant').options.some(o => o.value === '1' && o.text === 'Torque Detail'), '18. Torque Detail aparece no dropdown');
  }

  console.log('');
  console.log(tests + ' checks executados, ' + failures + ' falhas.');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
