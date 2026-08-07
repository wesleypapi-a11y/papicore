/*
 * branding.js
 *
 * Aplica a identidade visual do tenant (logo, favicon e tema de cores) nas
 * páginas públicas e administrativas do cliente.
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
 * Tema de cores: GET /api/branding sempre retorna um objeto `colors`
 * completo (com fallback para o tema PapiCore Orange no backend), então
 * applyTenantTheme só precisa setar as variáveis --tenant-* no <html> — o
 * CSS já usa essas variáveis com fallback próprio para o caso de falha de
 * rede (a página nunca fica sem estilo).
 *
 * Este script só é carregado pelas páginas do tenant (index.html, admin.html)
 * — o painel do desenvolvedor (desenvolvedor.html) não o inclui, então nunca
 * aplica tema/branding de nenhum tenant.
 *
 * Cada página chama window.loadTenantBranding() explicitamente, sempre por
 * último no próprio fluxo de inicialização (depois de aplicar os dados de
 * /api/settings) — assim a logo enviada pelo desenvolvedor tem prioridade
 * sobre a logo padrão/configurada pelo cliente, sem depender da ordem de
 * chegada de duas requisições concorrentes.
 */
(function () {
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }

  /* Luminância relativa (WCAG 2.x) para decidir se o texto sobre a cor
     primária do tema deve ser claro ou escuro. Necessário porque os presets
     variam muito em brilho (laranja e verde ficam legíveis com texto escuro;
     azul e roxo precisam de texto claro). */
  function contrastInk(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#0b0d12';
    const [r, g, b] = rgb.map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const contrastWithBlack = (luminance + 0.05) / 0.05;
    const contrastWithWhite = 1.05 / (luminance + 0.05);
    return contrastWithBlack >= contrastWithWhite ? '#0b0d12' : '#ffffff';
  }

  function applyTenantTheme(colors) {
    if (!colors) return;
    const root = document.documentElement.style;
    const set = (name, value) => { if (value) root.setProperty(name, value); };
    set('--tenant-primary', colors.primary);
    set('--tenant-secondary', colors.secondary);
    set('--tenant-accent', colors.accent);
    set('--tenant-background', colors.background);
    set('--tenant-surface', colors.surface);
    set('--tenant-text', colors.text);
    set('--tenant-muted', colors.muted);
    set('--tenant-border', colors.border);
    set('--tenant-success', colors.success);
    set('--tenant-danger', colors.danger);
    const rgb = hexToRgb(colors.primary);
    if (rgb) root.setProperty('--tenant-primary-rgb', rgb.join(', '));
    root.setProperty('--tenant-ink', contrastInk(colors.primary));
  }

  window.applyTenantTheme = applyTenantTheme;

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

    /* Páginas do Admin marcam os links de ícone com data-icon-kind="admin" no
       HTML (ex.: admin.html) para usar o admin_icon do tenant em vez do
       favicon público — o agendamento público nunca usa admin_icon. A rota
       /api/branding/admin-icon já resolve a cadeia de fallback no servidor
       (admin_icon -> favicon -> logo -> padrão), então admin_icon_url sempre
       aponta para um ícone válido. */
    const link = document.getElementById('pageFavicon');
    const touch = document.getElementById('appleTouchIcon');
    const isAdminIcon = link && link.dataset.iconKind === 'admin';

    if (isAdminIcon) {
      if (link) link.href = branding.admin_icon_url;
      /* Ícone do app instalado no celular (iOS usa o apple-touch-icon). */
      if (touch) touch.href = branding.admin_icon_url;
    } else if (branding.has_favicon && branding.favicon_url) {
      if (link) link.href = branding.favicon_url;
      if (touch) touch.href = branding.favicon_url;
    }

    applyTenantTheme(branding.colors);

    const titleMeta = document.querySelector('meta[name="tenant-title-suffix"]');
    if (titleMeta && branding.company_name) {
      const suffix = titleMeta.getAttribute('content') || '';
      document.title = suffix ? `${branding.company_name} | ${suffix}` : branding.company_name;
    }

    return branding;
  }

  window.loadTenantBranding = loadTenantBranding;
})();
