/*
 * siteContentController.js
 *
 * Conteúdo editável do site institucional (papicore.com.br) pelo Painel do
 * Desenvolvedor: vídeo demonstrativo, contato comercial (WhatsApp/e-mail/
 * Instagram) e as imagens da landing page (mockup do hero + galeria de
 * demonstração). Assim que salvo aqui, aparece automaticamente no site —
 * nada é editado direto em arquivo/código.
 *
 * Desenvolvedor (protegido por requireDeveloper):
 *   GET    /api/developer/site-content                 -> textos + imagens
 *   PUT    /api/developer/site-content                  -> salva vídeo/contato
 *   POST   /api/developer/site-content/images/:slot     -> upload de imagem
 *   DELETE /api/developer/site-content/images/:slot     -> remove imagem
 *
 * Público (sem tenant; usado pela landing page):
 *   GET /api/public/site-content                 -> textos + imagens
 *   GET /api/public/site-content/images/:slot     -> arquivo da imagem
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Jimp = require('jimp');

const { AppError, isValidEmail, isValidPhone, normalizePhone } = require('../utils/helpers');
const { getSiteContent, upsertSiteContent, logActivity } = require('../database/coreDatabase');
const {
  platformAssetsDir,
  storedPlatformFilePath,
  removePlatformAssetFile,
  unlinkIfExists,
  sniffMime
} = require('../utils/assetStorage');

/* Favicon/ícones de PWA: caminhos fixos, referenciados por <link> no HTML e
   pelo manifest.webmanifest — por isso, ao contrário dos outros slots, o
   upload deste slot não é só salvo/servido: ele REGRAVA estes arquivos
   estáticos, gerando cada tamanho a partir da imagem enviada. */
const ICONS_DIR = path.join(__dirname, '..', 'public', 'images', 'icons');
const FAVICON_SIZES = [16, 32, 48]; // fundo transparente preservado
const APP_ICON_SIZES = [
  { file: 'apple-touch-icon-180.png', size: 180, padding: 0.16 },
  { file: 'icon-192.png', size: 192, padding: 0.14 },
  { file: 'icon-512.png', size: 512, padding: 0.14 }
];

async function regenerateFaviconFiles(sourcePath) {
  const source = await Jimp.read(sourcePath);
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  for (const size of FAVICON_SIZES) {
    await source.clone().contain(size, size).writeAsync(path.join(ICONS_DIR, `favicon-${size}.png`));
  }

  for (const { file, size, padding } of APP_ICON_SIZES) {
    const pad = Math.round(size * padding);
    const inner = size - pad * 2;
    const resized = source.clone().contain(inner, inner);
    /* iOS/Android não lidam bem com transparência em ícone de app instalado
       (preenchem com preto ou recortam de forma estranha) — fundo branco
       sólido, igual ao ícone atual da plataforma. */
    const canvas = new Jimp(size, size, 0xffffffff);
    canvas.composite(resized, Math.round((size - resized.bitmap.width) / 2), Math.round((size - resized.bitmap.height) / 2));
    await canvas.writeAsync(path.join(ICONS_DIR, file));
  }
}

const IMAGE_LIMIT = 4 * 1024 * 1024; /* 4 MB */

const IMAGE_MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};

/* Slot (usado na URL/no painel) -> prefixo do arquivo em assets/platform/ e
   rótulo exibido no Painel do Desenvolvedor. Prefixo "site_" evita colidir
   com login_logo/login_favicon, que moram na mesma pasta. */
const IMAGE_SLOTS = {
  logo: { assetKind: 'site_logo', label: 'Logo (cabeçalho e rodapé)' },
  favicon: { assetKind: 'site_favicon', label: 'Favicon / ícone do app (PWA)' },
  hero: { assetKind: 'site_hero', label: 'Mockup do hero' },
  demo_agenda: { assetKind: 'site_demo_agenda', label: 'Demonstração — Agenda' },
  demo_servicos: { assetKind: 'site_demo_servicos', label: 'Demonstração — Serviços' },
  demo_unidades: { assetKind: 'site_demo_unidades', label: 'Demonstração — Unidades' },
  demo_financeiro: { assetKind: 'site_demo_financeiro', label: 'Demonstração — Financeiro' },
  demo_painel: { assetKind: 'site_demo_painel', label: 'Demonstração — Painel administrativo' }
};

function slotInfo(slot) {
  const info = IMAGE_SLOTS[slot];
  if (!info) throw new AppError(404, 'Imagem inválida.');
  return info;
}

function imagesPayload(baseUrl) {
  const images = {};
  for (const [slot, info] of Object.entries(IMAGE_SLOTS)) {
    const file = storedPlatformFilePath(info.assetKind);
    images[slot] = {
      label: info.label,
      has: Boolean(file),
      url: file ? `${baseUrl}/images/${slot}?v=${Date.now()}` : null
    };
  }
  return images;
}

function textPayload() {
  const row = getSiteContent();
  return {
    demo_video_url: row.demo_video_url || '',
    contact_whatsapp: row.contact_whatsapp || '',
    contact_email: row.contact_email || '',
    contact_instagram: row.contact_instagram || '',
    updated_at: row.updated_at
  };
}

