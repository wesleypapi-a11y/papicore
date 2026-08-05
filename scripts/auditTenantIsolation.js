#!/usr/bin/env node
/*
 * auditTenantIsolation.js
 *
 * Audita o isolamento entre tenants (empresas) e a neutralidade do seed de
 * criação de empresas:
 *   - nenhum banco de tenant pode conter dados, textos, endereços ou preços
 *     herdados de outro cliente (marcas Torque, "Rua das Flores", ...);
 *   - company_settings.phone / whatsapp não podem conter e-mail;
 *   - unidades não podem ter endereço placeholder copiado da Torque Detail;
 *   - reporta o estado de configuração da agenda (setup_status) de cada
 *     empresa (PENDING/READY) — dados de onboarding.
 *
 * Uso:
 *   node scripts/auditTenantIsolation.js               # apenas audita
 *   node scripts/auditTenantIsolation.js --tenant=<id> # audita só uma empresa
 *   node scripts/auditTenantIsolation.js --fix         # corrige a IVA Detalhes
 *   node scripts/auditTenantIsolation.js --tenant=<id> --fix-empty-default-unit
 *                                                      # remove unidade(s) vazia(s)
 *                                                      # do seed antigo (com backup)
 *   DATA_DIR=... node scripts/auditTenantIsolation.js  # outro DATA_DIR
 *
 * O modo --fix corrige APENAS dados reais incorretos da IVA Detalhes
 * (tenant_0005_sempre_limpo.db): company_name "IVA Detalhes", phone/whatsapp
 * sem e-mail e unidade sem endereço copiado da Torque. NÃO toca em tenants,
 * domínios, usuários, planos, cobranças, backup/restauração ou em qualquer
 * outra empresa. Domínio pendente de verificação é apenas reportado (o
 * desenvolvedor marca como verificado pelo painel dele).
 *
 * --fix-empty-default-unit remove a "unidade vazia" criada pelo seed antigo
 * (sem endereço e telefone — placeholder). É um script MANUAL: NÃO rode em
 * produção sem antes gerar um backup do banco. Uma cópia de segurança do
 * arquivo (e WAL/SHM, se existirem) é feita em <DATA_DIR>/backups/audit-fixes/
 * imediatamente antes da remoção.
 *
 * Código de saída: 0 (sem problemas / fix ok), 1 (auditoria encontrou
 * problemas ou fix falhou).
 */

'use strict';

const path = require('path');
const fs = require('fs');

/* DATA_DIR respeita env — por padrão usa os dados reais de desenvolvimento. */
if (process.env.DATA_DIR) {
  process.env.DATA_DIR = path.resolve(process.env.DATA_DIR);
}
const IS_FIX = process.argv.includes('--fix');
const IS_FIX_EMPTY_UNIT = process.argv.includes('--fix-empty-default-unit');
const tenantFilterArg = process.argv.find((a) => a.startsWith('--tenant='));
const tenantFilter = tenantFilterArg ? tenantFilterArg.split('=')[1] : null;

const core = require('../database/coreDatabase');
const { openTenantDatabase, closeTenantDatabase, isOpenTenantDatabase, tenantFilePath } = require('../database/tenantDatabase');
const { computeSetupStatus } = require('../database/tenantSchema');

const TORQUE_DB = 'tenant_0001_torque_detail.db';
const IVA_DB = 'tenant_0005_sempre_limpo.db';
const IVA_COMPANY_NAME = 'IVA Detalhes';

/* Marcas de dados herdados de outro cliente. O tenant da Torque Detail é a
   única empresa que pode conter essas marcas. */
const FORBIDDEN_PATTERNS = [
  { name: 'marca "Torque"', test: (v) => /torque/i.test(String(v || '')) },
  { name: 'endereço placeholder "Rua das Flores"', test: (v) => /Rua das Flores/i.test(String(v || '')) },
  { name: 'placeholder "(00) 00000-0000"', test: (v) => /\(00\)\s*00000-0000/.test(String(v || '')) }
];

const EMAIL_RE = /@/;

/* Unidade "vazia" do seed antigo: criada sem endereço e sem telefone
   (placeholder). É o que sobrou da implantação que exigia unidade no cadastro
   da empresa. Uma unidade real sempre tem ao menos endereço ou telefone. */
function isEmptyDefaultUnit(u) {
  return (!u.phone || !String(u.phone).trim()) && (!u.address || !String(u.address).trim());
}

/* Cópia de segurança do arquivo do banco antes de qualquer correção destrutiva
   de dados. Usado pelo --fix e pelo --fix-empty-default-unit. */
function backupTenantDb(tenant) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const backupDir = path.join(dataDir, 'backups', 'audit-fixes');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const created = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const src = tenantFilePath(tenant.database_name + suffix);
    if (fs.existsSync(src)) {
      const dest = path.join(backupDir, `${tenant.database_name}${suffix}.${stamp}`);
      fs.copyFileSync(src, dest);
      created.push(dest);
    }
  }
  return created;
}

/* Remove unidades vazias do seed antigo (--fix-empty-default-unit), sempre com
   backup antes. Retorna a lista de mudanças aplicadas (vazia se nada a fazer). */
