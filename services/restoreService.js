/*
 * restoreService.js
 *
 * Restauração automática de backup por empresa (Fase 2 do PapiCore).
 *
 * Responsabilidades:
 *   - validar o ZIP do backup (parser ZIP próprio, sem dependência externa):
 *     manifest.json, hashes SHA-256, PRAGMA integrity_check, anti path
 *     traversal e anti "zip bomb";
 *   - criar um backup de segurança TENANT_PRE_RESTORE do estado ATUAL antes de
 *     qualquer alteração (base do rollback automático);
 *   - ativar o modo de manutenção da empresa (503 em rotas públicas e admin)
 *     durante toda a operação;
 *   - troca atômica do banco do tenant (fecha conexão cacheada, renomeia o
 *     arquivo atual de lado, instala o banco extraído e reabre aplicando as
 *     migrações do schema atual);
 *   - restaurar os assets de identidade visual;
 *   - registrar o histórico em restore_runs (status PENDING/RUNNING/SUCCESS/
 *     FAILED/ROLLBACK_RUNNING/ROLLBACK_SUCCESS/ROLLBACK_FAILED);
 *   - rollback automático a partir do backup pré-restauração em caso de falha;
 *   - limpeza do backup de segurança após sucesso (a retenção é pulada nele).
 *
 * O banco de dados da empresa é substituído por inteiro. Nenhum dado parcial
 * é gravado no arquivo vivo durante a extração: tudo é validado em cópia
 * temporária antes da troca.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { createInflateRaw } = require('zlib');

const { AppError } = require('../utils/helpers');
const {
  DATA_DIR,
  getTenantById,
  getTenantMaintenance,
  insertRestoreRun,
  updateRestoreRun,
  getRestoreRun,
  listRestoreRuns,
  setTenantMaintenance,
  logActivity
} = require('../database/coreDatabase');
const {
  openTenantDatabase,
  closeTenantDatabase,
  tenantFilePath
} = require('../database/tenantDatabase');
const { tenantAssetsDir, removeTenantAssets } = require('../utils/assetStorage');
const backupService = require('./backupService');

const RESTORE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TMP_ROOT = path.join(DATA_DIR, 'backups', 'tmp');

/* Trava por empresa: impede restaurações simultâneas do mesmo tenant. */
const runningRestores = new Set();

const STATUS_ACTIVE = ['PENDING', 'RUNNING', 'ROLLBACK_RUNNING'];

function config() {
  return {
    /* Guarda anti "zip bomb": um backup legítimo nunca chega perto disso. */
    maxZipBytes: (Number(process.env.RESTORE_MAX_ZIP_MB) || 512) * 1024 * 1024,
    maxUncompressedBytes: (Number(process.env.RESTORE_MAX_UNCOMPRESSED_MB) || 2048) * 1024 * 1024
  };
}

function safeLog(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[restoreService] Falha ao registrar log de auditoria:', err.message);
  }
}

function removeDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('[restoreService] Erro ao limpar temporários:', err.message);
  }
}

function isRestoring(tenantId) {
  return runningRestores.has(`tenant:${tenantId}`);
}

/* ---------- Modo de manutenção ---------- */

function getMaintenanceStatus(tenantId) {
  const row = getTenantMaintenance(Number(tenantId));
  if (!row) return { tenant_id: Number(tenantId), active: 0 };
  return row;
}

/* ---------- Leitor de ZIP mínimo e seguro ---------- */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return {
        entryCount: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16)
      };
    }
  }
  return null;
}

