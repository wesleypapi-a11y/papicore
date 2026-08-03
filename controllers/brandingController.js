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
 * Aba Aparência do admin do tenant (protegida por requireAuth + tenantMiddleware;
 * o tenant é sempre o do usuário autenticado, nunca vindo da URL/body):
 *   GET    /api/admin/branding            -> metadados + cores + temas disponíveis
 *   PUT    /api/admin/branding/theme      -> aplica um preset de tema (utils/themePresets.js)
 *   GET    /api/admin/branding/logo       -> arquivo
 *   GET    /api/admin/branding/favicon    -> arquivo
 *   POST   /api/admin/branding/logo       -> upload
 *   POST   /api/admin/branding/favicon    -> upload
 *   DELETE /api/admin/branding/logo       -> remover
 *   DELETE /api/admin/branding/favicon    -> remover
 *
 * Público (tenant resolvido pelo domínio da requisição):
 *   GET /api/branding          -> JSON com URLs e fallbacks
 *   GET /api/branding/logo     -> arquivo
 *   GET /api/branding/favicon  -> arquivo
 *
 * Logo e favicon da tela de login do painel do desenvolvedor (não são de
 * nenhum tenant):
 *   GET    /api/developer/login-logo                -> arquivo (público, sem auth)
 *   GET    /api/developer/login-favicon             -> arquivo (público, sem auth)
 *   GET    /api/developer/settings/login-logo        -> metadados (developer)
 *   POST   /api/developer/settings/login-logo        -> upload (developer)
 *   DELETE /api/developer/settings/login-logo        -> remover (developer)
 *   GET    /api/developer/settings/login-favicon     -> metadados (developer)
 *   POST   /api/developer/settings/login-favicon     -> upload (developer)
 *   DELETE /api/developer/settings/login-favicon     -> remover (developer)
 */

const path = require('path');
const multer = require('multer');

const { AppError } = require('../utils/helpers');
const {
  getTenantById,
  getTenantBranding,
  upsertTenantBranding,
  updateTenantLogo,
  updateTenantFavicon,
  logActivity
} = require('../database/coreDatabase');
const {
  THEME_PRESETS,
  THEME_KEYS,
  DEFAULT_THEME_KEY,
  getThemePreset,
  getDefaultThemePreset
} = require('../utils/themePresets');
const {
  ASSETS_DIR,
  isAllowedMime,
  extensionFor,
  tenantAssetsDir,
  storedFilePath,
  removeAssetFile,
  unlinkIfExists,
  sniffMime,
  platformAssetsDir,
  storedPlatformFilePath,
  removePlatformAssetFile
} = require('../utils/assetStorage');

const LOGO_LIMIT = 3 * 1024 * 1024;  /* 3 MB */
const FAVICON_LIMIT = 1 * 1024 * 1024;  /* 1 MB */

/* Arquivos padrão atuais da plataforma, usados quando o tenant não tem asset próprio. */
const DEFAULT_ASSET = {
  logo: path.join(__dirname, '..', 'public', 'assets', 'logo.png'),
  favicon: path.join(__dirname, '..', 'public', 'assets', 'favicon.png')
};

/* Chaves internas dos assets de plataforma (tela de login do painel do
   desenvolvedor em papicore.com.br/desenvolvedor). */
const LOGIN_LOGO_KIND = 'login_logo';
const LOGIN_FAVICON_KIND = 'login_favicon';
const LOGIN_ASSET_KINDS = {
  logo: LOGIN_LOGO_KIND,
  favicon: LOGIN_FAVICON_KIND
};

/* Mapeia as chaves do preset (utils/themePresets.js) para as colunas de
   tenant_branding onde cada cor fica gravada. */
const COLOR_COLUMN_BY_KEY = {
  primary: 'primary_color',
  secondary: 'secondary_color',
  accent: 'accent_color',
  background: 'background_color',
  surface: 'surface_color',
  text: 'text_color',
  muted: 'muted_color',
  border: 'border_color',
  success: 'success_color',
  danger: 'danger_color'
};
const COLOR_KEYS = Object.keys(COLOR_COLUMN_BY_KEY);

/*
 * Resolve as cores efetivas do tenant: usa o que está gravado nas colunas
 * (snapshot do preset aplicado em PUT /theme); se o tenant nunca salvou tema
 * (linha nova ou colunas vazias), cai para o preset padrão (Torque Orange)
 * sem gravar nada — a página pública/admin sempre recebe um objeto de cores
 * completo, nunca parcial.
 */
