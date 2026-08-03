/*
 * brandingController.js
 *
 * Identidade visual por empresa (tenant): logo e favicon.
 *
 * Área do desenvolvedor (protegida por requireDeveloper):
 *   GET    /api/developer/tenants/:id/branding            -> metadados
 *   GET    /api/developer/tenants/:id/branding/logo       -> arquivo
 *   GET    /api/developer/tenants/:id/branding/favicon    -> arquivo
 *   POST   /api/developer/tenants/:id/branding/logo       -> upload
 *   POST   /api/developer/tenants/:id/branding/favicon    -> upload
 *   DELETE /api/developer/tenants/:id/branding/logo       -> remover
 *   DELETE /api/developer/tenants/:id/branding/favicon    -> remover
 *
 * Público (tenant resolvido pelo domínio da requisição):
 *   GET /api/branding          -> JSON com URLs e fallbacks
 *   GET /api/branding/logo     -> arquivo
 *   GET /api/branding/favicon  -> arquivo
 */

const path = require('path');
const multer = require('multer');

const { AppError } = require('../utils/helpers');
const {
  getTenantById,
  getTenantBranding,
  updateTenantLogo,
  updateTenantFavicon,
  logActivity
} = require('../database/coreDatabase');
const {
  ASSETS_DIR,
  isAllowedMime,
  extensionFor,
  tenantAssetsDir,
  storedFilePath,
  removeAssetFile,
  unlinkIfExists,
  sniffMime
} = require('../utils/assetStorage');

const LOGO_LIMIT = 3 * 1024 * 1024;  /* 3 MB */
const FAVICON_LIMIT = 1 * 1024 * 1024;  /* 1 MB */

/* Arquivos padrão atuais da plataforma, usados quando o tenant não tem asset próprio. */
const DEFAULT_ASSET = {
  logo: path.join(__dirname, '..', 'public', 'assets', 'logo.png'),
  favicon: path.join(__dirname, '..', 'public', 'assets', 'favicon.png')
};

function brandingPayload(tenantId) {
  const row = getTenantBranding(tenantId);
  if (!row) return null;
  return {
    ...row,
    has_logo: Boolean(row.logo_path),
    has_favicon: Boolean(row.favicon_path)
  };
}

/* ---------- Upload ---------- */

function multerFor(kind) {
  const limits = kind === 'logo' ? { fileSize: LOGO_LIMIT } : { fileSize: FAVICON_LIMIT };
  return multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        try {
          const tenant = getTenantById(Number(req.params.id));
          if (!tenant) return cb(new AppError(404, 'Empresa não encontrada.'));
          cb(null, tenantAssetsDir(tenant.id));
        } catch (err) {
          cb(err);
        }
      },
      filename(req, file, cb) {
        /* Nome interno controlado; a extensão vem do MIME, nunca do nome enviado. */
        const ext = extensionFor(kind, file.mimetype);
        cb(null, kind + ext);
      }
    }),
    limits,
    fileFilter(req, file, cb) {
      if (!isAllowedMime(kind, file.mimetype)) {
        return cb(
          new AppError(
            400,
            kind === 'logo'
              ? 'Formato de logo inválido. Use PNG, JPG ou WEBP.'
              : 'Formato de favicon inválido. Use PNG ou ICO.'
          )
        );
      }
      cb(null, true);
    }
  }).single('file');
}

/*
 * Remove a versão anterior do asset apenas se for um arquivo diferente do que
 * acabou de ser salvo (com a mesma extensão o multer já sobrescreveu).
 */
function removeOtherVersion(tenantId, kind, keepPath) {
  const old = storedFilePath(tenantId, kind);
  if (old && path.resolve(old) !== path.resolve(keepPath)) {
    unlinkIfExists(old);
  }
}

