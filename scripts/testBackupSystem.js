/*
 * testBackupSystem.js
 *
 * Testes do sistema de backup local (Fase 1 do PapiCore).
 *
 * Roda em um DATA_DIR temporário (não toca os dados reais de desenvolvimento):
 *   node scripts/testBackupSystem.js
 *
 * Saída: "N testes passaram" / "FALHOU" com detalhe da primeira falha.
 * Código de saída: 0 (ok) ou 1 (falha).
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

/* Ambiente isolado ANTES de carregar qualquer módulo da plataforma.
   TEST_DATA_DIR reutiliza um diretório (simula persistência entre "deploys");
   KEEP_DATA_DIR=1 preserva o diretório ao final. */
const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-backup-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';
process.env.BACKUP_LOCAL_RETENTION_DAYS = '2';
process.env.BACKUP_LOCAL_MAX_PER_TENANT = '3';
process.env.BACKUP_MIN_FREE_SPACE_MB = '1';

const core = require('../database/coreDatabase');
const { createTenantDatabase, tenantFilePath } = require('../database/tenantDatabase');
const { ASSETS_DIR } = require('../utils/assetStorage');
const backupService = require('../services/backupService');
const { runAutomaticBackups, isEnabled } = require('../services/backupScheduler');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { AppError } = require('../utils/helpers');

/* ---------- Runner ---------- */

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
let failures = 0;

async function run() {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      failures += 1;
      console.error(`  FALHA ${t.name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : err}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function expectAppError(fn, status, msg) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof AppError, `${msg}: esperava AppError`);
    assert(err.status === status, `${msg}: esperava status ${status}, veio ${err.status}`);
    return;
  }
  throw new Error(`${msg}: não lançou erro`);
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* Leitor ZIP mínimo (sem dependência externa): lê o diretório central do ZIP
   e permite extrair um entry por nome. Suficiente para os testes. */
function readZip(buf) {
  const eocdPos = (() => {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error('EOCD do ZIP não encontrado');
  })();
  const count = buf.readUInt16LE(eocdPos + 10);
  let off = buf.readUInt32LE(eocdPos + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Header central do ZIP inválido');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipEntryNames(buf) {
  return readZip(buf).map((e) => e.name);
}

function zipEntryData(buf, entryName) {
  const entry = readZip(buf).find((e) => e.name === entryName);
  if (!entry) throw new Error(`Entry não encontrado no ZIP: ${entryName}`);
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('Header local do ZIP inválido');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Método de compressão do ZIP não suportado: ${entry.method}`);
}

/* ---------- Setup ---------- */

let tenant1; /* torque-detail criado pelo seedCore */

function ensureTenantDb(tenant) {
  createTenantDatabase(tenant.database_name, { skip_seed: true });
}

