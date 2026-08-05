/*
 * passwordResetService.js
 *
 * Núcleo do fluxo de recuperação de senha: geração do token (aleatório,
 * armazenado só como hash) e construção da URL de redefinição.
 * Orquestração de banco + e-mail fica no controller
 * (controllers/passwordResetController.js).
 */

const crypto = require('crypto');

const TTL_MINUTES = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES) || 30;

/* Token puro (vai no link, nunca é salvo) + hash SHA-256 (salvo no banco). */
function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenExpiresAt() {
  return new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();
}

function isTokenExpired(row) {
  return new Date(row.expires_at).getTime() < Date.now();
}

/*
 * O link sempre usa o domínio da própria requisição (já validado por
 * resolveTenantByHost contra tenant_domains) — nunca uma URL base separada.
 * Isso garante que o link de recuperação aponta para o mesmo domínio que o
 * usuário usou para solicitá-lo.
 */
function buildResetUrl(req, token) {
  const domain = req.tenantFromDomain && req.tenantFromDomain.domain;
  const protocol = req.protocol === 'https' || process.env.NODE_ENV === 'production' ? 'https' : req.protocol || 'http';
  return `${protocol}://${domain}/admin/redefinir-senha?token=${token}`;
}

module.exports = {
  TTL_MINUTES,
  generateToken,
  hashToken,
  tokenExpiresAt,
  isTokenExpired,
  buildResetUrl
};