function uploadAsset(kind) {
  const upload = multerFor(kind);
  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return next(err);

      const tenant = getTenantById(Number(req.params.id));
      if (!tenant) return next(new AppError(404, 'Empresa não encontrada.'));
      if (!req.file) return next(new AppError(400, 'Envie um arquivo.'));

      const savedPath = req.file.path;
      const sniffed = sniffMime(savedPath);
      if (!sniffed || !extensionFor(kind, sniffed)) {
        unlinkIfExists(savedPath);
        return next(
          new AppError(
            400,
            kind === 'logo'
              ? 'O arquivo enviado não é uma imagem válida (PNG, JPG ou WEBP).'
              : 'O arquivo enviado não é um favicon válido (PNG ou ICO).'
          )
        );
      }

      const relPath = path.relative(ASSETS_DIR, savedPath).split(path.sep).join('/');
      try {
        removeOtherVersion(tenant.id, kind, savedPath);
        if (kind === 'logo') updateTenantLogo(tenant.id, relPath);
        else updateTenantFavicon(tenant.id, relPath);
      } catch (dbErr) {
        unlinkIfExists(savedPath);
        return next(dbErr);
      }

      logActivity(
        req.user.id,
        tenant.id,
        kind === 'logo' ? 'BRANDING_LOGO_UPDATED' : 'BRANDING_FAVICON_UPDATED',
        kind === 'logo' ? 'Logo atualizada' : 'Favicon atualizado'
      );
      return res.status(201).json({ success: true, branding: brandingPayload(tenant.id) });
    });
  };
}

/* ---------- Remoção ---------- */

function removeAsset(kind) {
  return (req, res) => {
    const tenant = getTenantById(Number(req.params.id));
    if (!tenant) throw new AppError(404, 'Empresa não encontrada.');

    removeAssetFile(tenant.id, kind);
    if (kind === 'logo') updateTenantLogo(tenant.id, null);
    else updateTenantFavicon(tenant.id, null);

    logActivity(
      req.user.id,
      tenant.id,
      kind === 'logo' ? 'BRANDING_LOGO_REMOVED' : 'BRANDING_FAVICON_REMOVED',
      kind === 'logo' ? 'Logo removida' : 'Favicon removido'
    );
    return res.json({ success: true, branding: brandingPayload(tenant.id) });
  };
}

/* ---------- Leitura ---------- */

function serveFile(res, tenantId, kind) {
  const file = storedFilePath(tenantId, kind);
  if (!file) return res.status(404).json({ error: 'Identidade visual não configurada.' });
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(file);
}

/* Igual a serveFile, mas cai para o arquivo padrão da plataforma quando o
 * tenant não tem asset próprio — usado apenas nas rotas públicas. */
function servePublicFile(res, tenantId, kind) {
  const file = storedFilePath(tenantId, kind);
  if (file) {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(file);
  }
  res.set('Cache-Control', 'public, max-age=3600');
  return res.sendFile(DEFAULT_ASSET[kind]);
}

/* --- Desenvolvedor --- */

function getBrandingHandler(req, res) {
  const tenant = getTenantById(Number(req.params.id));
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  return res.json({ branding: brandingPayload(tenant.id) });
}

function serveAsset(kind) {
  return (req, res) => {
    const tenant = getTenantById(Number(req.params.id));
    if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
    return serveFile(res, tenant.id, kind);
  };
}

/* --- Público (resolve pelo domínio) --- */

function publicBranding(req, res) {
  const t = req.tenantFromDomain;
  if (!t) throw new AppError(404, 'Domínio não cadastrado.');
  const b = brandingPayload(t.id);
  const ts = b ? encodeURIComponent(b.updated_at || '') : '';
  return res.json({
    company_name: t.name,
    browser_title: (b && b.browser_title) || t.name,
    has_logo: Boolean(b && b.logo_path),
    has_favicon: Boolean(b && b.favicon_path),
    logo_url: b && b.logo_path ? `/api/branding/logo?v=${ts}` : null,
    favicon_url: b && b.favicon_path ? `/api/branding/favicon?v=${ts}` : null
  });
}

function publicAsset(kind) {
  return (req, res) => {
    const t = req.tenantFromDomain;
    if (!t) throw new AppError(404, 'Domínio não cadastrado.');
    return servePublicFile(res, t.id, kind);
  };
}

module.exports = {
  getBrandingHandler,
  uploadLogo: uploadAsset('logo'),
  uploadFavicon: uploadAsset('favicon'),
  removeLogo: removeAsset('logo'),
  removeFavicon: removeAsset('favicon'),
  serveLogo: serveAsset('logo'),
  serveFavicon: serveAsset('favicon'),
  publicBranding,
  publicLogo: publicAsset('logo'),
  publicFavicon: publicAsset('favicon')
};
