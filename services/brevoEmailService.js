/*
 * brevoEmailService.js
 *
 * Envio de e-mails transacionais via API da Brevo (https://api.brevo.com).
 * Usado hoje só pela recuperação de senha do painel administrativo dos
 * tenants (services/passwordResetService.js + controllers/passwordResetController.js).
 *
 * Configuração efetiva: banco central (platform_email_settings, editável em
 * Painel do Desenvolvedor > Configurações) com fallback para variáveis de
 * ambiente (BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME,
 * EMAIL_ENABLED) quando a linha do banco não existir ou o campo estiver
 * vazio. Nunca loga a API key nem devolve a configuração para quem chama.
 */

const { getPlatformEmailSettings } = require('../database/coreDatabase');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function effectiveSettings() {
  const stored = getPlatformEmailSettings();
  const enabled = stored && stored.enabled !== undefined && stored.enabled !== null
    ? Boolean(stored.enabled)
    : String(process.env.EMAIL_ENABLED || '').toLowerCase() === 'true';
  const apiKey = (stored && stored.brevo_api_key) || String(process.env.BREVO_API_KEY || '').trim();
  const senderEmail = (stored && stored.brevo_sender_email) || String(process.env.BREVO_SENDER_EMAIL || '').trim();
  const senderName = (stored && stored.brevo_sender_name) || String(process.env.BREVO_SENDER_NAME || '').trim() || 'PapiCore';
  return { enabled, apiKey, senderEmail, senderName };
}

function isConfigured() {
  const { enabled, apiKey, senderEmail } = effectiveSettings();
  return Boolean(enabled && apiKey && senderEmail);
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildPasswordResetContent({ tenantName, resetUrl }) {
  const subject = `Redefinição de senha — ${tenantName}`;
  const text = [
    'Olá,',
    '',
    `Recebemos uma solicitação para redefinir a senha de acesso ao painel da ${tenantName}.`,
    '',
    `Redefinir minha senha: ${resetUrl}`,
    '',
    'Este link expira em 30 minutos.',
    '',
    'Caso você não tenha solicitado a alteração, ignore esta mensagem.',
    '',
    'PapiCore'
  ].join('\n');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
      <p>Olá,</p>
      <p>Recebemos uma solicitação para redefinir a senha de acesso ao painel da <strong>${escapeHtml(tenantName)}</strong>.</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${escapeHtml(resetUrl)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">
          Redefinir minha senha
        </a>
      </p>
      <p>Este link expira em 30 minutos.</p>
      <p>Caso você não tenha solicitado a alteração, ignore esta mensagem.</p>
      <p style="color:#666;font-size:13px;margin-top:32px;">PapiCore</p>
    </div>
  `;

  return { subject, text, html };
}

/*
 * Envia o e-mail de recuperação de senha. Nunca lança: em qualquer cenário
 * (não configurado, erro de rede, erro da API) retorna um objeto de
 * resultado para o chamador decidir o que logar — a resposta ao usuário
 * final permanece sempre genérica, independente do resultado.
 */
async function sendPasswordResetEmail({ to, toName, tenantName, resetUrl }) {
  const settings = effectiveSettings();

  if (!settings.enabled || !settings.apiKey || !settings.senderEmail) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[password-reset][dev] E-mail não enviado (Brevo não configurada). Link de teste: ${resetUrl}`);
    }
    return { skipped: true, reason: 'not_configured' };
  }

  const { subject, text, html } = buildPasswordResetContent({ tenantName, resetUrl });

  try {
    const response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': settings.apiKey
      },
      body: JSON.stringify({
        sender: { name: settings.senderName, email: settings.senderEmail },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
        textContent: text
      })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const message = (data && data.message) || `HTTP ${response.status}`;
      console.error(`[brevo] Falha ao enviar e-mail de recuperação: ${message}`);
      return { error: true, status: response.status };
    }
    return { ok: true };
  } catch (err) {
    console.error('[brevo] Falha ao enviar e-mail de recuperação:', err.message);
    return { error: true };
  }
}

module.exports = { isConfigured, sendPasswordResetEmail };
