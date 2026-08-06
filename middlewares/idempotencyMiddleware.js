/*
 * idempotencyMiddleware.js
 *
 * Idempotência dos POST da API pública (/api/v1).
 *
 * O cliente envia o header "Idempotency-Key". A primeira chamada cria um
 * registro (api_idempotency_keys) com o SHA-256 da requisição canônica e
 * executa a operação; no fim, grava o status e o corpo da resposta. Se a
 * MESMA chave chegar de novo:
 *   - requisição idêntica → replay da resposta gravada (sem executar a
 *     operação de negócio outra vez — não duplica agendamento, receita,
 *     consumo de pacote nem evento de WhatsApp);
 *   - corpo diferente → 422, pois a mesma chave não pode representar duas
 *     operações diferentes.
 *
 * Requisitos:
 *   - Exige "Idempotency-Key" em métodos não-GET (exceto quando o header
 *     opcional allowMissing estiver habilitado).
 *   - O body canônico é o JSON do corpo com as chaves ordenadas + método +
 *     path, para detectar intenção igual mesmo com ordens diferentes.
 */

'use strict';

const crypto = require('crypto');
const {
  getApiIdempotencyKey,
  insertApiIdempotencyKey,
  completeApiIdempotencyKey
} = require('../database/coreDatabase');

function canonicalRequest(req) {
  const body = req.body && typeof req.body === 'object' ? JSON.stringify(req.body, Object.keys(req.body).sort()) : 'null';
  return `${req.method} ${req.baseUrl || ''}${req.path || ''} ${body}`;
}

function requestSha(req) {
  return crypto.createHash('sha256').update(canonicalRequest(req)).digest('hex');
}

/* Intercepta res.json para capturar o corpo da resposta. */
function captureBody(res, onBody) {
  const original = res.json.bind(res);
  res.json = (body) => {
    onBody(body);
    return original(body);
  };
  return res;
}

/*
 * Uso: router.post('/appointments', requireApiKey, requireScope('appointments:write'),
 *                  idempotency(), handler)
 */
function idempotency({ allowMissing = false } = {}) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();

    const headerKey = String(req.headers['idempotency-key'] || '').trim();
    if (!headerKey) {
      if (allowMissing) return next();
      return res.status(400).json({
        error: 'Cabeçalho "Idempotency-Key" obrigatório em requisições de escrita. Envie um valor único (ex.: UUID).'
      });
    }
    if (headerKey.length > 128) {
      return res.status(400).json({ error: 'Idempotency-Key muito longa (máximo de 128 caracteres).' });
    }

    const tenantId = req.tenantId;
    const apiKeyId = req.apiKeyId;
    const sha = requestSha(req);

    const existing = getApiIdempotencyKey(tenantId, apiKeyId, headerKey);
    if (existing) {
      if (existing.request_sha !== sha) {
        return res.status(422).json({
          error: 'Idempotency-Key já utilizada com uma requisição diferente. Use uma nova chave.'
        });
      }
      if (existing.status_code != null) {
        const parsed = (() => {
          try {
            return existing.response_body ? JSON.parse(existing.response_body) : null;
          } catch {
            return null;
          }
        })();
        res.status(existing.status_code).json(parsed);
        return undefined;
      }
      /* Operação ainda em andamento: responde 409 "in flight" — o cliente
         pode esperar e repetir. */
      return res.status(409).json({ error: 'Requisição em andamento. Repita a chamada com a mesma chave.' });
    }

    let recordId;
    try {
      insertApiIdempotencyKey({
        tenant_id: tenantId,
        api_key_id: apiKeyId,
        idempotency_key: headerKey,
        method: req.method,
        path: req.originalUrl || req.url,
        request_sha: sha
      });
      recordId = getApiIdempotencyKey(tenantId, apiKeyId, headerKey).id;
    } catch (err) {
      /* Concorrência: outra requisição com a mesma chave ganhou a corrida. */
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ error: 'Requisição em andamento. Repita a chamada com a mesma chave.' });
      }
      throw err;
    }

    let capturedBody = null;
    captureBody(res, (body) => {
      capturedBody = body;
    });

    res.on('finish', () => {
      try {
        completeApiIdempotencyKey(recordId, {
          statusCode: res.statusCode,
          responseBody: capturedBody != null ? JSON.stringify(capturedBody) : null
        });
      } catch (err) {
        console.error('[api] Erro ao completar registro de idempotência:', err.message);
      }
    });

    return next();
  };
}

module.exports = { idempotency, canonicalRequest, requestSha };
