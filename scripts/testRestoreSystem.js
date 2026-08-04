/*
 * testRestoreSystem.js
 *
 * Testes da restauração automática de backup por empresa (Fase 2 do PapiCore).
 *
 * Roda em um DATA_DIR temporário (não toca os dados reais de desenvolvimento):
 *   node scripts/testRestoreSystem.js
 *
 * Saída: "N testes passaram" / "FALHOU" com detalhe da primeira falha.
 * Código de saída: 0 (ok) ou 1 (falha).
 *
 * Cenários cobertos:
 *   - restauração bem-sucedida (dados + assets voltam, manutenção desligada);
 *   - backup de segurança TENANT_PRE_RESTORE criado e removido ao final;
 *   - manutenção (503) ativa durante a restauração;
 *   - rejeição de backups de outra empresa, DELETED, arquivo ausente;
 *   - travas (restauração simultânea, backup em andamento);
 *   - ZIP adulterado: hash do banco, arquivo inesperado, path traversal,
 *     manifest ausente, manifest de outra empresa;
 *   - rollback automático (falha pós-troca) e rollback falho (manutenção mantida);
 *   - histórico listRestores/getRestore.
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const TEST_DIR = process.env.TEST_DATA_DIR
  ? path.resolve(process.env.TEST_DATA_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'papicore-restore-test-'));
process.env.DATA_DIR = TEST_DIR;
process.env.NODE_ENV = 'development';
process.env.BACKUP_LOCAL_MAX_PER_TENANT = '50';

const core = require('../database/coreDatabase');
const { createTenantDatabase, tenantFilePath } = require('../database/tenantDatabase');
const { ASSETS_DIR } = require('../utils/assetStorage');
const backupService = require('../services/backupService');
const restoreService = require('../services/restoreService');

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

/* ---------- Leitores/escrevedores ZIP mínimos (sem dependência externa) ---------- */

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

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralStart = offset;
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function readZipEntries(zipBuf) {
  return readZip(zipBuf)
    .filter((e) => !e.name.endsWith('/'))
    .map((e) => ({ name: e.name, data: zipEntryData(zipBuf, e.name) }));
}

/* Sobrescreve o arquivo do backup com uma versão adulterada do ZIP. */
function overwriteWithTampered(backupId, mutate) {
  const { filePath } = backupService.resolveBackupFile(backupId);
  const zipBuf = fs.readFileSync(filePath);
  const entries = readZipEntries(zipBuf);
  const tampered = mutate(entries, zipBuf);
  fs.writeFileSync(filePath, buildZip(tampered));
  return filePath;
}

/* ---------- Setup ---------- */

let tenant1;

function ensureTenantDb(tenant) {
  createTenantDatabase(tenant.database_name, {});
}

