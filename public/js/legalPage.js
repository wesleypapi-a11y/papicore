/*
 * legalPage.js
 *
 * Página pública permanente de um documento legal do tenant atual
 * (/termos-de-uso ou /aviso-de-privacidade, ver body[data-doc-key]). Busca o
 * conteúdo já resolvido para a empresa (nome, dados cadastrais, versão) em
 * /api/legal/documents/:key — a mesma rota usada pelos modais do agendamento.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* Texto puro (nunca HTML) vindo do servidor: quebras duplas separam seções,
     uma linha "N. Título" no início de uma seção vira subtítulo. Sempre
     escapado antes de ir para innerHTML — impossível injetar script aqui. */
  function renderBlocks(content) {
    const blocks = String(content || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    return blocks.map((block) => {
      const lines = block.split('\n');
      const isHeading = /^\d+\.\s+\S/.test(lines[0]);
      if (isHeading && lines.length > 1) {
        const title = escapeHtml(lines[0]);
        const body = lines.slice(1).map((l) => `<p>${escapeHtml(l)}</p>`).join('');
        return `<h2>${title}</h2>${body}`;
      }
      return lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
    }).join('');
  }

  function formatDateBR(dateStr) {
    if (!dateStr) return '';
    const d = new Date(String(dateStr).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('pt-BR');
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Não foi possível carregar esta página no momento.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function boot() {
    const docKey = document.body.dataset.docKey;
    const card = $('legalDocCard');

    let settings = {};
    try {
      settings = await fetchJson('/api/settings');
    } catch (err) {
      settings = {};
    }
    if (window.loadTenantBranding) {
      try { await window.loadTenantBranding(); } catch (err) { /* fallback silencioso */ }
    }

    if (settings.company_name) {
      $('brandName').textContent = settings.company_name;
      const footerName = $('footerCompanyName');
      if (footerName) footerName.textContent = settings.company_name;
    }
    const phone = settings.whatsapp || settings.phone || '';
    if (phone) {
      const footerPhone = $('footerPhone');
      if (footerPhone) footerPhone.textContent = phone;
      const digitsOnly = String(phone).replace(/\D/g, '');
      const wa = $('footerWa');
      if (wa && digitsOnly) {
        wa.href = `https://wa.me/${digitsOnly}`;
        wa.hidden = false;
      }
    }

    try {
      const doc = await fetchJson(`/api/legal/documents/${docKey}`);
      document.title = settings.company_name ? `${doc.title} | ${settings.company_name}` : doc.title;
      card.innerHTML = `
        <h1>${escapeHtml(doc.title)}</h1>
        <p class="legal-doc-meta">Versão ${escapeHtml(doc.version)}${doc.effective_at ? ' · vigente desde ' + escapeHtml(formatDateBR(doc.effective_at)) : ''}</p>
        <div class="legal-doc-body">${renderBlocks(doc.content)}</div>
      `;
    } catch (err) {
      card.innerHTML = `<div class="error-box">${escapeHtml(err.message || 'Não foi possível carregar este documento no momento.')}</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