/* ---------- Leitura ---------- */

function getDeveloperSiteContent(req, res) {
  return res.json({ ...textPayload(), images: imagesPayload('/api/developer/site-content') });
}

function getPublicSiteContent(req, res) {
  return res.json({ ...textPayload(), images: imagesPayload('/api/public/site-content') });
}

/* ---------- Textos (vídeo + contato) ---------- */

function validateAndNormalize(body) {
  const out = {};

  const videoUrl = String(body.demo_video_url || '').trim();
  if (videoUrl && !/^https?:\/\/\S+$/i.test(videoUrl)) {
    throw new AppError(400, 'Informe uma URL de vídeo válida (começando com http:// ou https://) ou deixe em branco.');
  }
  out.demo_video_url = videoUrl || null;

  const whatsapp = normalizePhone(body.contact_whatsapp || '');
  if (whatsapp && !isValidPhone(whatsapp)) {
    throw new AppError(400, 'Informe um WhatsApp válido, com DDD, ou deixe em branco.');
  }
  out.contact_whatsapp = whatsapp || null;

  const email = String(body.contact_email || '').trim();
  if (email && !isValidEmail(email)) {
    throw new AppError(400, 'Informe um e-mail válido ou deixe em branco.');
  }
  out.contact_email = email || null;

  const instagram = String(body.contact_instagram || '').trim().replace(/^@/, '').slice(0, 60);
  out.contact_instagram = instagram || null;

  return out;
}

function updateSiteContent(req, res) {
  const data = validateAndNormalize(req.body || {});
  upsertSiteContent(data);
  logActivity(req.user.id, null, 'SITE_CONTENT_UPDATED', 'Vídeo/contato do site institucional atualizados');
  return res.json({ success: true, ...textPayload(), images: imagesPayload('/api/developer/site-content') });
}

/* ---------- Imagens ---------- */

function uploadSiteImage(req, res, next) {
  const slot = req.params.slot;
  let info;
  try {
    info = slotInfo(slot);
  } catch (err) {
    return next(err);
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination(r, file, cb) {
        try { cb(null, platformAssetsDir()); } catch (err) { cb(err); }
      },
      filename(r, file, cb) {
        const ext = IMAGE_MIME_EXT[file.mimetype];
        cb(null, info.assetKind + ext);
      }
    }),
    limits: { fileSize: IMAGE_LIMIT },
    fileFilter(r, file, cb) {
      if (!IMAGE_MIME_EXT[file.mimetype]) {
        return cb(new AppError(400, 'Formato de imagem inválido. Use PNG, JPG ou WEBP.'));
      }
      cb(null, true);
    }
  }).single('file');

  upload(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return next(new AppError(400, 'Envie um arquivo.'));

    const savedPath = req.file.path;
    const sniffed = sniffMime(savedPath);
    if (!sniffed || !IMAGE_MIME_EXT[sniffed]) {
      unlinkIfExists(savedPath);
      return next(new AppError(400, 'O arquivo enviado não é uma imagem válida (PNG, JPG ou WEBP).'));
    }

    /* Remove uma versão anterior com extensão diferente (mesma extensão o
       multer já sobrescreveu). */
    const old = storedPlatformFilePath(info.assetKind);
    if (old && path.resolve(old) !== path.resolve(savedPath)) unlinkIfExists(old);

    /* O favicon/ícone de PWA é lido pelo navegador em caminhos fixos
       (<link rel="icon">, manifest.webmanifest) — regrava esses arquivos a
       partir da imagem enviada, em todos os tamanhos usados pelo site. */
    if (slot === 'favicon') {
      try {
        await regenerateFaviconFiles(savedPath);
      } catch (genErr) {
        console.error('[siteContent] Falha ao gerar favicon/ícones:', genErr.message);
        return next(new AppError(400, 'Não foi possível processar essa imagem como favicon. Tente outro arquivo.'));
      }
    }

    logActivity(req.user.id, null, 'SITE_IMAGE_UPDATED', `Imagem "${info.label}" do site institucional atualizada`);
    return res.status(201).json({ success: true, images: imagesPayload('/api/developer/site-content') });
  });
}

function removeSiteImage(req, res) {
  const info = slotInfo(req.params.slot);
  removePlatformAssetFile(info.assetKind);
  logActivity(req.user.id, null, 'SITE_IMAGE_REMOVED', `Imagem "${info.label}" do site institucional removida`);
  return res.json({ success: true, images: imagesPayload('/api/developer/site-content') });
}

function serveSiteImage(req, res) {
  const info = slotInfo(req.params.slot);
  const file = storedPlatformFilePath(info.assetKind);
  if (!file) return res.status(404).json({ error: 'Imagem não configurada.' });
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(file);
}

module.exports = {
  getDeveloperSiteContent,
  getPublicSiteContent,
  updateSiteContent,
  uploadSiteImage,
  removeSiteImage,
  serveSiteImage
};