function assetPath(tenantId, name) {
  const dir = path.join(ASSETS_DIR, 'tenant_' + String(tenantId).padStart(4, '0'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function writeAsset(tenantId, name, content) {
  fs.writeFileSync(assetPath(tenantId, name), content);
}

function readAsset(tenantId, name) {
  const p = assetPath(tenantId, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function setCompanyName(db, name) {
  db.prepare("UPDATE company_settings SET company_name = ? WHERE id = 1").run(name);
}

function getCompanyName() {
  const db = require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name);
  return db.prepare('SELECT company_name FROM company_settings WHERE id = 1').get().company_name;
}

async function makeBackup(tenantId, type, userId) {
  return backupService.createTenantBackup({ tenantId, backupType: type || 'TENANT_MANUAL', userId: userId || null });
}

/* ---------- Testes ---------- */

test('initCore cria core, tenant padrão e tabelas tenant_maintenance/restore_runs', () => {
  core.initCore();
  tenant1 = core.getTenantById(1);
  assert(tenant1 && tenant1.slug === 'torque-detail', 'tenant padrão torque-detail deve existir');
  ensureTenantDb(tenant1);
  const tables = core.getCoreDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert(tables.includes('tenant_maintenance'), 'tabela tenant_maintenance deve existir');
  assert(tables.includes('restore_runs'), 'tabela restore_runs deve existir');
});

test('manutenção por empresa liga/desliga e é refletida em isTenantInMaintenance', () => {
  core.setTenantMaintenance(tenant1.id, { active: true, reason: 'teste' });
  assert(core.isTenantInMaintenance(tenant1.id) === true, 'deve estar em manutenção');
  const st = restoreService.getMaintenanceStatus(tenant1.id);
  assert(Number(st.active) === 1 && st.reason === 'teste', 'status deve refletir o estado');
  core.setTenantMaintenance(tenant1.id, { active: false });
  assert(core.isTenantInMaintenance(tenant1.id) === false, 'deve sair de manutenção');
  const off = restoreService.getMaintenanceStatus(tenant1.id);
  assert(Number(off.active) === 0, 'status inativo deve ser 0');
});

test('restauração bem-sucedida devolve dados e assets, desliga manutenção e limpa o backup de segurança', async () => {
  setCompanyName(require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name), 'Empresa Original');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-A');
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');

  setCompanyName(require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name), 'Empresa FUTURA');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-B');
  writeAsset(tenant1.id, 'favicon.ico', 'ICONE-EXTRA');

  const run = await restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id, userId: null });

  assert(run.status === 'SUCCESS', `status deve ser SUCCESS (veio ${run.status})`);
  assert(run.backup_id === backup.id, 'deve referenciar o backup restaurado');
  assert(getCompanyName() === 'Empresa Original', 'company_name deve voltar ao estado do backup');
  assert(readAsset(tenant1.id, 'logo.png') === 'LOGO-A', 'logo deve voltar ao estado do backup');
  assert(readAsset(tenant1.id, 'favicon.ico') === null, 'asset criado depois do backup deve ser removido');
  assert(core.isTenantInMaintenance(tenant1.id) === false, 'manutenção deve estar desligada após o sucesso');

  const stored = core.getRestoreRun(run.id);
  assert(stored.pre_restore_backup_id, 'deve existir um backup de segurança pré-restauração');
  const pre = core.getBackupRun(stored.pre_restore_backup_id);
  assert(pre && pre.backup_type === 'TENANT_PRE_RESTORE', 'backup de segurança deve ser TENANT_PRE_RESTORE');
  assert(pre.status === 'DELETED', 'backup de segurança deve ser removido após o sucesso');
  assert(core.listRestoreRuns({ tenant_id: tenant1.id }).some((r) => r.id === run.id), 'histórico deve conter a execução');
});

test('durante a restauração a empresa fica em manutenção (503)', async () => {
  const db = require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name);
  setCompanyName(db, 'Estado B');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-B2');
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');

  let sawMaintenance = false;
  const orig = backupService.createTenantBackup;
  backupService.createTenantBackup = function (opts) {
    sawMaintenance = core.isTenantInMaintenance(tenant1.id);
    return orig.call(backupService, opts);
  };
  try {
    await restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id, userId: null });
  } finally {
    backupService.createTenantBackup = orig;
  }
  assert(sawMaintenance === true, 'durante a restauração a empresa deve estar em manutenção');
  assert(core.isTenantInMaintenance(tenant1.id) === false, 'manutenção deve ser desligada no fim');
});

test('backup de OUTRA empresa não pode ser restaurado (400)', async () => {
  const t2 = core.insertTenant({ name: 'Outra', slug: 'outra-teste', database_name: 'tenant_0901_outra_teste.db' });
  createTenantDatabase(t2.database_name, {});
  const b2 = await makeBackup(t2.id, 'TENANT_MANUAL');
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: b2.id, tenantId: tenant1.id }), 400, 'backup de outra empresa deve dar 400');
});

test('backup excluído e arquivo ausente não podem ser restaurados (404)', async () => {
  const db = require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name);
  setCompanyName(db, 'Para excluir');
  const b = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  const { filePath } = backupService.resolveBackupFile(b.id);
  const del = backupService.deleteBackup(b.id, null);
  assert(del.status === 'DELETED', 'deve marcar DELETED');
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: b.id, tenantId: tenant1.id }), 404, 'backup DELETED deve dar 404');

  const b2 = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  fs.unlinkSync(backupService.resolveBackupFile(b2.id).filePath);
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: b2.id, tenantId: tenant1.id }), 404, 'arquivo ausente deve dar 404');
});

