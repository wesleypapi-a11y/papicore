/*
 * backupService.js
 *
 * Serviço central de backup local por tenant (Fase 1 do PapiCore).
 *
 * Responsabilidades:
 *   - gerar backup completo por empresa (banco SQLite consistente + assets);
 *   - validar integridade (PRAGMA integrity_check) e gerar hash SHA-256;
 *   - compactar tudo em um único ZIP com manifest.json;
 *   - gravar o histórico em backup_runs (banco central);
 *   - download e exclusão de backups existentes;
 *   - retenção local (por quantidade e por idade);
 *   - limpeza de temporários (nunca apaga os dados originais do tenant).
 *
 * Estrutura no disco (sempre relativa a DATA_DIR):
 *   DATA_DIR/backups/tenants/tenant_XXXX/<arquivo>.zip
 *   DATA_DIR/backups/system/        (reservado para backups de sistema futuros)
 *   DATA_DIR/backups/tmp/<backup-id> (temporário, removido no finally)
 *
 * IMPORTANTE: este serviço NÃO executa restauração nem envia backups para
 * armazenamento externo (S3/R2) — ambos ficam para fases futuras.
 *
 * AVISO DE SEGURANÇA: o ZIP contém dados pessoais dos clientes (nomes,
 * telefones, CPFs, endereços, placas). Ele NÃO é criptografado nesta fase e
 * deve ser tratado como dado sensível: restringir acesso ao disco e mover
 * cópias para armazenamento externo.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { AppError } = require('../utils/helpers');
const {
  DATA_DIR,
  getTenantById,
  listDomains,
  insertBackupRun,
  updateBackupRun,
  getBackupRun,
  listBackupRuns,
  logActivity
} = require('../database/coreDatabase');
const { openTenantDatabase, tenantFilePath } = require('../database/tenantDatabase');
const { ASSETS_DIR } = require('../utils/assetStorage');

const BACKUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BACKUPS_ROOT = path.join(DATA_DIR, 'backups');
const TENANT_BACKUPS_ROOT = path.join(BACKUPS_ROOT, 'tenants');
const SYSTEM_BACKUPS_ROOT = path.join(BACKUPS_ROOT, 'system');
const TMP_ROOT = path.join(BACKUPS_ROOT, 'tmp');

/* Trava por empresa: impede dois backups do mesmo tenant simultaneamente
   (clique duplicado, rotina automática + manual ao mesmo tempo, etc.). */
const runningBackups = new Set();

/* ---------- Configuração (lida do ambiente a cada chamada) ---------- */

function config() {
  return {
    minFreeSpaceBytes: (Number(process.env.BACKUP_MIN_FREE_SPACE_MB) || 200) * 1024 * 1024,
    retentionDays: Number(process.env.BACKUP_LOCAL_RETENTION_DAYS) || 7,
    maxPerTenant: Number(process.env.BACKUP_LOCAL_MAX_PER_TENANT) || 10
  };
}

function safeLog(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[backupService] Falha ao registrar log de auditoria:', err.message);
  }
}

function tenantFolderName(tenantId) {
  if (!/^\d+$/.test(String(tenantId))) throw new AppError(400, 'Identificador de empresa inválido.');
  return 'tenant_' + String(tenantId).padStart(4, '0');
}

/* ---------- Diretórios ---------- */

