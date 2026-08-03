/*
 * assetStorage.js
 *
 * Armazenamento dos assets de identidade visual por empresa (tenant):
 * logo, favicon e o QR Code do Pix (pagamento).
 *
 * Estrutura no disco (relativa a DATA_DIR):
 *   assets/tenant_XXXX/logo.<png|jpg|webp>
 *   assets/tenant_XXXX/favicon.<png|ico>
 *   assets/tenant_XXXX/pix_qr.<png|jpg|webp>
 *
 * DATA_DIR é resolvido aqui, em um único ponto, seguindo o mesmo padrão de
 * database/tenantDatabase.js: process.env.DATA_DIR (Render) ou ./data (dev).
 * Os caminhos salvos no banco central são SEMPRE relativos a DATA_DIR — assim
 * a pasta pode ser movida/recriada sem quebrar as URLs servidas.
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR =
  process.env.DATA_DIR ||
  path.join(__dirname, '..', 'data');

const ASSETS_DIR = path.join(DATA_DIR, 'assets');

/* MIME -> extensão canônica. Nada de SVG (risco de scripts embutidos). */
const LOGO_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};

const FAVICON_MIME_EXT = {
  'image/png': '.png',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico'
};

/* QR Code do Pix aceita os mesmos formatos da logo (PNG, JPG ou WEBP). */
const PIX_QR_MIME_EXT = LOGO_MIME_EXT;

const KIND_MIME_EXT = {
  logo: LOGO_MIME_EXT,
  favicon: FAVICON_MIME_EXT,
  pix_qr: PIX_QR_MIME_EXT
};

function kindName(kind) {
  if (!Object.prototype.hasOwnProperty.call(KIND_MIME_EXT, kind)) {
    throw new Error('Tipo de asset inválido.');
  }
  return kind;
}

function isAllowedMime(kind, mimeType) {
  return Object.prototype.hasOwnProperty.call(KIND_MIME_EXT[kind], mimeType);
}

function extensionFor(kind, mimeType) {
  return KIND_MIME_EXT[kind][mimeType] || null;
}

function tenantFolderName(tenantId) {
  if (!/^\d+$/.test(String(tenantId))) throw new Error('Identificador de empresa inválido.');
  return 'tenant_' + String(tenantId).padStart(4, '0');
}

/* Cria (se preciso) e retorna a pasta de assets da empresa. */
function tenantAssetsDir(tenantId) {
  const dir = path.join(ASSETS_DIR, tenantFolderName(tenantId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* Caminho absoluto do arquivo atual do tipo informado, ou null. */
function storedFilePath(tenantId, kind) {
  const name = kindName(kind);
  const dir = path.join(ASSETS_DIR, tenantFolderName(tenantId));
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find((file) => file.startsWith(name + '.'));
  return match ? path.join(dir, match) : null;
}

function removeAssetFile(tenantId, kind) {
  const file = storedFilePath(tenantId, kind);
  if (file) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

/* Remove a pasta inteira da empresa (usado ao excluir o tenant). */
function removeTenantAssets(tenantId) {
  const dir = path.join(ASSETS_DIR, tenantFolderName(tenantId));
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

/*
 * Assets da própria plataforma (não pertencem a nenhum tenant) — ex.: a logo
 * exibida na tela de login do painel do desenvolvedor. Ficam em
 * ASSETS_DIR/platform/, separados dos diretórios tenant_XXXX.
 */
function platformAssetsDir() {
  const dir = path.join(ASSETS_DIR, 'platform');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storedPlatformFilePath(kind) {
  const dir = path.join(ASSETS_DIR, 'platform');
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find((file) => file.startsWith(kind + '.'));
  return match ? path.join(dir, match) : null;
}

function removePlatformAssetFile(kind) {
  const file = storedPlatformFilePath(kind);
  if (file) {
    fs.unlinkSync(file);
    return true;
  }
  return false;
}

/* Remove um arquivo se existir, sem lançar erro (limpeza de órfãos). */
function unlinkIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('[assetStorage] Erro ao remover arquivo órfão:', err.message);
  }
}

/*
 * Detecta o formato real pelo "magic number" do arquivo e retorna o MIME
 * canônico (ou null se o conteúdo não for uma imagem conhecida). Complementa
 * o MIME declarado pelo navegador, que pode ser forjado no upload.
 */
function sniffMime(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    if (read < 4) return null;
    const b = buf;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
      if (read >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    }
    return null;
  } catch (err) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  DATA_DIR,
  ASSETS_DIR,
  isAllowedMime,
  extensionFor,
  tenantAssetsDir,
  storedFilePath,
  removeAssetFile,
  removeTenantAssets,
  unlinkIfExists,
  sniffMime,
  platformAssetsDir,
  storedPlatformFilePath,
  removePlatformAssetFile
};