function writeAsset(tenantId, name, content) {
  const dir = path.join(ASSETS_DIR, 'tenant_' + String(tenantId).padStart(4, '0'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

async function makeBackup(tenantId, type, userId) {
  return backupService.createTenantBackup({ tenantId, backupType: type || 'TENANT_MANUAL', userId: userId || null });
}

/* ---------- Testes ---------- */

test('initCore cria core, tenant padrão e tabela backup_runs', () => {
  core.initCore();
  tenant1 = core.getTenantById(1);
  assert(tenant1 && tenant1.slug === 'torque-detail', 'tenant padrão torque-detail deve existir');
  const row = core.getCoreDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='backup_runs'").get();
  assert(row, 'tabela backup_runs deve existir');
});

test('backup manual gera registro SUCCESS com hash e caminho', async () => {
  ensureTenantDb(tenant1);
  writeAsset(tenant1.id, 'logo.png', 'fake-png-bytes');
  const run = await makeBackup(tenant1.id, 'TENANT_MANUAL', null);
  assert(run.status === 'SUCCESS', 'status deve ser SUCCESS');
  assert(/^[0-9a-f]{64}$/.test(run.sha256 || ''), 'sha256 deve ter 64 hex');
  assert(run.database_count === 1, 'database_count deve ser 1');
  assert(run.asset_file_count === 1, 'asset_file_count deve ser 1');
  assert(run.duration_seconds !== null, 'duration_seconds deve ser preenchido');
  assert(run.relative_path === undefined, 'relative_path não deve vazar para a API');
  assert(run.tenant && run.tenant.id === tenant1.id, 'deve expor tenant resumido');
});

test('ZIP existe em backups/tenants/tenant_0001 e caminho é seguro', () => {
  const run = backupService.listBackups({ tenantId: tenant1.id })[0];
  assert(run, 'deve existir um backup listado');
  const { filePath } = backupService.resolveBackupFile(run.id);
  const backupsRoot = backupService._internal().BACKUPS_ROOT;
  const rel = path.relative(backupsRoot, filePath);
  assert(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'arquivo deve estar dentro de backups/');
  assert(fs.existsSync(filePath), 'arquivo do backup deve existir no disco');
  assert(filePath.includes('tenant_0001'), 'deve estar na pasta do tenant');
});

test('conteúdo do ZIP: manifest.json + banco + assets', async () => {
  const run = backupService.listBackups({ tenantId: tenant1.id })[0];
  const { filePath } = backupService.resolveBackupFile(run.id);
  const names = zipEntryNames(fs.readFileSync(filePath));
  assert(names.includes('manifest.json'), 'deve conter manifest.json');
  assert(names.some((n) => n === tenant1.database_name || n.startsWith('database/')), 'deve conter o banco dentro de database/');
  assert(names.includes('assets/logo.png'), 'deve conter assets/logo.png');
});

test('manifest.json: versão, tenant e integridade "ok"', async () => {
  const run = backupService.listBackups({ tenantId: tenant1.id })[0];
  const { filePath } = backupService.resolveBackupFile(run.id);
  const manifest = JSON.parse(zipEntryData(fs.readFileSync(filePath), 'manifest.json').toString('utf8'));
  assert(manifest.version === 1, 'version deve ser 1');
  assert(manifest.type === 'tenant', 'type deve ser tenant');
  assert(manifest.tenant.id === tenant1.id, 'tenant.id deve bater');
  assert(manifest.database.integrity_check === 'ok', 'integrity_check deve ser "ok"');
  assert(manifest.database.sha256 && manifest.database.sha256.length === 64, 'hash do banco no manifest');
  assert(manifest.assets.count === 1, 'assets.count deve ser 1');
});

test('hash SHA-256 do registro bate com o arquivo ZIP', () => {
  const run = backupService.listBackups({ tenantId: tenant1.id })[0];
  const { filePath } = backupService.resolveBackupFile(run.id);
  assert(run.sha256 === sha256Of(filePath), 'sha256 do registro deve ser o hash do arquivo');
});

test('banco dentro do ZIP passa no PRAGMA integrity_check', async () => {
  const run = backupService.listBackups({ tenantId: tenant1.id })[0];
  const { filePath } = backupService.resolveBackupFile(run.id);
  const zipBuf = fs.readFileSync(filePath);
  const entry = readZip(zipBuf).find((e) => /^database\/.*\.db$/.test(e.name));
  assert(entry, 'ZIP deve conter o banco em database/');
  const dbBuf = zipEntryData(zipBuf, entry.name);
  const dbPath = path.join(TEST_DIR, '_extracted.db');
  fs.writeFileSync(dbPath, dbBuf);
  const Database = require('better-sqlite3');
  const chk = new Database(dbPath, { readonly: true });
  const rows = chk.prepare('PRAGMA integrity_check').all();
  chk.close();
  assert(rows.every((r) => r.integrity_check === 'ok'), 'PRAGMA integrity_check do banco extraído deve ser "ok"');
});

test('getBackup, id inválido e arquivo inexistente', async () => {
  const run = backupService.listBackups({ tenantId: tenant1.id })[0];
  const got = backupService.getBackup(run.id);
  assert(got.id === run.id, 'getBackup deve retornar o registro');
  await expectAppError(() => backupService.getBackup('abc'), 400, 'id inválido deve dar 400');
  await expectAppError(() => backupService.getBackup(crypto.randomUUID()), 404, 'id inexistente deve dar 404');
});

test('proteção contra path traversal no resolveBackupPath', () => {
  const { resolveBackupPath } = backupService._internal();
  assert(resolveBackupPath('../../../windows/system32/evil.txt') === null, 'traversal absoluto deve ser bloqueado');
  assert(resolveBackupPath('..\\..\\..\\etc\\passwd') === null, 'traversal com barras invertidas deve ser bloqueado');
  assert(resolveBackupPath('/etc/passwd') === null, 'caminho absoluto deve ser bloqueado');
});

test('trava impede backup duplicado simultâneo (409)', async () => {
  const internal = backupService._internal();
  internal.runningBackups.add(`tenant:${tenant1.id}`);
  await expectAppError(() => makeBackup(tenant1.id, 'TENANT_MANUAL'), 409, 'backup em andamento deve dar 409');
  internal.runningBackups.delete(`tenant:${tenant1.id}`);
  assert(!backupService.isRunning(tenant1.id), 'trava deve ser liberada');
});

test('tipo de backup inválido é rejeitado (400)', async () => {
  await expectAppError(() => makeBackup(tenant1.id, 'SYSTEM_MANUAL'), 400, 'tipo não permitido deve dar 400');
});

test('tenant inexistente dá 404', async () => {
  await expectAppError(() => makeBackup(999999, 'TENANT_MANUAL'), 404, 'tenant inexistente deve dar 404');
});

test('falha de banco ausente grava registro FAILED e libera a trava', async () => {
  const t = core.insertTenant({ name: 'Sem Banco', slug: 'sem-banco-teste', database_name: 'tenant_0999_sem_banco_teste.db' });
  await expectAppError(() => makeBackup(t.id, 'TENANT_MANUAL'), 400, 'banco ausente deve dar 400');
  const rows = core.listBackupRuns({ tenant_id: t.id, status: 'FAILED' });
  assert(rows.length === 1, 'deve existir um registro FAILED');
  assert(!backupService.isRunning(t.id), 'trava deve ser liberada após falha');
});

test('retenção por quantidade e idade (BACKUP_LOCAL_MAX_PER_TENANT)', async () => {
  const total = backupService.listBackups({ tenantId: tenant1.id }).filter((r) => r.status === 'SUCCESS').length;
  assert(total <= 3, `deve manter no máximo 3 backups SUCCESS (tem ${total})`);
});

test('retrodata envelhecida é removida pela retenção', async () => {
  const db = core.getCoreDb();
  const old = db.prepare("UPDATE backup_runs SET completed_at = ? WHERE status = 'SUCCESS' AND tenant_id = ? ORDER BY completed_at ASC LIMIT 1").run(
    new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), tenant1.id
  );
  assert(old.changes === 1, 'deve existir registro para envelhecer');
  const removed = backupService.runTenantRetention(tenant1.id);
  assert(removed.length >= 1, 'retenção deve remover o backup antigo');
  const dbBackup = db.prepare("SELECT * FROM backup_runs WHERE status = 'SUCCESS' AND tenant_id = ?").all(tenant1.id);
  assert(dbBackup.every((r) => r.completed_at > new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()), 'não deve sobrar SUCCESS velho');
});

test('deleteBackup apaga arquivo e marca DELETED; download vira 404', async () => {
  const run = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  const { filePath } = backupService.resolveBackupFile(run.id);
  const del = backupService.deleteBackup(run.id, null);
  assert(del.status === 'DELETED', 'status deve virar DELETED');
  assert(!fs.existsSync(filePath), 'arquivo deve sumir do disco');
  await expectAppError(() => backupService.resolveBackupFile(run.id), 404, 'download de backup excluído deve dar 404');
});

test('backup pré-exclusão (TENANT_PRE_DELETE) funciona', async () => {
  const run = await makeBackup(tenant1.id, 'TENANT_PRE_DELETE');
  assert(run.status === 'SUCCESS', 'pré-exclusão deve gerar backup SUCCESS');
  assert(run.backup_type === 'TENANT_PRE_DELETE', 'tipo deve ser TENANT_PRE_DELETE');
});

test('órfãos (tenant excluído) viram tenant_id NULL e sobrevivem à retenção global por idade', async () => {
  const run = await makeBackup(tenant1.id, 'TENANT_PRE_DELETE');
  core.deleteTenantRecord(tenant1.id); /* ON DELETE SET NULL */
  const row = core.getBackupRun(run.id);
  assert(row.tenant_id === null, 'tenant_id deve virar NULL após exclusão do tenant');
  const before = core.listBackupRuns({ status: 'SUCCESS' }).filter((r) => r.tenant_id === null).length;
  assert(before >= 1, 'deve existir backup órfão');
  const removed = backupService.runGlobalRetention();
  assert(Array.isArray(removed), 'retenção global deve retornar lista');
});

test('rotina automática executa em qualquer ambiente (dev) e é desligada por padrão', async () => {
  assert(isEnabled() === false, 'isEnabled deve ser false fora de produção');
  const summary = await runAutomaticBackups();
  assert(typeof summary.ok === 'number' && typeof summary.failed === 'number', 'resumo deve ter ok/failed');
});

test('scheduler: cron ajustado temporariamente em ambiente de teste (parse de env)', () => {
  const sch = require('../services/backupScheduler')._internal();
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    BACKUP_LOCAL_ENABLED: process.env.BACKUP_LOCAL_ENABLED,
    BACKUP_LOCAL_SCHEDULE: process.env.BACKUP_LOCAL_SCHEDULE,
    BACKUP_TIMEZONE: process.env.BACKUP_TIMEZONE,
    BACKUP_RUN_ON_START: process.env.BACKUP_RUN_ON_START
  };
  try {
    process.env.NODE_ENV = 'production';
    process.env.BACKUP_LOCAL_ENABLED = 'true';
    process.env.BACKUP_LOCAL_SCHEDULE = '*/5 * * * *';
    process.env.BACKUP_TIMEZONE = 'America/Sao_Paulo';
    process.env.BACKUP_RUN_ON_START = 'false';
    assert(sch.isProduction() === true, 'deve reconhecer produção');
    assert(sch.isEnabled() === true, 'habilitado quando BACKUP_LOCAL_ENABLED=true');
    assert(sch.scheduleExpression() === '*/5 * * * *', 'cron temporário deve ser usado');
    assert(sch.timezone() === 'America/Sao_Paulo', 'timezone deve ser lida');
    assert(sch.shouldRunOnStart() === false, 'BACKUP_RUN_ON_START=false não roda no boot');
    const cron = require('node-cron');
    assert(cron.validate(sch.scheduleExpression()), 'expressão cron temporária deve ser válida');
    process.env.BACKUP_LOCAL_ENABLED = 'false';
    assert(sch.isEnabled() === false, 'desabilita quando BACKUP_LOCAL_ENABLED=false');
  } finally {
    Object.entries(prev).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
});

test('retenção nunca remove registro RUNNING', async () => {
  const t = core.insertTenant({ name: 'Runn', slug: 'runn-test', database_name: 'tenant_0998_runn_test.db' });
  const db = core.getCoreDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO backup_runs (id, tenant_id, backup_type, status, started_at) VALUES (?, ?, 'TENANT_MANUAL', 'RUNNING', ?)`
  ).run(id, t.id, new Date().toISOString());
  backupService.runTenantRetention(t.id);
  const row = core.getBackupRun(id);
  assert(row && row.status === 'RUNNING', 'RUNNING não pode ser removido pela retenção');
});

test('tenant sem assets gera backup SUCCESS com asset_file_count 0', async () => {
  const t = core.insertTenant({ name: 'Sem Assets', slug: 'sem-assets', database_name: 'tenant_0997_sem_assets.db' });
  createTenantDatabase(t.database_name, {});
  const run = await makeBackup(t.id, 'TENANT_MANUAL');
  assert(run.status === 'SUCCESS', 'backup sem assets deve ser SUCCESS');
  assert(run.asset_file_count === 0, 'asset_file_count deve ser 0');
  const { filePath } = backupService.resolveBackupFile(run.id);
  const names = zipEntryNames(fs.readFileSync(filePath));
  assert(!names.some((n) => n.startsWith('assets/') && n !== 'assets/'), 'não deve conter assets');
});

test('tenant com logo e favicon: ZIP contém os dois e hash bate', async () => {
  const t = core.insertTenant({ name: 'Com Assets', slug: 'com-assets', database_name: 'tenant_0996_com_assets.db' });
  createTenantDatabase(t.database_name, {});
  writeAsset(t.id, 'logo.png', 'logo-bytes');
  writeAsset(t.id, 'favicon.ico', 'fav-bytes');
  const run = await makeBackup(t.id, 'TENANT_MANUAL');
  assert(run.asset_file_count === 2, 'asset_file_count deve ser 2');
  const { filePath } = backupService.resolveBackupFile(run.id);
  const names = zipEntryNames(fs.readFileSync(filePath));
  assert(names.includes('assets/logo.png') && names.includes('assets/favicon.ico'), 'ZIP deve conter logo e favicon');
  assert(run.sha256 === sha256Of(filePath), 'hash do registro deve bater com o ZIP');
});

test('getStorageInfo: backups_size_bytes > 0 e nível é calculado', () => {
  const info = backupService.getStorageInfo();
  assert(typeof info.backups_size_bytes === 'number' && info.backups_size_bytes > 0, 'pasta backups deve ter tamanho > 0');
  if (info.disk) {
    assert(['ok', 'warning', 'critical'].includes(info.disk.level), 'nível deve ser ok/warning/critical');
    assert(info.disk.used_percent >= 0 && info.disk.used_percent <= 100, 'uso percentual válido');
    assert(info.disk.min_free_bytes > 0, 'margem mínima presente');
  }
});

test('restart (novo processo com mesmo DATA_DIR) não apaga backups', async () => {
  const childScript = `
    const path = require('path');
    process.env.DATA_DIR = process.argv[1];
    process.env.NODE_ENV = 'development';
    process.env.BACKUP_LOCAL_MAX_PER_TENANT = '50';
    const core = require(${JSON.stringify(path.resolve('database/coreDatabase.js'))});
    const { createTenantDatabase } = require(${JSON.stringify(path.resolve('database/tenantDatabase.js'))});
    const svc = require(${JSON.stringify(path.resolve('services/backupService.js'))});
    core.initCore();
    const t = core.getTenantById(1);
    createTenantDatabase(t.database_name, {});
    svc.createTenantBackup({ tenantId: t.id, backupType: 'TENANT_MANUAL', userId: null })
      .then((run) => { console.log('BACKUP=' + run.id); process.exit(0); })
      .catch((e) => { console.error(e); process.exit(1); });
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-persist-'));
  try {
    const first = await execFileAsync(process.execPath, ['-e', childScript, dir]);
    const id1 = first.stdout.match(/BACKUP=([0-9a-f-]+)/)[1];
    /* Segundo "deploy": novo processo, mesmo DATA_DIR. */
    const second = await execFileAsync(process.execPath, ['-e', childScript, dir]);
    const id2 = second.stdout.match(/BACKUP=([0-9a-f-]+)/)[1];
    assert(id1 !== id2, 'dois backups distintos entre "deploys"');
    const backupsDir = path.join(dir, 'backups', 'tenants');
    const zips = (() => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.zip')) out.push(p); } }; walk(backupsDir); return out; })();
    assert(zips.length >= 2, 'os ZIPs dos dois deploys devem persistir em DATA_DIR/backups');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testBackupSystem] DATA_DIR isolado: ${TEST_DIR}`);
  await run();
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  }
  process.exit(failures ? 1 : 0);
})();