function parseCentralDirectory(buf, eocd) {
  const entries = [];
  let offset = eocd.cdOffset;
  for (let i = 0; i < eocd.entryCount; i++) {
    if (offset + 46 > buf.length) throw new Error('Diretório central do ZIP truncado.');
    if (buf.readUInt32LE(offset) !== CEN_SIG) throw new Error('Diretório central do ZIP inválido.');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function localDataOffset(buf, localOffset) {
  if (localOffset + 30 > buf.length) throw new Error('Header local do ZIP truncado.');
  if (buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error('Header local do ZIP inválido.');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  return localOffset + 30 + nameLen + extraLen;
}

/*
 * Normaliza o nome de um entry do ZIP e rejeita qualquer tentativa de
 * path traversal, caminho absoluto ou unidade de disco. É a primeira camada
 * de defesa da extração: nenhum nome cru do ZIP toca o sistema de arquivos.
 */
function normalizeZipName(name) {
  if (typeof name !== 'string' || name.includes('\0')) {
    throw new AppError(400, 'Nome de arquivo inválido dentro do backup.');
  }
  let n = name.split('\\').join('/');
  if (n.startsWith('/')) n = n.slice(1);
  const parts = n.split('/');
  if (parts.some((p) => p === '..') || parts[0] === '.' || /^[a-zA-Z]:/.test(parts[0])) {
    throw new AppError(400, 'Caminho inválido dentro do backup.');
  }
  return n;
}

/*
 * Extrai um entry para disco, validando o tamanho descompactado e calculando
 * o SHA-256 ao mesmo tempo (evita carregar o arquivo inteiro em memória).
 */
function extractEntryToFile(buf, entry, destPath) {
  return new Promise((resolve, reject) => {
    let dataStart;
    try {
      dataStart = localDataOffset(buf, entry.localOffset);
    } catch (err) {
      return reject(err);
    }
    const end = dataStart + entry.compressedSize;
    if (end > buf.length) return reject(new Error('ZIP truncado (dados de um entry incompletos).'));

    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(destPath);
    let written = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { out.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ sha256: hash.digest('hex'), size: written });
    };

    out.on('error', fail);

    if (entry.method === 0) {
      const chunk = buf.subarray(dataStart, end);
      hash.update(chunk);
      written = chunk.length;
      out.end(chunk, finish);
      return;
    }
    if (entry.method === 8) {
      const inflater = createInflateRaw();
      inflater.on('error', fail);
      inflater.on('data', (chunk) => {
        hash.update(chunk);
        written += chunk.length;
      });
      out.on('finish', () => {
        if (written !== entry.uncompressedSize) {
          return fail(new Error('Tamanho descompactado divergente do diretório do ZIP.'));
        }
        finish();
      });
      inflater.pipe(out);
      inflater.end(buf.subarray(dataStart, end));
      return;
    }
    fail(new Error('Método de compressão não suportado no backup.'));
  });
}

/* ---------- Validação do manifest ---------- */

function validateAssetNames(names) {
  for (const n of names) {
    if (
      typeof n !== 'string' || !n ||
      n.includes('/') || n.includes('\\') || n.includes('..') ||
      n.includes('\0') || /^[a-zA-Z]:/.test(n)
    ) {
      throw new AppError(400, `Nome de asset inválido no backup: ${String(n).slice(0, 60)}`);
    }
  }
}

function validateManifest(manifest, tenant) {
  if (!manifest || typeof manifest !== 'object') {
    throw new AppError(400, 'Backup sem manifest válido.');
  }
  if (manifest.version !== 1) {
    throw new AppError(400, 'Versão de backup não suportada.');
  }
  if (manifest.type !== 'tenant') {
    throw new AppError(400, 'Este backup não é de uma empresa.');
  }
  const t = manifest.tenant || {};
  if (Number(t.id) !== Number(tenant.id)) {
    throw new AppError(400, 'O backup não pertence a esta empresa.');
  }
  if (t.database_name !== tenant.database_name) {
    throw new AppError(400, 'O banco de dados do backup não corresponde a esta empresa.');
  }
  const db = manifest.database || {};
  if (typeof db.file !== 'string' || db.file !== `database/${tenant.database_name}`) {
    throw new AppError(400, 'Banco de dados ausente ou inválido no backup.');
  }
  if (typeof db.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(db.sha256)) {
    throw new AppError(400, 'Hash do banco de dados inválido no backup.');
  }
  const assets = manifest.assets || {};
  if (!Array.isArray(assets.files)) {
    throw new AppError(400, 'Lista de assets inválida no backup.');
  }
  for (const asset of assets.files) {
    if (!asset || typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
      throw new AppError(400, 'Hash de asset inválido no backup.');
    }
  }
  validateAssetNames(assets.files.map((a) => a.name));
  return { dbFile: db.file, dbSha256: db.sha256.toLowerCase(), assets: assets.files };
}

/* ---------- Extração + validação em cópia temporária ---------- */

/*
 * Lê o ZIP, valida estrutura/names, cruza com o manifest e extrai banco e
 * assets para o diretório temporário. Nada é gravado no tenant aqui.
 */
async function extractAndValidateBackup(zipPath, tenant, tmpRoot) {
  const { maxZipBytes, maxUncompressedBytes } = config();
  const buf = fs.readFileSync(zipPath);
  if (buf.length > maxZipBytes) {
    throw new AppError(400, 'Backup muito grande para restauração.');
  }
  const eocd = findEOCD(buf);
  if (!eocd) throw new AppError(400, 'Arquivo de backup inválido (ZIP não reconhecido).');
  const central = parseCentralDirectory(buf, eocd);

  const files = [];
  let totalUncompressed = 0;
  for (const e of central) {
    const name = normalizeZipName(e.name);
    if (name.endsWith('/')) continue; /* entrada de diretório */
    if (e.compressedSize === 0xffffffff || e.uncompressedSize === 0xffffffff) {
      throw new AppError(400, 'Formato ZIP64 não é suportado em backups.');
    }
    if (files.some((f) => f.name === name)) {
      throw new AppError(400, 'Arquivo duplicado dentro do backup.');
    }
    totalUncompressed += e.uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new AppError(400, 'Backup descompactado muito grande para restauração.');
    }
    files.push({ name, ...e });
  }

  const manifestEntry = files.find((f) => f.name === 'manifest.json');
  if (!manifestEntry) throw new AppError(400, 'Backup sem manifest.json.');

  let manifest;
  try {
    const mBuf = await extractEntryToFile(buf, manifestEntry, path.join(tmpRoot, '_manifest.tmp.json'));
    manifest = JSON.parse(fs.readFileSync(path.join(tmpRoot, '_manifest.tmp.json'), 'utf8'));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(400, 'manifest.json inválido ou ilegível no backup.');
  }
  const { dbFile, dbSha256, assets } = validateManifest(manifest, tenant);

  /* O conjunto de arquivos do ZIP deve bater EXATAMENTE com o manifest:
     qualquer entry inesperado rejeita o backup inteiro (anti-tamper). */
  const allowed = new Set(['manifest.json', dbFile, ...assets.map((a) => `assets/${a.name}`)]);
  for (const f of files) {
    if (!allowed.has(f.name)) {
      throw new AppError(400, `Arquivo inesperado dentro do backup: ${f.name.slice(0, 80)}`);
    }
  }
  for (const name of allowed) {
    if (name !== 'manifest.json' && !files.some((f) => f.name === name)) {
      throw new AppError(400, `Arquivo esperado ausente no backup: ${name}`);
    }
  }

  const databaseDir = path.join(tmpRoot, 'database');
  const assetsDir = path.join(tmpRoot, 'assets');
  fs.mkdirSync(databaseDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const dbEntry = files.find((f) => f.name === dbFile);
  const dbPath = path.join(databaseDir, tenant.database_name);
  const dbExtract = await extractEntryToFile(buf, dbEntry, dbPath);
  if (dbExtract.sha256 !== dbSha256) {
    throw new AppError(400, 'Integridade do banco de dados falhou (SHA-256 não confere).');
  }

  /* PRAGMA integrity_check na cópia extraída ANTES de tocar o arquivo vivo. */
  const integrity = integrityCheck(dbPath);
  if (integrity !== 'ok') {
    throw new AppError(400, `Integridade do banco do backup falhou (${String(integrity).slice(0, 120)}).`);
  }

  const assetSources = [];
  for (const asset of assets) {
    const srcPath = path.join(assetsDir, asset.name);
    const meta = await extractEntryToFile(buf, files.find((f) => f.name === `assets/${asset.name}`), srcPath);
    if (meta.sha256 !== String(asset.sha256 || '').toLowerCase()) {
      throw new AppError(400, `Integridade do asset "${asset.name}" falhou (SHA-256 não confere).`);
    }
    assetSources.push({ name: asset.name, srcPath });
  }

  return { dbPath, assetSources };
}

function integrityCheck(dbPath) {
  let tmp;
  try {
    tmp = new Database(dbPath, { readonly: true });
    const rows = tmp.prepare('PRAGMA integrity_check').all();
    if (!rows.length) return 'error';
    return rows.every((r) => String(r.integrity_check || '').toLowerCase() === 'ok')
      ? 'ok'
      : rows.map((r) => r.integrity_check).join('; ');
  } catch (err) {
    return `erro: ${String(err.message || '').slice(0, 200)}`;
  } finally {
    if (tmp) {
      try { tmp.close(); } catch { /* ignore */ }
    }
  }
}

/* ---------- Troca atômica do banco ---------- */

function removeWalShm(dbPath) {
  for (const suffix of ['-wal', '-shm']) {
    const p = dbPath + suffix;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

/*
 * Substitui o arquivo vivo do tenant pela cópia validada:
 *   1. fecha a conexão cacheada (WAL é checkpointado);
 *   2. move o arquivo atual de lado;
 *   3. renomeia a cópia validada para o caminho vivo;
 *   4. reabre aplicando upgradeSchema (migrações do schema atual);
 *   5. valida PRAGMA integrity_check no banco já instalado.
 *
 * Se qualquer passo falhar e a cópia de lado ainda existir, o arquivo original
 * é devolvido ao lugar. Se nem isso for possível, lança com
 * code = 'INSTALL_UNRECOVERABLE' para o chamador tentar o rollback completo.
 */
function swapAndInstall(databaseName, newFilePath, restoreId) {
  closeTenantDatabase(databaseName);
  const livePath = tenantFilePath(databaseName);
  const asidePath = path.join(path.dirname(livePath), `.${path.basename(livePath)}.restore_${restoreId}`);
  removeWalShm(livePath);

  let asideMoved = false;
  if (fs.existsSync(livePath)) {
    fs.renameSync(livePath, asidePath);
    asideMoved = true;
  }

  const recover = () => {
    if (asideMoved && fs.existsSync(asidePath)) {
      fs.renameSync(asidePath, livePath);
    }
  };

  try {
    fs.renameSync(newFilePath, livePath);
  } catch (err) {
    try { recover(); } catch { /* abaixo */ }
    if (fs.existsSync(asidePath)) {
      const wrapped = new Error(`Falha ao instalar o banco restaurado e recuperar o original: ${err.message}`);
      wrapped.code = 'INSTALL_UNRECOVERABLE';
      throw wrapped;
    }
    throw err;
  }

  try {
    const db = openTenantDatabase(databaseName); /* roda upgradeSchema */
    const rows = db.prepare('PRAGMA integrity_check').all();
    const ok = rows.length && rows.every((r) => String(r.integrity_check || '').toLowerCase() === 'ok');
    if (!ok) throw new Error('PRAGMA integrity_check falhou após a instalação.');
  } catch (err) {
    closeTenantDatabase(databaseName);
    removeWalShm(livePath);
    try { recover(); } catch { /* abaixo */ }
    if (fs.existsSync(asidePath)) {
      const wrapped = new Error(`Falha ao instalar o banco restaurado e recuperar o original: ${err.message}`);
      wrapped.code = 'INSTALL_UNRECOVERABLE';
      throw wrapped;
    }
    throw err;
  } finally {
    removeWalShm(asidePath);
    try { if (fs.existsSync(asidePath)) fs.unlinkSync(asidePath); } catch { /* ignore */ }
  }
}

/* ---------- Assets ---------- */

function installAssets(tenantId, assetSources) {
  removeTenantAssets(tenantId);
  if (!assetSources.length) return;
  const dir = tenantAssetsDir(tenantId);
  for (const { name, srcPath } of assetSources) {
    fs.copyFileSync(srcPath, path.join(dir, name));
  }
}

/* ---------- Aplicação de um ZIP de backup completo ---------- */

/*
 * Instala um resultado de extração validada no tenant: troca atômica do banco
 * e, em seguida, restaura os assets. Erros carregam a marcação _installed para
 * que o chamador decida se há algo a reverter (rollback).
 */
function installExtracted(tenant, extracted, restoreId) {
  try {
    swapAndInstall(tenant.database_name, extracted.dbPath, restoreId);
  } catch (installErr) {
    installErr._installed = false;
    throw installErr;
  }
  try {
    installAssets(tenant.id, extracted.assetSources);
  } catch (assetsErr) {
    assetsErr._installed = true;
    throw assetsErr;
  }
}

/* Extrai, valida e instala (usado no rollback e para um ZIP já pronto). */
async function applyBackupZip(zipPath, tenant, restoreId) {
  const tmpRoot = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(tmpRoot, { recursive: true });
  try {
    const extracted = await extractAndValidateBackup(zipPath, tenant, tmpRoot);
    installExtracted(tenant, extracted, restoreId);
  } finally {
    removeDir(tmpRoot);
  }
}

/* ---------- Restauração ---------- */

function publicRestoreRun(run) {
  if (!run) return null;
  const tenant = run.tenant_id ? getTenantById(run.tenant_id) : null;
  const started = Date.parse(run.started_at);
  const completed = run.completed_at ? Date.parse(run.completed_at) : null;
  const durationSeconds = started && completed && completed >= started
    ? Math.round((completed - started) / 1000)
    : null;
  return {
    ...run,
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
    duration_seconds: durationSeconds
  };
}

function listRestores({ tenantId } = {}) {
  const filters = {};
  if (tenantId) filters.tenant_id = Number(tenantId);
  return listRestoreRuns(filters).map(publicRestoreRun);
}

function getRestore(restoreId) {
  if (typeof restoreId !== 'string' || !RESTORE_ID_RE.test(restoreId)) {
    throw new AppError(400, 'Identificador de restauração inválido.');
  }
  const run = getRestoreRun(restoreId);
  if (!run) throw new AppError(404, 'Restauração não encontrada.');
  return publicRestoreRun(run);
}

/*
 * Fluxo completo: validação → lock → modo de manutenção → backup de segurança
 * TENANT_PRE_RESTORE → extração validada → troca atômica → assets → SUCCESS.
 * Em falha após a troca, tenta rollback automático a partir do backup
 * pré-restauração.
 */
async function restoreTenantBackup({ backupId, tenantId, userId }) {
  const { run, filePath } = backupService.resolveBackupFile(backupId);
  if (run.status !== 'SUCCESS') {
    throw new AppError(409, 'Este backup não está disponível para restauração.');
  }
  const tenant = getTenantById(Number(tenantId));
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  if (run.tenant_id !== tenant.id) {
    throw new AppError(400, 'Este backup pertence a outra empresa.');
  }

  const lockKey = `tenant:${tenant.id}`;
  if (runningRestores.has(lockKey)) {
    throw new AppError(409, 'Já existe uma restauração em andamento para esta empresa. Aguarde a conclusão.');
  }
  if (backupService.isRunning(tenant.id)) {
    throw new AppError(409, 'Há um backup em andamento. Aguarde a conclusão antes de restaurar.');
  }
  runningRestores.add(lockKey);

  const restoreId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let preBackupId = null;
  const tmpRoot = path.join(TMP_ROOT, crypto.randomUUID());
  let extracted = null;

  try {
    fs.mkdirSync(tmpRoot, { recursive: true });

    insertRestoreRun({
      id: restoreId,
      tenant_id: tenant.id,
      backup_id: run.id,
      status: 'RUNNING',
      started_at: startedAt,
      started_by_user_id: userId || null
    });
    safeLog(() => logActivity(userId, tenant.id, 'RESTORE_STARTED', `Restauração do backup ${run.filename || run.id} iniciada`));

    /* Valida o ZIP do backup escolhido ANTES de tocar qualquer estado da
       empresa: falha aqui grava FAILED e nada é alterado nem é criado backup
       de segurança desnecessário. */
    extracted = await extractAndValidateBackup(filePath, tenant, tmpRoot);

    /* Modo de manutenção: bloqueia rotas públicas e admin da empresa. */
    setTenantMaintenance(tenant.id, {
      active: true,
      reason: `Restauração de backup (${restoreId})`,
      started_by_user_id: userId || null
    });

    /* Backup de segurança do estado ATUAL (não passa pela retenção). */
    const preBackup = await backupService.createTenantBackup({
      tenantId: tenant.id,
      backupType: 'TENANT_PRE_RESTORE',
      userId,
      skipRetention: true,
      allowDuringRestore: true
    });
    preBackupId = preBackup.id;
    updateRestoreRun(restoreId, { pre_restore_backup_id: preBackupId });
    safeLog(() => logActivity(userId, tenant.id, 'RESTORE_PRE_BACKUP_SUCCESS', `Backup de segurança ${preBackupId} gerado antes da restauração`));

    /* Instala o backup escolhido (já extraído e validado): troca atômica do
       banco + restauração dos assets. */
    installExtracted(tenant, extracted, restoreId);

    updateRestoreRun(restoreId, {
      status: 'SUCCESS',
      completed_at: new Date().toISOString(),
      error_message: null
    });
    setTenantMaintenance(tenant.id, { active: false, started_by_user_id: userId || null });
    safeLog(() => logActivity(userId, tenant.id, 'RESTORE_SUCCESS', `Restauração ${restoreId} concluída a partir do backup ${run.filename || run.id}`));

    /* O backup de segurança cumpriu seu papel; remove o arquivo (mantém o
       registro para auditoria via backup_runs DELETED). */
    try {
      backupService.deleteBackup(preBackupId, userId);
    } catch (cleanupErr) {
      console.error('[restoreService] Não foi possível limpar o backup de segurança', preBackupId, cleanupErr.message);
    }

    return publicRestoreRun(getRestoreRun(restoreId));
  } catch (err) {
    const sanitized = String((err && err.message) || 'Erro desconhecido').slice(0, 500);
    const needRollback = Boolean(err && (err._installed || err.code === 'INSTALL_UNRECOVERABLE'));

    if (needRollback && preBackupId) {
      updateRestoreRun(restoreId, {
        status: 'ROLLBACK_RUNNING',
        rollback_status: 'running',
        error_message: sanitized
      });
      safeLog(() => logActivity(userId, tenant.id, 'RESTORE_ROLLBACK_STARTED', `Falha na restauração ${restoreId}; rollback a partir do backup de segurança`));
      try {
        const { filePath: preZipPath } = backupService.resolveBackupFile(preBackupId);
        await applyBackupZip(preZipPath, tenant, restoreId);
        updateRestoreRun(restoreId, {
          status: 'ROLLBACK_SUCCESS',
          rollback_status: 'success',
          completed_at: new Date().toISOString()
        });
        setTenantMaintenance(tenant.id, { active: false, started_by_user_id: userId || null });
        safeLog(() => logActivity(userId, tenant.id, 'RESTORE_ROLLBACK_SUCCESS', `Rollback concluído após falha da restauração ${restoreId}`));
        try {
          backupService.deleteBackup(preBackupId, userId);
        } catch (cleanupErr) {
          console.error('[restoreService] Não foi possível limpar o backup de segurança', preBackupId, cleanupErr.message);
        }
        return publicRestoreRun(getRestoreRun(restoreId));
      } catch (rbErr) {
        const rbMsg = String((rbErr && rbErr.message) || 'Erro desconhecido').slice(0, 500);
        updateRestoreRun(restoreId, {
          status: 'ROLLBACK_FAILED',
          rollback_status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: `${sanitized} | rollback: ${rbMsg}`
        });
        safeLog(() => logActivity(userId, tenant.id, 'RESTORE_ROLLBACK_FAILED', `Rollback falhou após restauração ${restoreId}: ${rbMsg}`));
        /* Mantém o modo de manutenção ativo: a empresa não pode servir dados
           de um estado possivelmente inconsistente. */
      }
    } else {
      updateRestoreRun(restoreId, {
        status: 'FAILED',
        error_message: sanitized,
        completed_at: new Date().toISOString()
      });
      setTenantMaintenance(tenant.id, { active: false, started_by_user_id: userId || null });
      safeLog(() => logActivity(userId, tenant.id, 'RESTORE_FAILED', `Restauração ${restoreId} falhou: ${sanitized}`));
    }

    if (err instanceof AppError) throw err;
    throw new AppError(500, 'Falha ao restaurar o backup da empresa.');
  } finally {
    removeDir(tmpRoot);
    runningRestores.delete(lockKey);
  }
}

/* ---------- Utilitários de teste / inspeção ---------- */

function _internal() {
  return {
    runningRestores,
    TMP_ROOT,
    findEOCD,
    parseCentralDirectory,
    normalizeZipName,
    STATUS_ACTIVE
  };
}

module.exports = {
  restoreTenantBackup,
  listRestores,
  getRestore,
  isRestoring,
  getMaintenanceStatus,
  _internal
};
