/*
 * webhookRoutes.js
 *
 * Rota pública de recebimento de webhooks da Evolution API.
 *
 * NÃO passa pelos middlewares de autenticação/tenant: a validação é feita
 * pelo token (webhook_token) armazenado por instância, e a identificação
 * instância → empresa é feita dentro do whatsappService.
 *
 * Requisitos atendidos:
 *   - resposta rápida (o serviço só valida, atualiza status e loga);
 *   - rejeição com 401 quando o token não confere;
 *   - desconhecido (instância/evento) responde 200 sem erro para não
 *     causar retry infinito na Evolution.
 */

const express = require('express');
const whatsappService = require('../services/whatsappService');

const router = express.Router();

function handleWebhook(req, res) {
  whatsappService
    .handleWebhook(req.body || {}, req.headers)
    .then((result) => {
      if (result.status && result.status !== 200) {
        return res.status(result.status).json({ error: result.error || 'Rejeitado.' });
      }
      return res.json({ received: true, event: result.event || null });
    })
    .catch(() => res.status(500).json({ error: 'Erro interno ao processar o webhook.' }));
}

/* Aceita GET (verificação simples da Evolution) e POST (eventos). */
router.post('/', handleWebhook);
router.get('/', handleWebhook);

module.exports = router;