function removeEmptyDefaultUnits(tenant) {
  const { db, wasOpen } = openTenantReadonly(tenant.database_name);
  const changes = [];
  try {
    const units = db.prepare('SELECT id, name, address, phone FROM units ORDER BY id ASC').all();
    const empty = units.filter(isEmptyDefaultUnit);
    if (empty.length) {
      const backupFiles = backupTenantDb(tenant);
      changes.push(`backup criado: ${path.relative(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), backupFiles[0])}`);
      for (const u of empty) {
        db.prepare('DELETE FROM units WHERE id = ?').run(u.id);
        changes.push(`unidade ${u.id} "${u.name}" removida (unidade vazia do seed antigo)`);
      }
    }
  } finally {
    if (!wasOpen) closeTenantDatabase(tenant.database_name);
  }
  return changes;
}

function openTenantReadonly(databaseName) {
  const wasOpen = isOpenTenantDatabase(databaseName);
  const db = openTenantDatabase(databaseName);
  return { db, wasOpen };
}

function auditTenant(t) {
  const issues = [];
  const { db, wasOpen } = openTenantReadonly(t.database_name);
  try {
    const settings = db.prepare('SELECT * FROM company_settings WHERE id = 1').get() || {};
    if (EMAIL_RE.test(String(settings.phone || ''))) {
      issues.push(`company_settings.phone contém e-mail ("${settings.phone}")`);
    }
    if (EMAIL_RE.test(String(settings.whatsapp || ''))) {
      issues.push(`company_settings.whatsapp contém e-mail ("${settings.whatsapp}")`);
    }

    const units = db.prepare('SELECT * FROM units ORDER BY id ASC').all();
    for (const u of units) {
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.test(u.address)) issues.push(`unidade ${u.id} (${u.name}): ${p.name}`);
        if (p.test(u.name)) issues.push(`unidade ${u.id}: nome com ${p.name}`);
      }
      if (EMAIL_RE.test(String(u.phone || ''))) {
        issues.push(`unidade ${u.id} (${u.name}): phone contém e-mail ("${u.phone}")`);
      }
      if (isEmptyDefaultUnit(u)) {
        issues.push(`unidade ${u.id} (${u.name}): unidade vazia do seed antigo (sem endereço e telefone) — remover com --fix-empty-default-unit`);
      }
    }

    const categories = db.prepare('SELECT name, slug FROM service_categories ORDER BY id ASC').all();
    const services = db.prepare('SELECT name, description FROM services ORDER BY id ASC').all();
    for (const c of categories) {
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.test(c.name) || p.test(c.slug)) issues.push(`categoria "${c.name}": ${p.name}`);
      }
    }
    for (const s of services) {
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.test(s.name) || p.test(s.description)) issues.push(`serviço "${s.name}": ${p.name}`);
      }
    }

    const setup = computeSetupStatus(db);
    return { issues, setup };
  } finally {
    if (!wasOpen) closeTenantDatabase(t.database_name);
  }
}

/* --- Correção da IVA Detalhes (--fix) --- */

