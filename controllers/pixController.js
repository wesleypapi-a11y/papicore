/*
 * pixController.js
 *
 * Configuração do pagamento via Pix por empresa (tenant):
 *   - imagem do QR Code final (enviada pelo admin);
 *   - a chave "copia e cola" e o nome do recebedor ficam em company_settings
 *     e são gravados pelo settingsController (PUT /api/admin/settings).
 *
 * Admin do tenant (protegida por requireAuth + tenantMiddleware; o tenant é
 * sempre o do usuário autenticado):
 *   POST   /api/admin/settings/pix-qr  -> upload do QR Code
 *   DELETE /api/admin/settings/pix-qr  -> remover QR Code
 *
 * Público (tenant resolvido pelo domínio da requisição):
 *   GET /api/payment/pix-qr -> arquivo da imagem
 *
 * O arquivo fica em assets/tenant_XXXX/pix_qr.<png|jpg|webp> (mesma estrutura
 * de logo/favicon). A presença do arquivo em disco é a fonte da verdade — nada
 * é gravado no banco aqui, porque o multer conclui o upload de forma
 * assíncrona e o contexto AsyncLocalStorage do tenant não sobrevive até o
 * callback (diferente do logo/favicon, que gravam no banco central global).
 */

const path = require('path');
const multer = require('multer');

const { AppError } = require('../utils/helpers');
const { logActivity } = require('../database/coreDatabase');
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

const PIX_QR_KIND = 'pix_qr';
const PIX_QR_LIMIT = 3 * 1024 * 1024; /* 3 MB */

/* Cache-buster com Date.now(): as rotas de arquivo usam Cache-Control de 1 ano
   e o ?v= quebra o cache a cada novo upload. */
function pixQrPayload(hasQr) {
  return {
    has_pix_qr: hasQr,
    pix_qr_url: hasQr ? `/api/payment/pix-qr?v=${Date.now()}` : null
  };
}

function uploadPixQr(req, res, next) {
  const upload = multer({
    storage: multer.diskStorage({
      destination(q, file, cb) {
        try {
          cb(null, tenantAssetsDir(req.tenant.id));
        } catch (err) {
          cb(err);
        }
      },
      filename(q, file, cb) {
        /* Nome interno controlado; a extensão vem do MIME, nunca do nome enviado. */
        const ext = extensionFor(PIX_QR_KIND, file.mimetype);
        cb(null, PIX_QR_KIND + ext);
      }
    }),
    limits: { fileSize: PIX_QR_LIMIT },
    fileFilter(q, file, cb) {
      if (!isAllowedMime(PIX_QR_KIND, file.mimetype)) {
        return cb(new AppError(400, 'Formato de QR Code inválido. Use PNG, JPG ou WEBP.'));
      }
      cb(null, true);
    }
  }).single('file');

  upload(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return next(new AppError(400, 'Envie um arquivo.'));

    const savedPath = req.file.path;
    const sniffed = sniffMime(savedPath);
    if (!sniffed || !extensionFor(PIX_QR_KIND, sniffed)) {
      unlinkIfExists(savedPath);
      return next(
        new AppError(400, 'O arquivo enviado não é uma imagem válida (PNG, JPG ou WEBP).')
      );
    }

    /* Remove a versão anterior apenas se for outro arquivo (com a mesma
       extensão o multer já sobrescreveu). */
    const old = storedFilePath(req.tenant.id, PIX_QR_KIND);
    if (old && path.resolve(old) !== path.resolve(savedPath)) unlinkIfExists(old);

    logActivity(req.user.id, req.tenant.id, 'TENANT_PIX_QR_UPDATED', 'QR Code Pix atualizado');
    return res.status(201).json({ success: true, ...pixQrPayload(true) });
  });
}

function removePixQr(req, res) {
  removeAssetFile(req.tenant.id, PIX_QR_KIND);
  logActivity(req.user.id, req.tenant.id, 'TENANT_PIX_QR_REMOVED', 'QR Code Pix removido');
  return res.json({ success: true, ...pixQrPayload(false) });
}

function publicPixQr(req, res) {
  const t = req.tenantFromDomain;
  if (!t) throw new AppError(404, 'Domínio não cadastrado.');
  const file = storedFilePath(t.id, PIX_QR_KIND);
  if (!file) return res.status(404).json({ error: 'QR Code Pix não configurado.' });
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.sendFile(file);
}

module.exports = { uploadPixQr, removePixQr, publicPixQr };
