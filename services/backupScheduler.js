/*
 * backupScheduler.js
 *
 * Rotina automática de backup local (Fase 1 do PapiCore).
 *
 * Regras:
 *   - roda apenas em NODE_ENV=production E BACKUP_LOCAL_ENABLED=true;
 *   - agenda diária via node-cron (BACKUP_LOCAL_SCHEDULE, ex: "0 3 * * *");
 *   - percorre os tenants ACTIVE e gera um backup TENANT_AUTOMATIC por empresa;
 *   - impede execução simultânea (se uma rodada ainda estiver ativa, a próxima
 *     chamada é ignorada);
 *   - se um tenant falhar, continua para o próximo e registra a falha;
 *   - ao final, aplica a retenção global (quantidade + idade);
 *   - nunca derruba o servidor: toda falha é capturada e logada.
 *
 * BACKUP_RUN_ON_START=true (opcional) executa uma rodada logo no boot.
 * Em desenvolvimento a rotina é desligada por padrão — use runAutomaticBackups()
 * diretamente nos testes.
 */

const cron = require('node-cron');

const backupService = require('./backupService');
const { listTenants, logActivity } = require('../database/coreDatabase');

let scheduled = false;
let running = false;

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function isEnabled() {
  return isProduction() && String(process.env.BACKUP_LOCAL_ENABLED || 'true').toLowerCase() === 'true';
}

function scheduleExpression() {
  return String(process.env.BACKUP_LOCAL_SCHEDULE || '0 3 * * *').trim();
}

function timezone() {
  return String(process.env.BACKUP_TIMEZONE || 'America/Sao_Paulo').trim();
}

function shouldRunOnStart() {
  return String(process.env.BACKUP_RUN_ON_START).toLowerCase() === 'true';
}

function safeLog(action, details) {
  try {
    logActivity(null, null, action, details);
  } catch (err) {
    console.error('[backupScheduler] Falha ao registrar log:', err.message);
  }
}

/*
 * Executa uma rodada completa de backups automáticos. Pode ser chamada pelo
 * cron (produção), no boot (BACKUP_RUN_ON_START) ou por testes (qualquer
 * ambiente). Retorna o resumo { ok, failed, skipped }.
 */
async function runAutomaticBackups() {
  if (running) return { ok: 0, failed: 0, skipped: 1 };
  running = true;
  const summary = { ok: 0, failed: 0, skipped: 0 };
  try {
    const tenants = listTenants().filter((t) => t.status === 'ACTIVE');
    safeLog('BACKUP_AUTOMATIC_STARTED', `Rodada automática iniciada (${tenants.length} empresa(s) ativa(s))`);

    for (const tenant of tenants) {
      try {
        await backupService.createTenantBackup({
          tenantId: tenant.id,
          backupType: 'TENANT_AUTOMATIC',
          userId: null
        });
        summary.ok += 1;
      } catch (err) {
        summary.failed += 1;
        console.error('[backupScheduler] Falha no backup automático de', tenant.id, err.message);
      }
    }

    /* Retenção global ao final (inclui pré-exclusão órfãs). */
    try {
      const removed = backupService.runGlobalRetention();
      if (removed.length) {
        safeLog('BACKUP_RETENTION_COMPLETED', `Retenção global removeu ${removed.length} backup(s): ${removed.slice(0, 20).join(', ')}${removed.length > 20 ? ` (+${removed.length - 20} mais)` : ''}`);
      }
    } catch (err) {
      console.error('[backupScheduler] Falha na retenção global:', err.message);
    }

    safeLog('BACKUP_AUTOMATIC_COMPLETED', `Rodada automática concluída (${summary.ok} ok, ${summary.failed} falhas)`);
    return summary;
  } finally {
    running = false;
  }
}

/*
 * Inicializa o agendador. Chamado no server.js após initCore(). Em
 * desenvolvimento não agenda nada (evita backups indesejados na máquina local).
 */
function startBackupScheduler() {
  if (scheduled) return;
  if (!isProduction()) {
    console.log('[backupScheduler] Rotina automática desativada fora de produção.');
    return;
  }
  if (!isEnabled()) {
    console.log('[backupScheduler] BACKUP_LOCAL_ENABLED=false — rotina automática desativada.');
    return;
  }

  const expression = scheduleExpression();
  if (!cron.validate(expression)) {
    console.error(`[backupScheduler] Expressão cron inválida (${expression}). Rotina desativada.`);
    return;
  }

  cron.schedule(expression, () => {
    runAutomaticBackups().catch((err) => {
      console.error('[backupScheduler] Erro inesperado na rodada automática:', err.message);
    });
  }, { timezone: timezone() });

  scheduled = true;
  console.log(`[backupScheduler] Backups automáticos agendados ${expression} (${timezone()}).`);

  if (shouldRunOnStart()) {
    console.log('[backupScheduler] BACKUP_RUN_ON_START=true — rodando no boot.');
    runAutomaticBackups().catch((err) => {
      console.error('[backupScheduler] Erro na rodada de boot:', err.message);
    });
  }
}

module.exports = { startBackupScheduler, runAutomaticBackups, isEnabled };

/* Exposto apenas para testes: parsing de env sem acionar o cron de verdade. */
module.exports._internal = function _internal() {
  return {
    isProduction,
    isEnabled,
    scheduleExpression,
    timezone,
    shouldRunOnStart,
    isScheduled: () => scheduled
  };
};