function tenantBackupsDir(tenantId) {
  const dir = path.join(TENANT_BACKUPS_ROOT, tenantFolderName(tenantId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function systemBackupsDir() {
  fs.mkdirSync(SYSTEM_BACKUPS_ROOT, { recursive: true });
  return SYSTEM_BACKUPS_ROOT;
}

function removeDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('[backupService] Erro ao limpar temporários:', err.message);
  }
}

/* ---------- Validações ---------- */

function validateBackupId(backupId) {
  if (typeof backupId !== 'string' || !BACKUP_ID_RE.test(backupId)) {
    throw new AppError(400, 'Identificador de backup inválido.');
  }
  return backupId;
}

function validateTenantBackupType(backupType) {
  if (!['TENANT_MANUAL', 'TENANT_AUTOMATIC', 'TENANT_PRE_DELETE', 'TENANT_PRE_RESTORE'].includes(backupType)) {
    throw new AppError(400, 'Tipo de backup inválido.');
  }
  return backupType;
}

/*
 * Resolve o caminho absoluto de um backup a partir do relative_path salvo no
 * banco. Nunca aceita caminhos do frontend: o path vem do registro do banco e
 * é confirmado dentro de DATA_DIR/backups (bloqueia path traversal).
 */
function resolveBackupPath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  const normalized = relativePath.split('\\').join('/');
  if (path.posix.isAbsolute(normalized)) return null;
  const absolute = path.resolve(BACKUPS_ROOT, normalized);
  const root = path.resolve(BACKUPS_ROOT) + path.sep;
  if (!absolute.startsWith(root)) return null;
  return absolute;
}

/* ---------- Hash / integridade ---------- */

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/*
 * Abre a cópia temporária em modo somente-leitura e exige que o
 * PRAGMA integrity_check retorne "ok". Não toca o banco original do tenant.
 */
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

/* ---------- Espaço em disco ---------- */

function checkFreeSpace(dir, estimatedBytes) {
  const required = Math.max(estimatedBytes * 2, config().minFreeSpaceBytes);
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(dir);
      const available = Number(stats.bavail) * Number(stats.bsize);
      if (available < required) {
        const mb = Math.ceil((required - available) / (1024 * 1024));
        throw new AppError(
          507,
          `Espaço em disco insuficiente para o backup (faltam ~${mb} MB). Libere espaço ou reduza a pasta data/.`
        );
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    /* Sem API de espaço disponível: segue e deixa o ENOSPC ser tratado no VACUUM INTO. */
  }
  return required;
}

/* ---------- Espaço em disco / alertas ---------- */

/* Tamanho (bytes) de uma pasta, recursivamente, tolerando arquivos removidos
   concorrentemente (a rotina automática roda junto com a retenção). */
function dirSizeBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) total += fs.statSync(p).size;
      } catch { /* arquivo removido entre o readdir e o stat */ }
    }
  };
  walk(dir);
  return total;
}

/*
 * Situação de espaço para o painel:
 *   disk.used_percent >= 85          -> level "critical"
 *   disk.used_percent >= 70          -> level "warning"
 *   disk.free < BACKUP_MIN_FREE_SPACE -> level "critical" (novo backup é bloqueado)
 *   demais casos                     -> level "ok"
 *
 * A medição usa statfs sobre DATA_DIR (o disco onde ficam bancos + backups —
 * no Render, o Persistent Disk montado em /var/data). Sem API de disco
 * disponível, retorna apenas o total ocupado pela pasta backups/.
 */
function getStorageInfo() {
  let disk = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(DATA_DIR);
      const blockSize = Number(s.bsize);
      const total = Number(s.blocks) * blockSize;
      const free = Number(s.bavail) * blockSize;
      const used = Math.max(total - free, 0);
      const usedPercent = total > 0 ? Math.round((used / total) * 100) : 0;
      const minFree = config().minFreeSpaceBytes;
      let level = 'ok';
      if (free < minFree || usedPercent >= 85) level = 'critical';
      else if (usedPercent >= 70) level = 'warning';
      disk = {
        total_bytes: total,
        free_bytes: free,
        used_bytes: used,
        used_percent: usedPercent,
        min_free_bytes: minFree,
        level
      };
    }
  } catch { /* sem API de espaço */ }
  return { disk, backups_size_bytes: dirSizeBytes(BACKUPS_ROOT) };
}

/* ---------- Snapshot do banco ---------- */

/*
 * Gera uma cópia consistente do banco do tenant via VACUUM INTO (ignora
 * WAL/SHM e compacta). A cópia vai para o diretório temporário do backup.
 */