function resolvedColors(row) {
  const fallback = getDefaultThemePreset().colors;
  const colors = {};
  for (const key of COLOR_KEYS) {
    const column = COLOR_COLUMN_BY_KEY[key];
    colors[key] = (row && row[column]) || fallback[key];
  }
  return colors;
}

function resolvedThemeKey(row) {
  return (row && row.theme_key && THEME_KEYS.includes(row.theme_key)) ? row.theme_key : DEFAULT_THEME_KEY;
}

function brandingPayload(tenantId) {
  const row = getTenantBranding(tenantId);
  return {
    has_logo: Boolean(row && row.logo_path),
    has_favicon: Boolean(row && row.favicon_path),
    browser_title: (row && row.browser_title) || null,
    theme_key: resolvedThemeKey(row),
    colors: resolvedColors(row),
    updated_at: row ? row.updated_at : null
  };
}

/* ---------- Resolução do tenant ---------- */

/* Desenvolvedor: id da empresa vem da URL (rota já protegida por
   requireDeveloper). */
function tenantFromParam(req) {
  const tenant = getTenantById(Number(req.params.id));
  if (!tenant) throw new AppError(404, 'Empresa não encontrada.');
  return tenant;
}

/* Admin do próprio tenant: o id vem sempre de req.tenant, resolvido pelo
   tenantMiddleware a partir do usuário autenticado — nunca de parâmetros ou
   do corpo da requisição, então um admin nunca consegue alterar outro
   tenant. */
function tenantFromAuth(req) {
  return req.tenant;
}

/* ---------- Upload ---------- */

function multerFor(kind, resolveTenant) {
  const limits = kind === 'logo' ? { fileSize: LOGO_LIMIT } : { fileSize: FAVICON_LIMIT };
  return multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        try {
          const tenant = resolveTenant(req);
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

function uploadAsset(kind, resolveTenant, actionName) {
  const upload = multerFor(kind, resolveTenant);
  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) return next(err);

      let tenant;
      try {
        tenant = resolveTenant(req);
      } catch (resolveErr) {
        return next(resolveErr);
      }
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
        actionName.updated,
        kind === 'logo' ? 'Logo atualizada' : 'Favicon atualizado'
      );
      return res.status(201).json({ success: true, branding: brandingPayload(tenant.id) });
    });
  };
}

/* ---------- Remoção ---------- */