test('trava impede restauração simultânea (409) e backup em andamento (409)', async () => {
  const b = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  const internal = restoreService._internal();
  internal.runningRestores.add(`tenant:${tenant1.id}`);
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: b.id, tenantId: tenant1.id }), 409, 'restauração em andamento deve dar 409');
  internal.runningRestores.delete(`tenant:${tenant1.id}`);

  const backupInternal = backupService._internal();
  backupInternal.runningBackups.add(`tenant:${tenant1.id}`);
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: b.id, tenantId: tenant1.id }), 409, 'backup em andamento deve dar 409');
  backupInternal.runningBackups.delete(`tenant:${tenant1.id}`);
  assert(!restoreService.isRestoring(tenant1.id), 'trava deve ser liberada');
});

test('ZIP adulterado: hash do banco divergente é rejeitado (400) e dados ficam intactos', async () => {
  setCompanyName(require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name), 'Hash Estado');
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  overwriteWithTampered(backup.id, (entries) => {
    const m = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
    m.database.sha256 = 'f'.repeat(64);
    entries.find((e) => e.name === 'manifest.json').data = Buffer.from(JSON.stringify(m));
    return entries;
  });
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id }), 400, 'hash divergente deve dar 400');
  assert(getCompanyName() === 'Hash Estado', 'dados originais não podem ser alterados');
});

test('ZIP adulterado: arquivo inesperado no ZIP é rejeitado (400)', async () => {
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  overwriteWithTampered(backup.id, (entries) => [...entries, { name: 'secret.txt', data: Buffer.from('x') }]);
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id }), 400, 'arquivo inesperado deve dar 400');
});

test('ZIP adulterado: path traversal no nome do entry é rejeitado (400)', async () => {
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  overwriteWithTampered(backup.id, (entries) => [...entries, { name: '../evil.txt', data: Buffer.from('x') }]);
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id }), 400, 'path traversal deve dar 400');
});

test('ZIP adulterado: manifest ausente e manifest de outra empresa são rejeitados (400)', async () => {
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  overwriteWithTampered(backup.id, (entries) => entries.filter((e) => e.name !== 'manifest.json'));
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id }), 400, 'sem manifest deve dar 400');

  const backup2 = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  overwriteWithTampered(backup2.id, (entries) => {
    const m = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
    m.tenant.id = 999999;
    entries.find((e) => e.name === 'manifest.json').data = Buffer.from(JSON.stringify(m));
    return entries;
  });
  await expectAppError(() => restoreService.restoreTenantBackup({ backupId: backup2.id, tenantId: tenant1.id }), 400, 'manifest de outra empresa deve dar 400');
});

test('listRestores e getRestore retornam histórico sanitizado', async () => {
  const all = restoreService.listRestores({ tenantId: tenant1.id });
  assert(Array.isArray(all) && all.length >= 1, 'deve existir histórico');
  const first = restoreService.getRestore(all[0].id);
  assert(first.id === all[0].id, 'getRestore deve retornar a execução');
  assert(first.tenant && first.tenant.id === tenant1.id, 'deve expor tenant resumido');
  await expectAppError(() => restoreService.getRestore('abc'), 400, 'id inválido deve dar 400');
  await expectAppError(() => restoreService.getRestore(crypto.randomUUID()), 404, 'id inexistente deve dar 404');
});

