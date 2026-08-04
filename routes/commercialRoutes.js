/*
 * commercialRoutes.js
 *
 * Rotas públicas do site institucional (papicore.com.br): planos comerciais
 * (somente leitura) e o formulário de contato. Montadas em /api/public,
 * ANTES de qualquer middleware de tenant — estas rotas não pertencem a
 * nenhuma empresa e precisam responder mesmo quando o host é o domínio da
 * própria plataforma (sem tenant associado).
 */

const express = require('express');
const commercialController = require('../controllers/commercialController');

const router = express.Router();

/* Rate limit simples por IP: evita flood no formulário de contato. Mesmo
   padrão usado no login do desenvolvedor (routes/developerRoutes.js). */
const contactAttempts = new Map();
function contactRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (contactAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 8) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' });
  }
  recent.push(now);
  contactAttempts.set(key, recent);
  next();
}

router.get('/plans', commercialController.listPublicPlans);
router.post('/contact', contactRateLimit, commercialController.submitLead);

module.exports = router;