function removeAsset(kind, resolveTenant, actionName) {
  return (req, res) => {
    const tenant = resolveTenant(req);

    removeAssetFile(tenant.id, kind);
    if (kind === 'logo') updateTenantLogo(tenant.id, null);
    else updateTenantFavicon(tenant.id, null);

    logActivity(
      req.user.id,
      tenant.id,
      actionName.removed,
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

/* --- Desenvolvedor / Admin do tenant --- */

function getBrandingHandler(resolveTenant, opts = {}) {
  return (req, res) => {
    const tenant = resolveTenant(req);
    const payload = { branding: brandingPayload(tenant.id) };
    if (opts.includeThemes) payload.available_themes = THEME_PRESETS;
    /* Para o painel do desenvolvedor, devolve as URLs de arquivo protegidas do
       próprio developer (nunca /api/branding, que resolve o tenant pelo host).
       O ?v=updated_at quebra o cache de 1 ano das rotas de arquivo. */
    if (opts.developerUrls) {
      const b = payload.branding;
      const ts = encodeURIComponent(b.updated_at || '');
      b.logo_url = b.has_logo ? `/api/developer/tenants/${tenant.id}/branding/logo?v=${ts}` : null;
      b.favicon_url = b.has_favicon ? `/api/developer/tenants/${tenant.id}/branding/favicon?v=${ts}` : null;
    }
    return res.json(payload);
  };
}

function serveAsset(kind, resolveTenant) {
  return (req, res) => {
    const tenant = resolveTenant(req);
    return serveFile(res, tenant.id, kind);
  };
}

/*
 * PUT /api/admin/branding/theme — troca o preset de cores do tenant. Só
 * aceita theme_key de utils/themePresets.js (nenhuma cor arbitrária nesta
 * versão); grava o snapshot completo das cores do preset nas colunas de
 * tenant_branding para que a resolução de branding não dependa de o preset
 * continuar existindo/igual no futuro.
 */
function updateTheme(req, res) {
  const tenant = tenantFromAuth(req);
  const themeKey = String((req.body && req.body.theme_key) || '').trim();
  const preset = getThemePreset(themeKey);
  if (!preset) throw new AppError(400, 'Tema inválido.');

  const fields = { theme_key: preset.key };
  for (const key of COLOR_KEYS) fields[COLOR_COLUMN_BY_KEY[key]] = preset.colors[key];
  upsertTenantBranding(tenant.id, fields);

  logActivity(req.user.id, tenant.id, 'TENANT_THEME_UPDATED', preset.key);
  return res.json({ success: true, branding: brandingPayload(tenant.id) });
}

/* --- Público (resolve pelo domínio) --- */

function publicBranding(req, res) {
  const t = req.tenantFromDomain;
  if (!t) throw new AppError(404, 'Domínio não cadastrado.');
  const b = brandingPayload(t.id);
  const ts = encodeURIComponent(b.updated_at || '');
  return res.json({
    company_name: t.name,
    browser_title: b.browser_title || t.name,
    has_logo: b.has_logo,
    has_favicon: b.has_favicon,
    logo_url: b.has_logo ? `/api/branding/logo?v=${ts}` : null,
    favicon_url: b.has_favicon ? `/api/branding/favicon?v=${ts}` : null,
    theme_key: b.theme_key,
    colors: b.colors
  });
}

function publicAsset(kind) {
  return (req, res) => {
    const t = req.tenantFromDomain;
    if (!t) throw new AppError(404, 'Domínio não cadastrado.');
    return servePublicFile(res, t.id, kind);
  };
}

/* --- Logo/favicon da tela de login do desenvolvedor (assets da plataforma) --- */

function loginAssetKind(kind) {
  const internal = LOGIN_ASSET_KINDS[kind];
  if (!internal) throw new Error('Tipo de asset da plataforma inválido.');
  return internal;
}

function loginAssetPayload(kind) {
  const has = Boolean(storedPlatformFilePath(loginAssetKind(kind)));
  return kind === 'favicon'
    ? { has_favicon: has, favicon_url: has ? `/api/developer/login-favicon?v=${Date.now()}` : null }
    : { has_logo: has, logo_url: has ? `/api/developer/login-logo?v=${Date.now()}` : null };
}

function getLoginAssetHandler(kind) {
  return (req, res) => res.json(loginAssetPayload(kind));
}

function uploadLoginAsset(kind) {
  const limit = kind === 'logo' ? LOGO_LIMIT : FAVICON_LIMIT;
  const internal = loginAssetKind(kind);
  return (req, res, next) => {
    const upload = multer({
      storage: multer.diskStorage({
        destination(req, file, cb) {
          try {
            cb(null, platformAssetsDir());
          } catch (err) {
            cb(err);
          }
        },
        filename(req, file, cb) {
          const ext = extensionFor(kind, file.mimetype);
          cb(null, internal + ext);
        }
      }),
      limits: { fileSize: limit },
      fileFilter(req, file, cb) {
        if (!isAllowedMime(kind, file.mimetype)) {
          return cb(new AppError(400, kind === 'logo'
            ? 'Formato inválido. Use PNG, JPG ou WEBP.'
            : 'Formato inválido. Use PNG ou ICO.'));
        }
        cb(null, true);
      }
    }).single('file');

    upload(req, res, (err) => {
      if (err) return next(err);
      if (!req.file) return next(new AppError(400, 'Envie um arquivo.'));

      const savedPath = req.file.path;
      const sniffed = sniffMime(savedPath);
      if (!sniffed || !extensionFor(kind, sniffed)) {
        unlinkIfExists(savedPath);
        return next(new AppError(400, kind === 'logo'
          ? 'O arquivo enviado não é uma imagem válida (PNG, JPG ou WEBP).'
          : 'O arquivo enviado não é um favicon válido (PNG ou ICO).'));
      }

      /* Remove uma versão anterior com extensão diferente (o multer já
         sobrescreveu quando a extensão é igual). */
      const old = storedPlatformFilePath(internal);
      if (old && path.resolve(old) !== path.resolve(savedPath)) unlinkIfExists(old);

      logActivity(
        req.user.id,
        null,
        kind === 'logo' ? 'PLATFORM_LOGIN_LOGO_UPDATED' : 'PLATFORM_LOGIN_FAVICON_UPDATED',
        kind === 'logo'
          ? 'Logo da tela de login do desenvolvedor atualizada'
          : 'Favicon da tela de login do desenvolvedor atualizado'
      );
      return res.status(201).json({ success: true, ...loginAssetPayload(kind) });
    });
  };
}

function removeLoginAsset(kind) {
  return (req, res) => {
    removePlatformAssetFile(loginAssetKind(kind));
    logActivity(
      req.user.id,
      null,
      kind === 'logo' ? 'PLATFORM_LOGIN_LOGO_REMOVED' : 'PLATFORM_LOGIN_FAVICON_REMOVED',
      kind === 'logo'
        ? 'Logo da tela de login do desenvolvedor removida'
        : 'Favicon da tela de login do desenvolvedor removido'
    );
    return res.json({ success: true, ...loginAssetPayload(kind) });
  };
}

function serveLoginAsset(kind) {
  return (req, res) => {
    const file = storedPlatformFilePath(loginAssetKind(kind));
    res.set('Cache-Control', 'no-cache');
    const fallback = kind === 'favicon' ? DEFAULT_ASSET.favicon : DEFAULT_ASSET.logo;
    return res.sendFile(file || fallback);
  };
}

/* Ações de log distintas por origem: BRANDING_* quando é o desenvolvedor
   alterando pelo painel dele, TENANT_* quando é o próprio admin da empresa
   alterando pela aba Aparência. */
const DEV_LOGO_ACTIONS = { updated: 'BRANDING_LOGO_UPDATED', removed: 'BRANDING_LOGO_REMOVED' };
const DEV_FAVICON_ACTIONS = { updated: 'BRANDING_FAVICON_UPDATED', removed: 'BRANDING_FAVICON_REMOVED' };
const TENANT_LOGO_ACTIONS = { updated: 'TENANT_LOGO_UPDATED', removed: 'TENANT_LOGO_REMOVED' };
const TENANT_FAVICON_ACTIONS = { updated: 'TENANT_FAVICON_UPDATED', removed: 'TENANT_FAVICON_REMOVED' };

module.exports = {
  /* --- Desenvolvedor (painel do desenvolvedor, tenant pela URL) --- */
  getBrandingHandler: getBrandingHandler(tenantFromParam),
  getDeveloperBranding: getBrandingHandler(tenantFromParam, { developerUrls: true }),
  uploadLogo: uploadAsset('logo', tenantFromParam, DEV_LOGO_ACTIONS),
  uploadFavicon: uploadAsset('favicon', tenantFromParam, DEV_FAVICON_ACTIONS),
  removeLogo: removeAsset('logo', tenantFromParam, DEV_LOGO_ACTIONS),
  removeFavicon: removeAsset('favicon', tenantFromParam, DEV_FAVICON_ACTIONS),
  serveLogo: serveAsset('logo', tenantFromParam),
  serveFavicon: serveAsset('favicon', tenantFromParam),

  /* --- Admin do tenant (aba Aparência, tenant pelo usuário autenticado) --- */
  getAdminBranding: getBrandingHandler(tenantFromAuth, { includeThemes: true }),
  updateAdminTheme: updateTheme,
  uploadAdminLogo: uploadAsset('logo', tenantFromAuth, TENANT_LOGO_ACTIONS),
  uploadAdminFavicon: uploadAsset('favicon', tenantFromAuth, TENANT_FAVICON_ACTIONS),
  removeAdminLogo: removeAsset('logo', tenantFromAuth, TENANT_LOGO_ACTIONS),
  removeAdminFavicon: removeAsset('favicon', tenantFromAuth, TENANT_FAVICON_ACTIONS),
  serveAdminLogo: serveAsset('logo', tenantFromAuth),
  serveAdminFavicon: serveAsset('favicon', tenantFromAuth),

  /* --- Público (resolve pelo domínio) --- */
  publicBranding,
  publicLogo: publicAsset('logo'),
  publicFavicon: publicAsset('favicon'),

  /* --- Login do painel do desenvolvedor (assets da plataforma) --- */
  getLoginLogoHandler: getLoginAssetHandler('logo'),
  uploadLoginLogo: uploadLoginAsset('logo'),
  removeLoginLogo: removeLoginAsset('logo'),
  serveLoginLogo: serveLoginAsset('logo'),
  getLoginFaviconHandler: getLoginAssetHandler('favicon'),
  uploadLoginFavicon: uploadLoginAsset('favicon'),
  removeLoginFavicon: removeLoginAsset('favicon'),
  serveLoginFavicon: serveLoginAsset('favicon')
};
