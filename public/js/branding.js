/*
 * branding.js
 *
 * Aplica a identidade visual do tenant (logo e favicon enviados pelo
 * desenvolvedor) nas páginas públicas e administrativas do cliente.
 *
 * Só sobrescreve logo/favicon quando o tenant realmente tem um asset próprio
 * cadastrado (has_logo / has_favicon) — sem isso, a página mantém o que já
 * está no HTML (padrão da plataforma ou a logo configurada pelo próprio
 * cliente em Configurações), então falhas de rede ou domínios sem tenant
 * (ex.: papicore.com.br) não quebram nada.
 *
 * Título da aba: só é alterado quando a página declara
 * <meta name="tenant-title-suffix" content="..."> — páginas que já montam o
 * próprio título dinamicamente (ex.: index.html via /api/settings) não usam
 * essa meta tag e ficam como estão.
 *
 * Cada página chama window.loadTenantBranding() explicitamente, sempre por
 * último no próprio fluxo de inicialização (depois de aplicar os dados de
 * /api/settings) — assim a logo enviada pelo desenvolvedor tem prioridade
 * sobre a logo padrão/configurada pelo cliente, sem depender da ordem de
 * chegada de duas requisições concorrentes.
 */
(function () {
  async function loadTenantBranding() {
    let branding = null;
    try {
      const res = await fetch('/api/branding');
      if (res.ok) branding = await res.json();
    } catch (err) {
      /* fallback silencioso: mantém logo, favicon e título padrão */
      return null;
    }
    if (!branding) return null;

    if (branding.has_logo && branding.logo_url) {
      document.querySelectorAll('[data-tenant-logo]').forEach((img) => {
        img.src = branding.logo_url;
      });
    }

    if (branding.has_favicon && branding.favicon_url) {
      const link = document.getElementById('pageFavicon');
      if (link) link.href = branding.favicon_url;
    }

    const titleMeta = document.querySelector('meta[name="tenant-title-suffix"]');
    if (titleMeta && branding.company_name) {
      const suffix = titleMeta.getAttribute('content') || '';
      document.title = suffix ? `${branding.company_name} | ${suffix}` : branding.company_name;
    }

    return branding;
  }

  window.loadTenantBranding = loadTenantBranding;
})();