test('rollback automático em falha pós-troca: ROLLBACK_SUCCESS e estado pré-restauração de volta', async () => {
  setCompanyName(require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name), 'Estado X');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-X');
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');

  setCompanyName(require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name), 'Estado Y');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-Y');
  writeAsset(tenant1.id, 'favicon.ico', 'ICONE-Y');

  /* Falha a cópia dos assets para a pasta VIVA na primeira vez (instalação do
     backup escolhido); o rollback usa o backup de segurança e consegue. */
  const realCopy = fs.copyFileSync;
  let liveHits = 0;
  fs.copyFileSync = function (src, dest, ...rest) {
    if (typeof dest === 'string' && /assets[\\/]tenant_\d/.test(dest.replace(/\\/g, '/'))) {
      liveHits += 1;
      if (liveHits === 1) throw new Error('falha simulada ao copiar assets');
    }
    return realCopy.call(fs, src, dest, ...rest);
  };
  let run;
  try {
    run = await restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id, userId: null });
  } finally {
    fs.copyFileSync = realCopy;
  }

  assert(run.status === 'ROLLBACK_SUCCESS', `status deve ser ROLLBACK_SUCCESS (veio ${run.status})`);
  assert(run.rollback_status === 'success', 'rollback_status deve ser success');
  assert(getCompanyName() === 'Estado Y', 'rollback deve devolver o estado pré-restauração (Estado Y)');
  assert(readAsset(tenant1.id, 'logo.png') === 'LOGO-Y', 'assets devem voltar ao estado pré-restauração');
  assert(readAsset(tenant1.id, 'favicon.ico') === 'ICONE-Y', 'asset extra pré-restauração deve existir');
  assert(core.isTenantInMaintenance(tenant1.id) === false, 'manutenção deve ser desligada após rollback bem-sucedido');
  const pre = core.getBackupRun(run.pre_restore_backup_id);
  assert(pre && pre.status === 'DELETED', 'backup de segurança deve ser removido após rollback bem-sucedido');
});

test('rollback falho mantém a empresa em manutenção (ROLLBACK_FAILED)', async () => {
  setCompanyName(require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name), 'Estado C');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-C');
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  setCompanyName(require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name), 'Estado D');

  const realCopy = fs.copyFileSync;
  fs.copyFileSync = function (src, dest, ...rest) {
    if (typeof dest === 'string' && /assets[\\/]tenant_\d/.test(dest.replace(/\\/g, '/'))) {
      throw new Error('falha permanente ao copiar assets');
    }
    return realCopy.call(fs, src, dest, ...rest);
  };
  try {
    await expectAppError(() => restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id }), 500, 'rollback falho deve resultar em erro');
  } finally {
    fs.copyFileSync = realCopy;
  }

  const rows = core.listRestoreRuns({ tenant_id: tenant1.id });
  const last = rows[0];
  assert(last.status === 'ROLLBACK_FAILED', `última execução deve ser ROLLBACK_FAILED (veio ${last.status})`);
  assert(last.rollback_status === 'failed', 'rollback_status deve ser failed');
  assert(core.isTenantInMaintenance(tenant1.id) === true, 'empresa deve permanecer em manutenção após rollback falho');

  core.setTenantMaintenance(tenant1.id, { active: false });
});

test('nova tentativa a partir do mesmo backup funciona após limpar manutenção', async () => {
  const db = require('../database/tenantDatabase').openTenantDatabase(tenant1.database_name);
  setCompanyName(db, 'Estado Retry');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-RETRY');
  const backup = await makeBackup(tenant1.id, 'TENANT_MANUAL');
  setCompanyName(db, 'Estado Retry FUTURO');
  writeAsset(tenant1.id, 'logo.png', 'LOGO-FUTURO');

  const run = await restoreService.restoreTenantBackup({ backupId: backup.id, tenantId: tenant1.id, userId: null });
  assert(run.status === 'SUCCESS', 'nova tentativa deve ser SUCCESS');
  assert(getCompanyName() === 'Estado Retry', 'dados devem voltar ao estado do backup');
  assert(readAsset(tenant1.id, 'logo.png') === 'LOGO-RETRY', 'logo deve voltar ao estado do backup');
  assert(core.isTenantInMaintenance(tenant1.id) === false, 'manutenção desligada');
});

/* ---------- Execução ---------- */

(async () => {
  console.log(`[testRestoreSystem] DATA_DIR isolado: ${TEST_DIR}`);
  await run();
  console.log(`\n${tests.length - failures}/${tests.length} testes passaram.`);
  if (!process.env.KEEP_DATA_DIR) {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* keep for debugging */ }
  }
  process.exit(failures ? 1 : 0);
})();