function snapshotTenantDatabase(databaseName, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, databaseName);
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);

  const db = openTenantDatabase(databaseName);
  const escaped = destPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return destPath;
}

/* ---------- Assets ---------- */

function collectAssets(tenantId) {
  const dir = path.join(ASSETS_DIR, tenantFolderName(tenantId));
  if (!fs.existsSync(dir)) return { files: [], totalSize: 0 };
  const files = fs.readdirSync(dir).filter((name) => {
    const p = path.join(dir, name);
    return fs.statSync(p).isFile();
  });
  const entries = [];
  let totalSize = 0;
  for (const name of files) {
    const src = path.join(dir, name);
    const stat = fs.statSync(src);
    totalSize += stat.size;
    entries.push({ name, src, size: stat.size });
  }
  return { files: entries, totalSize };
}

/* ---------- Compactação ---------- */

/* archiver v8 é ESM-only: resolve a classe ZipArchive via import() e guarda
   em cache (o primeiro backup paga o custo do import). */
let ZipArchiveClass = null;
async function zipArchiveClass() {
  if (!ZipArchiveClass) {
    const mod = await import('archiver');
    ZipArchiveClass = mod.ZipArchive || mod.default.ZipArchive;
  }
  return ZipArchiveClass;
}

function createZip(srcDir, destPath) {
  return (async () => {
    const ZipArchive = await zipArchiveClass();
    const archive = new ZipArchive({ zlib: { level: 9 } });
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destPath);
      let settled = false;

      output.on('close', () => {
        if (!settled) { settled = true; resolve(); }
      });
      output.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      archive.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });
      archive.on('warning', (err) => {
        if (err && err.code === 'ENOENT' && !settled) { settled = true; reject(err); }
      });

      archive.pipe(output);
      /* Apenas o conteúdo do diretório temporário (manifest + database/ + assets/),
         com caminhos relativos controlados — nada vindo do frontend. */
      archive.directory(srcDir, false);
      archive.finalize();
    });
  })();
}