function fixIva(tenant) {
  const { db, wasOpen } = openTenantReadonly(tenant.database_name);
  const changes = [];
  try {
    const settings = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
    if (settings && settings.company_name !== IVA_COMPANY_NAME) {
      db.prepare("UPDATE company_settings SET company_name = ?, updated_at = datetime('now', 'localtime') WHERE id = 1").run(IVA_COMPANY_NAME);
      changes.push(`company_settings.company_name: "${settings.company_name}" -> "${IVA_COMPANY_NAME}"`);
    }
    for (const field of ['phone', 'whatsapp']) {
      const val = settings ? settings[field] : null;
      if (EMAIL_RE.test(String(val || ''))) {
        db.prepare(`UPDATE company_settings SET ${field} = NULL, updated_at = datetime('now', 'localtime') WHERE id = 1`).run();
        changes.push(`company_settings.${field}: "${val}" -> null (era e-mail)`);
      }
    }

    const units = db.prepare('SELECT id, name, address, phone FROM units ORDER BY id ASC').all();
    for (const u of units) {
      const updates = [];
      const params = [];
      const isPlaceholderAddress = /Rua das Flores/i.test(String(u.address || ''));
      const isPlaceholderName = /— Centro$/i.test(String(u.name || '')) || /Rua das Flores/i.test(String(u.name || ''));
      if (isPlaceholderAddress) {
        updates.push('address = ?');
        params.push('');
        changes.push(`unidade ${u.id}: endereço placeholder removido ("${u.address}")`);
      }
      if (isPlaceholderName && String(u.name || '').toLowerCase().startsWith('iv')) {
        updates.push('name = ?');
        params.push(`${IVA_COMPANY_NAME} — Unidade`);
        changes.push(`unidade ${u.id}: nome corrigido ("${u.name}" -> "${IVA_COMPANY_NAME} — Unidade")`);
      }
      if (EMAIL_RE.test(String(u.phone || ''))) {
        updates.push('phone = ?');
        params.push('');
        changes.push(`unidade ${u.id}: phone corrigido ("${u.phone}" -> vazio, era e-mail)`);
      }
      if (updates.length) {
        updates.push("updated_at = datetime('now', 'localtime')");
        params.push(u.id);
        db.prepare(`UPDATE units SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      }
    }

    /* Taxas de modalidade herdadas da Torque (20/30) viram 0 — empresas novas
       nascem com fee 0; a IVA não pode herdar o preço de outro cliente. */
    const modalities = db.prepare('SELECT id, name, fee FROM service_modalities ORDER BY id ASC').all();
    for (const m of modalities) {
      if (Number(m.fee) !== 0) {
        db.prepare("UPDATE service_modalities SET fee = 0, updated_at = datetime('now', 'localtime') WHERE id = ?").run(m.id);
        changes.push(`modalidade "${m.name}": fee ${m.fee} -> 0 (taxa herdada removida)`);
      }
    }
  } finally {
    if (!wasOpen) closeTenantDatabase(tenant.database_name);
  }
  return changes;
}

/* --- Execução --- */

function main() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  console.log(`[auditTenantIsolation] DATA_DIR: ${dataDir}`);
  if (!fs.existsSync(path.join(dataDir, 'papi_core.db'))) {
    console.error('[auditTenantIsolation] papi_core.db não encontrado. Rode o servidor uma vez antes da auditoria.');
    process.exit(1);
  }

  core.initCore();
  let tenants = core.listTenants();
  if (!tenants.length) {
    console.log('[auditTenantIsolation] Nenhuma empresa cadastrada.');
    process.exit(0);
  }

  if (tenantFilter !== null) {
    tenants = tenants.filter((t) => String(t.id) === tenantFilter);
    if (!tenants.length) {
      console.error(`[auditTenantIsolation] Nenhuma empresa com id ${tenantFilter} encontrada.`);
      process.exit(1);
    }
  }

  let problem = false;
  const fixed = [];

  for (const t of tenants) {
    const dbPath = tenantFilePath(t.database_name);
    if (!fs.existsSync(dbPath)) {
      console.log(`\n[empresa ${t.id}] ${t.name} — banco ausente: ${t.database_name}`);
      problem = true;
      continue;
    }

    const { issues, setup } = auditTenant(t);
    const isTorque = t.database_name === TORQUE_DB;
    const relevant = isTorque ? [] : issues;
    const statusLabel = setup.status === 'READY' ? 'READY' : `PENDING (falta: ${setup.missing.join(', ') || '—'})`;

    console.log(`\n[empresa ${t.id}] ${t.name} (${t.slug})`);
    console.log(`  banco: ${t.database_name}`);
    console.log(`  configuração da agenda: ${statusLabel}`);
    if (relevant.length) {
      console.log(`  problemas de isolamento: ${relevant.length}`);
      relevant.forEach((r) => console.log(`    - ${r}`));
      if (isTorque) console.log('    (banco legado da Torque Detail — esperado)');
    } else if (issues.length && isTorque) {
      console.log('  marcas Torque: presentes (esperado no tenant 0001)');
    }

    const isIva = t.database_name === IVA_DB;
    const wantsFix = (isIva && IS_FIX) || IS_FIX_EMPTY_UNIT;
    if (wantsFix) {
      const changes = [];
      if (isIva && IS_FIX) changes.push(...fixIva(t));
      if (IS_FIX_EMPTY_UNIT) changes.push(...removeEmptyDefaultUnits(t));
      if (changes.length) {
        fixed.push(...changes.map((c) => `  [empresa ${t.id}] ${c}`));
      } else if (isIva && IS_FIX) {
        console.log('  IVA Detalhes: nenhuma correção necessária.');
      }
      /* Re-audita após a correção: o que sobrou conta como problema real. */
      const after = auditTenant(t);
      const remaining = after.issues.length;
      if (remaining) {
        console.log(`  [empresa ${t.id}] após correção: ${remaining} problema(s) restante(s)`);
        after.issues.forEach((r) => console.log(`    - ${r}`));
        problem = true;
      }
    } else if (relevant.length) {
      problem = true;
    }
  }

  if (fixed.length) {
    console.log(`\n[auditTenantIsolation] Correções aplicadas na IVA Detalhes:`);
    fixed.forEach((c) => console.log(c));
  }

  const iva = tenants.find((t) => t.database_name === IVA_DB);
  if (iva) {
    const domains = core.listDomains(iva.id);
    const iv = domains.find((d) => /ivadetalhes\.com\.br/i.test(d.domain));
    if (iv && !iv.verified) {
      console.log(`\n[atenção] O domínio ${iv.domain} ainda está PENDENTE de verificação. Marque como verificado pelo painel do desenvolvedor (aba Domínios) — este script não altera domínios.`);
    }
  }

  if (problem) {
    console.log('\n[auditTenantIsolation] Foram encontrados problemas de isolamento.');
    process.exit(1);
  }
  console.log('\n[auditTenantIsolation] Auditoria concluída sem problemas.');
  process.exit(0);
}

main();
