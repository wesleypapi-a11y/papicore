/*
 * contractStorage.js
 *
 * Armazenamento em disco dos PDFs de contrato gerados pela plataforma.
 *
 * Estrutura (sempre relativa a DATA_DIR):
 *   DATA_DIR/contracts/<ano>/tenant_XXXX/CT-<ano>-<numero>.pdf
 *
 * DATA_DIR é resolvido aqui, em um único ponto, seguindo o mesmo padrão de
 * utils/assetStorage.js e database/tenantDatabase.js: process.env.DATA_DIR
 * (Render) ou ./data (dev).
 *
 * REGRAS DE SEGURANÇA:
 *   - os PDFs NUNCA ficam em public/ (só são servidos via rota autenticada);
 *   - o caminho salvo no banco é SEMPRE relativo a DATA_DIR e a resolução
 *     para leitura confirma que o destino está dentro de DATA_DIR/contracts
 *     (bloqueia path traversal); nunca se aceita caminho vindo do frontend;
 *   - o nome de pasta do tenant é gerado a partir do id numérico (nunca do
 *     nome/slug, que pode conter caracteres arbitrários).
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, '..', 'data');

const CONTRACTS_ROOT = path.join(DATA_DIR, 'contracts');

function tenantFolderName(tenantId) {
  if (!/^\d+$/.test(String(tenantId))) throw new Error('Identificador de empresa inválido.');
  return 'tenant_' + String(tenantId).padStart(4, '0');
}

function contractsRoot() {
  fs.mkdirSync(CONTRACTS_ROOT, { recursive: true });
  return CONTRACTS_ROOT;
}

/* Pasta da empresa dentro de contracts/<ano>/. */
function tenantContractsDir(tenantId, year) {
  const safeYear = /^\d{4}$/.test(String(year)) ? String(year) : String(new Date().getFullYear());
  const dir = path.join(CONTRACTS_ROOT, safeYear, tenantFolderName(tenantId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* Caminho absoluto do PDF de um contrato (diretório criado se preciso). */
function contractPdfPath(tenantId, year, contractNumber) {
  const safeNumber = String(contractNumber || '').replace(/[^A-Za-z0-9-]/g, '');
  if (!safeNumber) throw new Error('Número de contrato inválido.');
  return path.join(tenantContractsDir(tenantId, year), `${safeNumber}.pdf`);
}

/*
 * Resolve um relative_path salvo no banco para o caminho absoluto do PDF.
 * Nunca aceita caminhos do frontend: o path vem do registro do banco e é
 * confirmado dentro de DATA_DIR/contracts (bloqueia path traversal). Retorna
 * null quando o caminho não é resolvível com segurança.
 */
function resolveContractPdf(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  const normalized = relativePath.split('\\').join('/');
  if (path.posix.isAbsolute(normalized)) return null;
  const absolute = path.resolve(CONTRACTS_ROOT, normalized);
  const root = path.resolve(CONTRACTS_ROOT) + path.sep;
  if (!absolute.startsWith(root)) return null;
  return absolute;
}

/* Caminho relativo a CONTRACTS_ROOT usado no registro do banco (pdf_path) —
   mesma convenção de relative_path do backupService (relativo à raiz do
   próprio recurso, sem o prefixo "contracts/"), o formato que
   resolveContractPdf() espera para reconstituir o caminho absoluto. */
function relativeContractPath(tenantId, year, contractNumber) {
  return `${String(year)}/${tenantFolderName(tenantId)}/${String(contractNumber).replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
}

/* Lista todos os arquivos de contrato de uma empresa (usado no backup).
   Retorna [{ relative_path, absolute_path, size_bytes }]. Aqui relative_path
   inclui o prefixo "contracts/" de propósito — é o caminho usado dentro do
   ZIP de backup (namespace próprio, não é o pdf_path salvo no banco). */
function listTenantContractFiles(tenantId) {
  const folder = tenantFolderName(tenantId);
  const result = [];
  if (!fs.existsSync(CONTRACTS_ROOT)) return result;
  for (const year of fs.readdirSync(CONTRACTS_ROOT)) {
    if (!/^\d{4}$/.test(year)) continue;
    const dir = path.join(CONTRACTS_ROOT, year, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.pdf')) continue;
      const absolute = path.join(dir, file);
      try {
        result.push({
          relative_path: `contracts/${year}/${folder}/${file}`,
          absolute_path: absolute,
          size_bytes: fs.statSync(absolute).size
        });
      } catch { /* arquivo removido concorrentemente */ }
    }
  }
  return result;
}

/* Remove a pasta de contratos inteira de uma empresa (usado ao excluir tenant). */
function removeTenantContracts(tenantId) {
  const folder = tenantFolderName(tenantId);
  let removedAny = false;
  if (!fs.existsSync(CONTRACTS_ROOT)) return false;
  for (const year of fs.readdirSync(CONTRACTS_ROOT)) {
    if (!/^\d{4}$/.test(year)) continue;
    const dir = path.join(CONTRACTS_ROOT, year, folder);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removedAny = true;
    }
  }
  return removedAny;
}

/* Remove o arquivo de um PDF se existir, sem lançar erro (limpeza de órfãos). */
function unlinkContractPdf(relativePath) {
  const filePath = resolveContractPdf(relativePath);
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (err) {
      console.error('[contractStorage] Erro ao remover PDF órfão:', err.message);
    }
  }
  return false;
}

module.exports = {
  DATA_DIR,
  CONTRACTS_ROOT,
  contractsRoot,
  tenantContractsDir,
  contractPdfPath,
  resolveContractPdf,
  relativeContractPath,
  listTenantContractFiles,
  removeTenantContracts,
  unlinkContractPdf
};