function buildFilename(tenant, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${tenant.database_name.replace('.db', '')}-backup-${ts}.zip`;
}

function schemaMigrationsOf(databaseName) {
  try {
    const db = openTenantDatabase(databaseName);
    return db.prepare('SELECT name FROM schema_migrations ORDER BY rowid').all().map((r) => r.name);
  } catch {
    return [];
  }
}

function publicRun(run) {
  if (!run) return null;
  const tenant = run.tenant_id ? getTenantById(run.tenant_id) : null;
  const started = Date.parse(run.started_at);
  const completed = run.completed_at ? Date.parse(run.completed_at) : null;
  const durationSeconds = started && completed && completed >= started
    ? Math.round((completed - started) / 1000)
    : null;
  const { relative_path, ...safe } = run;
  return {
    ...safe,
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
    duration_seconds: durationSeconds
  };
}

function isRunning(tenantId) {
  return runningBackups.has(`tenant:${tenantId}`);
}

/* ---------- Criação de backup de tenant ---------- */

async function createTenantBackup({ tenantId, backupType, userId, skipRetention, allowDuringRestore }) {
  const type = validateTenantBackupType(backupType);
  const tenant = getTenantById(Number(tenantId));
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

  const lockKey = `tenant:${tenant.id}`;
  if (runningBackups.has(lockKey)) {
    throw new AppError(409, 'Já existe um backup em andamento para esta empresa. Aguarde a conclusão.');
  }
  /* Bloqueia backup enquanto houver restauração do mesmo tenant (require
     tardio evita ciclo: restoreService carrega backupService no topo).
     allowDuringRestore é usado APENAS pelo próprio fluxo de restauração para
     gerar o backup de segurança pré-restauração. */
  const restoreService = require('./restoreService');
  if (!allowDuringRestore && restoreService.isRestoring(tenant.id)) {
    throw new AppError(409, 'Há uma restauração em andamento para esta empresa. Aguarde a conclusão.');
  }
  runningBackups.add(lockKey);

  const backupId = require('crypto').randomUUID();
  const tmpDir = path.join(TMP_ROOT, backupId);
  const startedAt = new Date().toISOString();
  let finalZipPath = null;

  try {
    /* Histórico registrado ANTES de qualquer trabalho: o updateBackupRun do
       SUCCESS/FAILED (abaixo) sempre terá uma linha alvo em backup_runs. */
    insertBackupRun({
      id: backupId,
      tenant_id: tenant.id,
      backup_type: type,
      status: 'RUNNING',
      started_at: startedAt,
      created_by_user_id: userId || null
    });

    fs.mkdirSync(tmpDir, { recursive: true });
    safeLog(() => logActivity(userId, tenant.id, 'BACKUP_STARTED', `Backup ${type} iniciado`));

    const sourceDbPath = tenantFilePath(tenant.database_name);
    if (!fs.existsSync(sourceDbPath)) {
      throw new AppError(400, `O banco da empresa não existe no disco (${tenant.database_name}).`);
    }

    /* Verifica espaço ANTES de copiar qualquer coisa. */
    const assets = collectAssets(tenant.id);
    const dbSize = fs.statSync(sourceDbPath).size;
    checkFreeSpace(TMP_ROOT, dbSize + assets.totalSize);

    /* 1. Snapshot consistente do banco. */
    const dbSnapshotPath = snapshotTenantDatabase(tenant.database_name, path.join(tmpDir, 'database'));
    const dbSnapshotSize = fs.statSync(dbSnapshotPath).size;

    /* 2. Integridade: exige "ok" antes de compactar. */
    const integrity = integrityCheck(dbSnapshotPath);
    if (integrity !== 'ok') {
      throw new Error(`PRAGMA integrity_check falhou (${integrity})`);
    }

    /* 3. Hash do banco. */
    const dbHash = await hashFile(dbSnapshotPath);

    /* 4. Assets da empresa (logo, favicon, pix_qr e demais arquivos). */
    const assetFiles = [];
    if (assets.files.length) {
      const assetsDestDir = path.join(tmpDir, 'assets');
      fs.mkdirSync(assetsDestDir, { recursive: true });
      for (const f of assets.files) {
        fs.copyFileSync(f.src, path.join(assetsDestDir, f.name));
        const hash = await hashFile(f.src);
        assetFiles.push({ name: f.name, size_bytes: f.size, sha256: hash });
      }
    }

    /* 5. Manifest. */
    const domains = listDomains(tenant.id);
    const primaryDomain = domains.find((d) => d.is_primary) || domains[0] || null;
    const migrations = schemaMigrationsOf(tenant.database_name);
    const manifest = {
      version: 1,
      type: 'tenant',
      created_at: startedAt,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        database_name: tenant.database_name,
        domain: primaryDomain ? primaryDomain.domain : null,
        plan: tenant.plan,
        status: tenant.status
      },
      database: {
        file: path.posix.join('database', tenant.database_name),
        size_bytes: dbSnapshotSize,
        integrity_check: integrity,
        sha256: dbHash
      },
      assets: {
        count: assetFiles.length,
        files: assetFiles
      },
      application: {
        name: 'PapiCore',
        node_version: process.version,
        schema_version: migrations.length ? migrations.join(', ') : 'initial'
      }
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    /* 6. Compacta em ZIP final (caminho controlado, dentro de backups/tenants/).
       Se já existir um arquivo com o mesmo nome (dois backups no mesmo
       segundo), garante unicidade com um sufixo curto. */
    let filename = buildFilename(tenant, new Date());
    let finalZipPath = path.join(tenantBackupsDir(tenant.id), filename);
    if (fs.existsSync(finalZipPath)) {
      const suffix = require('crypto').randomUUID().slice(0, 8);
      filename = filename.replace(/\.zip$/, `-${suffix}.zip`);
      finalZipPath = path.join(tenantBackupsDir(tenant.id), filename);
    }
    await createZip(tmpDir, finalZipPath);

    /* 7. Hash e metadados finais. */
    const zipHash = await hashFile(finalZipPath);
    const zipSize = fs.statSync(finalZipPath).size;
    const relativePath = path.relative(BACKUPS_ROOT, finalZipPath).split(path.sep).join('/');
    const completedAt = new Date().toISOString();

    const run = updateBackupRun(backupId, {
      status: 'SUCCESS',
      filename,
      relative_path: relativePath,
      size_bytes: zipSize,
      sha256: zipHash,
      database_count: 1,
      asset_file_count: assetFiles.length,
      completed_at: completedAt,
      error_message: null
    });

    safeLog(() => logActivity(userId, tenant.id, 'BACKUP_SUCCESS', `Backup ${filename} gerado (${zipSize} bytes, ${assetFiles.length} asset(s))`));

    /* 8. Retenção local — falha aqui não invalida o backup recém-criado.
       Backups de segurança (skipRetention, ex.: TENANT_PRE_RESTORE) não são
       podados pela retenção: a etapa de restauração faz a limpeza deles. */
    if (!skipRetention) {
      try {
        const removed = runTenantRetention(tenant.id);
        if (removed.length) {
          safeLog(() => logActivity(userId, tenant.id, 'BACKUP_RETENTION_COMPLETED', `Retenção removeu ${removed.length} backup(s): ${removed.slice(0, 20).join(', ')}${removed.length > 20 ? ` (+${removed.length - 20} mais)` : ''}`));
        }
      } catch (retErr) {
        console.error('[backupService] Falha na retenção (backup novo mantido):', retErr.message);
      }
    }

    return publicRun(run);
  } catch (err) {
    if (finalZipPath && fs.existsSync(finalZipPath)) {
      try { fs.unlinkSync(finalZipPath); } catch { /* ignore */ }
    }
    const sanitized = String((err && err.message) || 'Erro desconhecido').slice(0, 500);
    try {
      updateBackupRun(backupId, {
        status: 'FAILED',
        error_message: sanitized,
        completed_at: new Date().toISOString()
      });
    } catch { /* o registro pode nem ter sido criado */ }
    safeLog(() => logActivity(userId, tenant.id, 'BACKUP_FAILED', `Backup ${type} falhou: ${sanitized}`));
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'Falha ao gerar o backup da empresa.');
  } finally {
    runningBackups.delete(lockKey);
    removeDir(tmpDir);
  }
}

/* ---------- Listagem / leitura ---------- */

function listBackups({ tenantId } = {}) {
  const filters = {};
  if (tenantId) filters.tenant_id = Number(tenantId);
  return listBackupRuns(filters).map(publicRun);
}

function getBackup(backupId) {
  const id = validateBackupId(backupId);
  const run = getBackupRun(id);
  if (!run) throw new AppError(404, 'Backup não encontrado.');
  return publicRun(run);
}

function resolveBackupFile(backupId) {
  const id = validateBackupId(backupId);
  const run = getBackupRun(id);
  if (!run) throw new AppError(404, 'Backup não encontrado.');
  if (run.status === 'DELETED') throw new AppError(404, 'Este backup foi excluído.');

  const filePath = resolveBackupPath(run.relative_path);
  if (!filePath) throw new AppError(400, 'Registro de backup inválido (caminho não resolvido).');
  if (!fs.existsSync(filePath)) {
    throw new AppError(404, 'O arquivo do backup não existe mais no disco.');
  }
  return { run, filePath, filename: run.filename || path.basename(filePath) };
}

/* ---------- Exclusão ---------- */

/*
 * Apaga o arquivo local e marca o registro como DELETED (o histórico é
 * mantido). Nunca apaga arquivos fora de DATA_DIR/backups.
 */
function deleteBackup(backupId, userId) {
  const id = validateBackupId(backupId);
  const run = getBackupRun(id);
  if (!run) throw new AppError(404, 'Backup não encontrado.');

  let removedFile = false;
  if (run.relative_path) {
    const filePath = resolveBackupPath(run.relative_path);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      removedFile = true;
    }
  }

  const updated = updateBackupRun(id, { status: 'DELETED' });
  safeLog(() => logActivity(userId, run.tenant_id, 'BACKUP_DELETED', `Backup ${run.filename || id} excluído${removedFile ? '' : ' (arquivo já ausente)'}`));
  return publicRun(updated);
}

/* ---------- Retenção ---------- */

function deleteBackupFileFromRun(run) {
  if (!run.relative_path) return false;
  const filePath = resolveBackupPath(run.relative_path);
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function retentionCutoff() {
  const days = config().retentionDays;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function runSortTime(run) {
  return run.completed_at || run.started_at || run.created_at || '';
}

/*
 * Retenção por tenant: mantém os últimos maxPerTenant backups bem-sucedidos e
 * remove os mais antigos que retentionDays. Nunca remove arquivos RUNNING
 * (só age sobre registros SUCCESS com arquivo). Retorna os nomes removidos.
 */
function runTenantRetention(tenantId) {
  const { maxPerTenant } = config();
  const cutoff = retentionCutoff();
  const runs = listBackupRuns({ tenant_id: tenantId })
    .filter((r) => r.status === 'SUCCESS' && r.relative_path)
    .sort((a, b) => runSortTime(b).localeCompare(runSortTime(a)));

  const toRemove = [];
  runs.forEach((run, idx) => {
    const tooOld = runSortTime(run) !== '' && runSortTime(run) < cutoff;
    if (idx >= maxPerTenant || tooOld) toRemove.push(run);
  });

  const removed = [];
  for (const run of toRemove) {
    try {
      deleteBackupFileFromRun(run);
      updateBackupRun(run.id, { status: 'DELETED' });
      removed.push(run.filename || run.id);
    } catch (err) {
      console.error('[backupService] Retenção não removeu', run.id, err.message);
    }
  }
  return removed;
}

/*
 * Varredura global de retenção (usada pela rotina automática): aplica a regra
 * de quantidade por tenant e a regra de idade a TODOS os backups (incluindo
 * pré-exclusão que já perderam o tenant via ON DELETE SET NULL).
 */
function runGlobalRetention() {
  const { maxPerTenant } = config();
  const cutoff = retentionCutoff();
  const removed = [];

  const grouped = new Map();
  for (const run of listBackupRuns({ status: 'SUCCESS' })) {
    if (!run.relative_path) continue;
    const key = run.tenant_id != null ? `tenant:${run.tenant_id}` : 'orphan';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(run);
  }

  for (const [, runs] of grouped) {
    runs.sort((a, b) => runSortTime(b).localeCompare(runSortTime(a)));
    runs.forEach((run, idx) => {
      const tooOld = runSortTime(run) !== '' && runSortTime(run) < cutoff;
      if (idx >= maxPerTenant || tooOld) {
        try {
          deleteBackupFileFromRun(run);
          updateBackupRun(run.id, { status: 'DELETED' });
          removed.push(run.filename || run.id);
        } catch (err) {
          console.error('[backupService] Retenção global não removeu', run.id, err.message);
        }
      }
    });
  }
  return removed;
}

/* ---------- Utilitários de teste / inspeção ---------- */

function _internal() {
  return {
    runningBackups,
    BACKUPS_ROOT,
    TENANT_BACKUPS_ROOT,
    SYSTEM_BACKUPS_ROOT,
    TMP_ROOT,
    resolveBackupPath
  };
}

module.exports = {
  createTenantBackup,
  listBackups,
  getBackup,
  resolveBackupFile,
  deleteBackup,
  runTenantRetention,
  runGlobalRetention,
  getStorageInfo,
  isRunning,
  backupsRoot: () => { fs.mkdirSync(BACKUPS_ROOT, { recursive: true }); return BACKUPS_ROOT; },
  systemBackupsDir,
  tenantBackupsDir,
  _internal
};

