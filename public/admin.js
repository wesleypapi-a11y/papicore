(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = `papicore_admin_token:${window.location.hostname}`;

  const STATUS_LABELS = {
    pending: 'Aguardando confirmação',
    confirmed: 'Confirmado',
    rejected: 'Recusado',
    completed: 'Concluído',
    cancelled: 'Cancelado'
  };
  const STATUS_BADGES = ['pending', 'confirmed', 'rejected', 'completed', 'cancelled'];
  const REJECTION_REASONS = [
    'Horário indisponível',
    'Serviço indisponível',
    'Área fora da região de atendimento',
    'Necessário avaliar o veículo',
    'Outro'
  ];
  const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const WEEKDAY_KEYS = [0, 1, 2, 3, 4, 5, 6];
  const MONTH_LABELS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const AGENDA_DOT_STATUSES = ['pending', 'confirmed', 'completed'];
  const CATEGORY_LABELS = { passeio: 'Passeio', utilitario: 'Utilitário' };
  const PAYMENT_LABELS = {
    local: 'Pagamento no local',
    card: 'Crédito/débito no local',
    pix: 'Pix (copia e cola)',
    qrcode: 'Pix (QR Code)'
  };
  const PAYMENT_METHOD_KEYS = ['local', 'card', 'pix', 'qrcode'];
  const PACKAGE_STATUS_LABELS = {
    ACTIVE: 'Ativo',
    EXHAUSTED: 'Esgotado',
    EXPIRED: 'Expirado',
    CANCELLED: 'Cancelado',
    SUSPENDED: 'Suspenso'
  };
  const PACKAGE_TX_LABELS = {
    PURCHASE: 'Compra',
    RESERVE: 'Reserva',
    CONSUME: 'Consumo',
    RELEASE: 'Liberação',
    MANUAL_DEBIT: 'Débito manual',
    MANUAL_CREDIT: 'Crédito manual',
    CANCEL_PACKAGE: 'Cancelamento do pacote',
    EXPIRE: 'Expiração',
    TRANSFER: 'Transferência'
  };
  const PACKAGE_BADGES = { ACTIVE: 'confirmed', EXHAUSTED: 'pending', EXPIRED: 'cancelled', CANCELLED: 'rejected', SUSPENDED: 'cancelled' };
  const LONG_SERVICE_THRESHOLD_MINUTES = 2 * 24 * 60;
  function isLongAppointment(a) {
    return Number(a && a.booked_duration_minutes || 0) > LONG_SERVICE_THRESHOLD_MINUTES;
  }
  function appointmentTimeLabel(a) {
    return isLongAppointment(a) ? 'Horário a confirmar' : (a.start_time || '—');
  }

  /* Resumo de veículo/serviços reaproveitado pelo card mobile de
     Agendamentos (ver renderAppointments) e pelo modal de detalhes. */
  const STATUS_EMOJI = { pending: '🟡', confirmed: '🟢', completed: '🔵', rejected: '🔴', cancelled: '⚪' };
  function vehicleSummary(a) {
    const parts = `${a.vehicle_brand || ''} ${a.vehicle_model || ''}`.trim();
    return parts + (a.vehicle_year ? ' · ' + a.vehicle_year : '');
  }
  function servicesSummary(a) {
    let list = [];
    try { list = JSON.parse(a.services_json || '[]'); } catch { list = []; }
    if (!Array.isArray(list) || list.length < 2) {
      return { count: 1, first: a.service_name || '—', extra: 0 };
    }
    return { count: list.length, first: list[0].name || a.service_name || '—', extra: list.length - 1 };
  }

  /* Botões de ação compactos (somente ícones), padrão reaproveitado em todas
     as tabelas do admin (agendamentos, serviços, unidades, formas de atendimento).
     Ícones SVG inline (padrão do projeto — sem biblioteca externa). */
  const ACTION_ICONS = {
    accept: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>',
    complete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>',
    reject: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
    detail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };
  const ACTION_LABELS = {
    accept: 'Aceitar agendamento',
    complete: 'Concluir agendamento',
    reject: 'Recusar agendamento',
    cancel: 'Cancelar agendamento',
    edit: 'Editar agendamento',
    detail: 'Ver detalhes',
    delete: 'Excluir agendamento'
  };
  const ACTION_CLASSES = {
    accept: 'action-btn-success',
    complete: 'action-btn-success',
    reject: 'action-btn-warn',
    cancel: 'action-btn-warn',
    edit: 'action-btn-edit',
    detail: 'action-btn-neutral',
    delete: 'action-btn-danger'
  };
  /* Texto curto exibido ao lado do ícone só no cartão mobile (ver
     .action-btn-text no CSS) — o title/aria-label continuam com o texto
     completo de ACTION_LABELS, sem mudar nada de acessibilidade. */
  const ACTION_SHORT_LABELS = {
    accept: 'Confirmar',
    complete: 'Concluir',
    reject: 'Recusar',
    cancel: 'Cancelar',
    edit: 'Editar',
    detail: 'Visualizar',
    delete: 'Excluir'
  };

  function actionButton(action, id, opts) {
    opts = opts || {};
    const icon = opts.icon || action;
    const cls = opts.cls || ACTION_CLASSES[icon];
    const label = opts.label || ACTION_LABELS[action] || ACTION_LABELS[icon];
    const shortLabel = opts.shortLabel || ACTION_SHORT_LABELS[action] || ACTION_SHORT_LABELS[icon] || label;
    return `<button type="button" class="action-btn ${cls}" data-action="${action}" data-id="${id}" title="${label}" aria-label="${label}">${ACTION_ICONS[icon]}<span class="action-btn-text">${shortLabel}</span></button>`;
  }

  let state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    view: 'dashboard',
    appointmentStatus: 'all',
    modal: null,
    units: [],
    modalities: [],
    services: [],
    categories: [],
    agenda: null,
    financeFilters: {
      period: 'month',
      from: '',
      to: '',
      service_id: 'all',
      type: 'all',
      customer: '',
      min: '',
      max: ''
    }
  };

  /* ---------- utils ---------- */

  function money(value) {
    const v = Number(value || 0);
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function digits(v) {
    return String(v || '').replace(/\D/g, '');
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function toDateBR(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }

  /* Constrói a data local a partir de "AAAA-MM-DD" sem passar por UTC
     (new Date('AAAA-MM-DD') interpreta como UTC e pode mudar o dia). */
  function parseDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function toDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function toDateFull(dateStr) {
    const d = parseDate(dateStr);
    const s = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const PRODUCTIVE_HOURS_PER_DAY = 480;

  function fmtDur(mins) {
    const m = Math.max(0, Number(mins) || 0);
    const days = Math.floor(m / PRODUCTIVE_HOURS_PER_DAY);
    const rem = m % PRODUCTIVE_HOURS_PER_DAY;
    const hm = (r) => {
      const h = Math.floor(r / 60);
      const mm = r % 60;
      if (h === 0) return mm + 'min';
      if (mm === 0) return h + 'h';
      return h + 'h' + String(mm).padStart(2, '0');
    };
    if (days === 0) return hm(rem);
    if (rem === 0) return days + ' dia' + (days > 1 ? 's' : '');
    return days + ' dia' + (days > 1 ? 's' : '') + ' + ' + hm(rem);
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function badge(status) {
    return `<span class="badge badge-${status}">${STATUS_LABELS[status] || status}</span>`;
  }

  function packageBadge(status) {
    const cls = PACKAGE_BADGES[status] || 'pending';
    return `<span class="badge badge-${cls}">${PACKAGE_STATUS_LABELS[status] || status}</span>`;
  }

  function toast(msg, type) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + (type || '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast hidden'; }, 3200);
  }

  function showLoader() { $('loader').classList.remove('hidden'); }
  function hideLoader() { $('loader').classList.add('hidden'); }

  /* ---------- api ---------- */

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, { headers, ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.includes('/auth/login')) {
      logout();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    if (!res.ok) throw new Error(data && data.error ? data.error : 'Erro na requisição.');
    return data;
  }

  /* Upload de arquivo (logo/favicon da aba Aparência) — igual a api(), mas
     sem Content-Type manual: o browser define o boundary do multipart. */
  async function apiForm(path, formData, opts = {}) {
    const headers = {};
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, { method: 'POST', headers, body: formData, ...opts });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      logout();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    if (!res.ok) throw new Error(data && data.error ? data.error : 'Erro na requisição.');
    return data;
  }

  /* ---------- auth ---------- */

  async function login(email, password) {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem(TOKEN_KEY, data.token);
    enterPanel();
  }

  function logout() {
    state.token = '';
    state.user = null;
    localStorage.removeItem(TOKEN_KEY);
    $('loginView').classList.remove('hidden');
    $('panelView').classList.add('hidden');
  }

  /* ---------- esqueci minha senha (dentro da própria tela de login) ---------- */

  function showLoginForm() {
    $('forgotFormBlock').classList.add('hidden');
    $('loginFormBlock').classList.remove('hidden');
    $('forgotMsg').classList.add('hidden');
  }

  function showForgotForm() {
    $('loginFormBlock').classList.add('hidden');
    $('forgotFormBlock').classList.remove('hidden');
    $('loginMsg').classList.add('hidden');
  }

  /* ---------- redefinir senha (/admin/redefinir-senha?token=...) ---------- */

  function passwordRequirementsMet(password) {
    const rules = {
      length: password.length >= 8,
      upper: /[A-Z]/.test(password),
      lower: /[a-z]/.test(password),
      number: /[0-9]/.test(password)
    };
    document.querySelectorAll('#passwordRequirements li').forEach((li) => {
      li.classList.toggle('met', Boolean(rules[li.dataset.rule]));
    });
    return Object.values(rules).every(Boolean);
  }

  function bindPasswordToggle(btn) {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.toggleFor);
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? '👁' : '🙈';
    });
  }

  function showResetState(name) {
    ['resetLoadingState', 'resetInvalidState', 'resetFormState', 'resetSuccessState'].forEach((id) => {
      $(id).classList.toggle('hidden', id !== name);
    });
  }

  /* Nunca guarda o token em localStorage/sessionStorage — só em memória
     (variável local) durante o fluxo desta página. */
  async function initResetPasswordView() {
    $('loginView').classList.add('hidden');
    $('panelView').classList.add('hidden');
    $('resetPasswordView').classList.remove('hidden');
    if (window.loadTenantBranding) window.loadTenantBranding();

    document.querySelectorAll('.password-toggle').forEach(bindPasswordToggle);

    const token = new URLSearchParams(window.location.search).get('token') || '';
    if (!token) {
      showResetState('resetInvalidState');
      return;
    }

    try {
      const data = await api('/api/auth/reset-password/validate', {
        method: 'POST',
        body: JSON.stringify({ token })
      });
      if (!data.valid) {
        $('resetInvalidMsg').textContent = data.message || 'Este link de redefinição é inválido ou expirou. Solicite um novo na tela de login.';
        showResetState('resetInvalidState');
        return;
      }
    } catch (e) {
      showResetState('resetInvalidState');
      return;
    }

    showResetState('resetFormState');
    $('resetPassword').addEventListener('input', () => passwordRequirementsMet($('resetPassword').value));

    $('resetForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('resetMsg');
      msg.classList.add('hidden');

      const password = $('resetPassword').value;
      const passwordConfirmation = $('resetPasswordConfirm').value;
      if (!passwordRequirementsMet(password)) {
        msg.textContent = 'A senha não atende aos requisitos mínimos.';
        msg.classList.remove('hidden');
        return;
      }
      if (password !== passwordConfirmation) {
        msg.textContent = 'A confirmação de senha não confere.';
        msg.classList.remove('hidden');
        return;
      }

      showLoader();
      try {
        await api('/api/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token, password, password_confirmation: passwordConfirmation })
        });
        /* remove o token da URL: não fica no histórico do navegador depois do uso */
        history.replaceState(null, '', window.location.pathname);
        showResetState('resetSuccessState');
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.remove('hidden');
      }
      hideLoader();
    });
  }

  /* ---------- modal helpers ---------- */

  function openModal(title, bodyHtml, actionsHtml) {
    const overlay = $('modalOverlay');
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" class="modal-close" data-close aria-label="Fechar">×</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${actionsHtml ? `<div class="modal-actions">${actionsHtml}</div>` : ''}
      </div>
    `;
    overlay.classList.add('open');
    overlay.querySelector('[data-close]').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    return overlay;
  }

  function closeModal() {
    $('modalOverlay').classList.remove('open');
    $('modalOverlay').innerHTML = '';
    state.modal = null;
  }

  function fieldHtml(id, label, value, type = 'text', placeholder = '') {
    return `<div class="field"><label for="${id}">${escapeHtml(label)}</label>
      <input type="${type}" id="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}" />
    </div>`;
  }

  /* ---------- sidebar (mobile drawer) ---------- */

  function openSidebar() {
    $('sidebar').classList.add('open');
    $('sidebarBackdrop').classList.add('show');
  }
  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('sidebarBackdrop').classList.remove('show');
  }

  /* ---------- navigation ---------- */

  async function enterPanel() {
    $('loginView').classList.add('hidden');
    $('panelView').classList.remove('hidden');
    try {
      state.user = await api('/api/admin/me');
    } catch (e) { /* ignore */ }
    showImpersonationBanner();
    await loadBase();
    showView('dashboard');
  }

  function showImpersonationBanner() {
    document.getElementById('impersonationBanner')?.remove();
    try {
      const payload = JSON.parse(atob(state.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!payload.impersonated) return;
      const banner = document.createElement('div');
      banner.id = 'impersonationBanner';
      banner.style.cssText = 'position:fixed;z-index:9999;left:0;right:0;top:0;padding:10px;text-align:center;background:#f59e0b;color:#111;font-weight:700';
      banner.innerHTML = 'Você está acessando esta empresa como desenvolvedor. <button type="button">Sair da empresa e voltar ao painel do desenvolvedor</button>';
      banner.querySelector('button').onclick = () => { localStorage.removeItem(TOKEN_KEY); location.href = '/desenvolvedor'; };
      document.body.appendChild(banner);
    } catch { /* token inválido será tratado pela API */ }
  }

  async function loadBase() {
    const [units, modalities, services, categories, settings] = await Promise.all([
      api('/api/admin/units').catch(() => []),
      api('/api/admin/modalities').catch(() => []),
      api('/api/admin/services').catch(() => []),
      api('/api/admin/service-categories').catch(() => []),
      api('/api/admin/settings').catch(() => null)
    ]);
    state.units = units;
    state.modalities = modalities;
    state.services = services;
    state.categories = categories;
    state.settings = settings;
    applyBrandName(settings && settings.company_name);
  }

  /* Nome da empresa do cliente (Configurações > Geral) no lugar do "PapiCore"
     fixo no topo do menu do painel — cada tenant vê o próprio nome ali. */
  function applyBrandName(name) {
    const label = (name && String(name).trim()) || 'PapiCore';
    document.querySelectorAll('#sidebar .brand-name').forEach((el) => { el.textContent = label; });
  }

  async function showView(name) {
    state.view = name;
    document.body.classList.toggle('agenda-active', name === 'agenda');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('view-' + name).classList.remove('hidden');
    document.querySelectorAll('.admin-nav button[data-view]').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    $('topbarTitle').textContent = name.charAt(0).toUpperCase() + name.slice(1);
    const titles = {
      dashboard: 'Dashboard',
      agenda: 'Agenda',
      appointments: 'Agendamentos',
      finances: 'Financeiro',
      services: 'Serviços e valores',
      packages: 'Pacotes',
      whatsapp: 'WhatsApp',
      units: 'Unidades',
      blocks: 'Bloqueios',
      modalities: 'Formas de atendimento',
      contract: 'Contrato',
      settings: 'Configurações'
    };
    $('topbarTitle').textContent = titles[name];
    closeSidebar();
    if (name === 'agenda' && state.agenda) state.agenda.monthKey = ''; /* recarrega a agenda sempre que a aba é aberta */
    const renderer = {
      dashboard: renderDashboard,
      agenda: renderAgenda,
      appointments: renderAppointments,
      finances: renderFinances,
      services: renderServices,
      packages: renderPackages,
      whatsapp: renderWhatsapp,
      units: renderUnits,
      blocks: renderBlocks,
      modalities: renderModalities,
      contract: renderContract,
      settings: renderSettings
    }[name];
    if (renderer) {
      showLoader();
      try { await renderer(); } catch (e) { toast(e.message, 'error'); }
      hideLoader();
    }
  }

  /* ---------- dashboard ---------- */

  /* Checklist de configuração pendente da agenda: mostra o que falta para o
     site público sair do modo "Estamos preparando a agenda" e oferece atalhos
     para as abas que resolvem cada item. */
  function setupBanner(missing) {
    const steps = {
      unidade: { label: 'Unidades', tab: 'units' },
      'formas de atendimento': { label: 'Formas de atendimento', tab: 'modalities' },
      serviços: { label: 'Serviços', tab: 'services' },
      horários: { label: 'Horários', tab: 'settings' },
      'banco de dados': { label: 'Configurações', tab: 'settings' }
    };
    const items = (missing || []).length
      ? missing.map((key) => {
          const s = steps[key] || { label: key, tab: null };
          const inner = `${escapeHtml(s.label)}`;
          return `<li class="setup-missing-item">${s.tab
            ? `<button type="button" class="linklike" data-setup-tab="${s.tab}">${inner}</button>`
            : `<span>${inner}</span>`}</li>`;
        }).join('')
      : '<li class="setup-missing-item">Configure unidade, atendimento, serviços e horários</li>';
    return `
      <div class="setup-banner">
        <div class="setup-banner-head"><strong>Agenda ainda em configuração</strong><span>O site público mostra "Estamos preparando a agenda desta empresa" até estes itens serem cadastrados:</span></div>
        <ul class="setup-missing-list">${items}</ul>
      </div>`;
  }

  async function renderDashboard() {
    const data = await api('/api/admin/dashboard');
    const el = $('view-dashboard');
    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Dashboard</h1><div class="sub">${toDateBR(todayStr())} · Olá, ${escapeHtml(state.user ? state.user.name : '')}</div></div>
      </div>
      ${data.setup_status === 'PENDING' ? setupBanner(data.setup_missing) : ''}
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-value">${data.today}</div><div class="stat-label">Hoje</div></div>
        <div class="stat-card"><div class="stat-value">${data.week}</div><div class="stat-label">Esta semana</div></div>
        <div class="stat-card"><div class="stat-value">${data.month}</div><div class="stat-label">Este mês</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--amber)">${data.pending_today}</div><div class="stat-label">Aguardando hoje</div></div>
      </div>
      <div class="stat-grid" style="margin-top:14px;">
        <div class="stat-card"><div class="stat-value" style="color:var(--green)">${data.today_slots.available}</div><div class="stat-label">Vagas livres hoje</div></div>
        <div class="stat-card"><div class="stat-value">${data.today_slots.occupied}</div><div class="stat-label">Ocupadas hoje</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--red)">${data.today_slots.blocked}</div><div class="stat-label">Bloqueadas hoje</div></div>
        <div class="stat-card"><div class="stat-value">${state.units.length}</div><div class="stat-label">Unidades ativas</div></div>
      </div>
      <div class="panel" style="margin-top:18px;">
        <h3 class="review-section-title">Próximos agendamentos</h3>
        ${data.upcoming.length ? `
          <div class="table-wrap"><table>
            <thead><tr><th>Código</th><th>Cliente</th><th>Data</th><th>Horário</th><th>Serviço</th><th>Status</th></tr></thead>
            <tbody>
              ${data.upcoming.map((a) => `
                <tr>
                  <td><strong>${escapeHtml(a.appointment_code)}</strong></td>
                  <td>${escapeHtml(a.customer_name)}</td>
                  <td>${toDateBR(a.appointment_date)}</td>
                  <td>${escapeHtml(appointmentTimeLabel(a))}</td>
                  <td>${escapeHtml(a.service_name || '—')}</td>
                  <td>${badge(a.status)}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>` : '<div class="empty-state">Nenhum agendamento futuro.</div>'}
      </div>
    `;
    el.querySelectorAll('[data-setup-tab]').forEach((btn) => {
      btn.addEventListener('click', () => showView(btn.dataset.setupTab));
    });
  }

  /* ---------- agenda ---------- */

  function agendaMonthKey(year, month) { return `${year}-${month}`; }

  /* Intervalo de 42 dias (6 semanas) que cobre a grade visível do mês,
     incluindo os dias de preenchimento do mês anterior/seguinte. */
  function agendaGridRange(year, month) {
    const firstDow = new Date(year, month, 1).getDay();
    const start = new Date(year, month, 1 - firstDow);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 41);
    return { start, end };
  }

  function agendaDefaultState() {
    const t = new Date();
    return {
      year: t.getFullYear(),
      month: t.getMonth(),
      selectedDate: todayStr(),
      monthKey: '',
      monthAppointments: [],
      settings: null,
      dayBlockedDate: null,
      dayBlocked: [],
      fetchToken: 0,
      loading: false,
      error: null
    };
  }

  async function agendaEnsureMonth(force) {
    const ag = state.agenda;
    const key = agendaMonthKey(ag.year, ag.month);
    if (!force && ag.monthKey === key) return;
    const token = ++ag.fetchToken;
    const { start, end } = agendaGridRange(ag.year, ag.month);
    try {
      const rows = await api(`/api/admin/appointments?from=${toDateStr(start)}&to=${toDateStr(end)}`);
      if (token !== ag.fetchToken) return; /* navegação mais recente já em andamento */
      ag.monthAppointments = rows;
      ag.monthKey = key;
      ag.error = null;
    } catch (e) {
      if (token !== ag.fetchToken) return;
      ag.error = e.message;
    }
  }

  async function agendaEnsureSettings() {
    if (state.agenda.settings) return;
    try {
      state.agenda.settings = await api('/api/admin/settings');
    } catch {
      state.agenda.settings = {};
    }
  }

  async function agendaEnsureDayBlocks(dateStr) {
    const ag = state.agenda;
    if (ag.dayBlockedDate === dateStr) return;
    try {
      ag.dayBlocked = await api('/api/admin/blocked-schedules?date=' + dateStr);
      ag.dayBlockedDate = dateStr;
    } catch {
      ag.dayBlocked = [];
      ag.dayBlockedDate = dateStr;
    }
  }

  function agendaAppointmentsForDate(dateStr) {
    return state.agenda.monthAppointments
      .filter((a) => a.appointment_date === dateStr)
      .sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0));
  }

  function agendaDayCounts() {
    const counts = new Map();
    state.agenda.monthAppointments.forEach((a) => {
      if (!AGENDA_DOT_STATUSES.includes(a.status)) return;
      counts.set(a.appointment_date, (counts.get(a.appointment_date) || 0) + 1);
    });
    return counts;
  }

  function agendaBuildCalendarGrid() {
    const ag = state.agenda;
    const { start } = agendaGridRange(ag.year, ag.month);
    const counts = agendaDayCounts();
    const today = todayStr();
    let html = '';
    for (let i = 0; i < 42; i += 1) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const dateStr = toDateStr(d);
      const isOutside = d.getMonth() !== ag.month;
      const isToday = dateStr === today;
      const isSelected = dateStr === ag.selectedDate;
      const count = counts.get(dateStr) || 0;
      const cls = ['agenda-cal-day'];
      if (isOutside) cls.push('is-outside');
      if (isToday) cls.push('is-today');
      if (isSelected) cls.push('is-selected');
      html += `<button type="button" class="${cls.join(' ')}" data-date="${dateStr}" aria-selected="${isSelected}" ${count ? `title="${count} agendamento${count > 1 ? 's' : ''}"` : ''}>
        <span>${d.getDate()}</span>
        ${count ? '<span class="agenda-cal-dot"></span>' : ''}
      </button>`;
    }
    return html;
  }

  function agendaBuildSummaryHtml(dayAppts) {
    const total = dayAppts.length;
    const confirmed = dayAppts.filter((a) => a.status === 'confirmed').length;
    const pending = dayAppts.filter((a) => a.status === 'pending').length;
    const cancelled = dayAppts.filter((a) => a.status === 'cancelled' || a.status === 'rejected').length;
    return `
      <h3 class="agenda-summary-title">Resumo do dia ${toDateBR(state.agenda.selectedDate)}</h3>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Agendamentos</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--green)">${confirmed}</div><div class="stat-label">Confirmados</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--amber)">${pending}</div><div class="stat-label">Pendentes</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--red)">${cancelled}</div><div class="stat-label">Cancelados</div></div>
      </div>
    `;
  }

  function agendaBuildUpcomingHtml(dayAppts) {
    const isToday = state.agenda.selectedDate === todayStr();
    const nowTime = isToday ? `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}` : null;
    const active = dayAppts.filter((a) => a.status === 'pending' || a.status === 'confirmed');
    const upcoming = (isToday ? active.filter((a) => a.start_time >= nowTime) : active).slice(0, 3);
    return `
      <h3 class="agenda-upcoming-title">Próximos agendamentos</h3>
      ${upcoming.length ? upcoming.map((a) => `
        <div class="agenda-upcoming-item">
          <div class="agenda-upcoming-time">${escapeHtml(appointmentTimeLabel(a))}</div>
          <div class="agenda-upcoming-info">
            <div class="agenda-upcoming-name">${escapeHtml(a.customer_name)}</div>
            <div class="agenda-upcoming-service">${escapeHtml(a.service_name || '—')}${a.unit_name ? ' · ' + escapeHtml(a.unit_name) : ''}</div>
          </div>
          ${badge(a.status)}
        </div>
      `).join('') : '<div class="muted">Nenhum próximo agendamento.</div>'}
      <div class="agenda-upcoming-foot"><button type="button" class="btn btn-ghost btn-sm" id="agViewAll">Ver todos →</button></div>
    `;
  }

  function timeToMin(t) {
    const [h, m] = String(t || '0:0').split(':').map(Number);
    return h * 60 + m;
  }
  function minToTime(m) {
    const mm = Math.max(0, Math.round(m));
    return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
  }

  /* Layout em colunas para agendamentos simultâneos (mesma lógica de
     algoritmos de calendário: cada item ocupa a primeira coluna livre). */
  function agendaAssignColumns(items) {
    const sorted = [...items].sort((a, b) => a.startMin - b.startMin);
    const columns = [];
    sorted.forEach((item) => {
      let col = columns.findIndex((endMin) => endMin <= item.startMin);
      if (col === -1) { col = columns.length; columns.push(0); }
      columns[col] = item.endMin;
      item.col = col;
    });
    const totalCols = columns.length || 1;
    sorted.forEach((item) => { item.totalCols = totalCols; });
    return sorted;
  }

  function agendaBuildDailyHtml(dayAppts, settings) {
    const opening = settings.default_opening_time || '08:00';
    const closing = settings.default_closing_time || '17:00';
    const lunchStart = settings.lunch_start || '12:00';
    const lunchEnd = settings.lunch_end || '13:00';
    const interval = Number(settings.default_interval) || 60;
    const openMin = timeToMin(opening);
    const closeMin = timeToMin(closing);
    const lunchStartMin = timeToMin(lunchStart);
    const lunchEndMin = timeToMin(lunchEnd);
    const totalMin = Math.max(60, closeMin - openMin);
    const PX = 1.15; /* pixels por minuto */
    const dateStr = state.agenda.selectedDate;

    const fullDayBlock = state.agenda.dayBlocked.find((b) => b.block_full_day);
    const partialBlocks = state.agenda.dayBlocked.filter((b) => !b.block_full_day && b.blocked_time);

    const ticks = [];
    for (let m = openMin; m < closeMin; m += interval) ticks.push(m);

    const items = dayAppts.map((a) => {
      const startMin = Math.max(openMin, timeToMin(a.start_time));
      const sameDayEnd = !a.end_date || a.end_date === dateStr;
      const endMin = Math.min(closeMin, sameDayEnd ? timeToMin(a.end_time || a.start_time) : closeMin);
      return { a, startMin, endMin: Math.max(endMin, startMin + 20) };
    });
    agendaAssignColumns(items);

    let html = `<div class="agenda-timeline" style="height:${Math.round(totalMin * PX) + 20}px;">`;

    ticks.forEach((m) => {
      html += `<div class="agenda-tick" style="top:${Math.round((m - openMin) * PX)}px;"><span class="agenda-tick-label">${minToTime(m)}</span></div>`;
    });

    html += '<div class="agenda-tick-content">';

    if (fullDayBlock) {
      html += `<div class="agenda-fullday-banner-inline agenda-blocked-band" style="top:0;height:${Math.round(totalMin * PX)}px;">
        <strong>Dia bloqueado</strong><span>${escapeHtml(fullDayBlock.reason || 'Sem atendimento nesta data.')}</span>
      </div>`;
    } else {
      /* Almoço */
      if (lunchEndMin > openMin && lunchStartMin < closeMin) {
        const top = Math.max(0, lunchStartMin - openMin) * PX;
        const height = Math.max(20, (Math.min(lunchEndMin, closeMin) - Math.max(lunchStartMin, openMin)) * PX);
        html += `<div class="agenda-lunch-band" style="top:${Math.round(top)}px;height:${Math.round(height)}px;">Intervalo · Almoço (${lunchStart}–${lunchEnd})</div>`;
      }

      /* Bloqueios parciais */
      partialBlocks.forEach((b) => {
        const bStart = Math.max(openMin, timeToMin(b.blocked_time));
        const bEnd = Math.min(closeMin, timeToMin(b.blocked_time_end || b.blocked_time) || bStart + interval);
        const top = (bStart - openMin) * PX;
        const height = Math.max(20, (Math.max(bEnd, bStart + interval) - bStart) * PX);
        html += `<div class="agenda-blocked-band" style="top:${Math.round(top)}px;height:${Math.round(height)}px;">
          <strong>Horário bloqueado</strong><span>${escapeHtml(b.blocked_time)}${b.blocked_time_end ? ' – ' + escapeHtml(b.blocked_time_end) : ''}${b.reason ? ' · ' + escapeHtml(b.reason) : ''}</span>
        </div>`;
      });

      /* Horários livres (uma faixa por intervalo, atrás dos cards/bloqueios) */
      ticks.forEach((m) => {
        const covered = items.some((it) => m >= it.startMin && m < it.endMin)
          || (m >= lunchStartMin && m < lunchEndMin)
          || partialBlocks.some((b) => m >= timeToMin(b.blocked_time) && m < timeToMin(b.blocked_time_end || b.blocked_time) + interval);
        if (covered) return;
        const top = (m - openMin) * PX;
        const height = interval * PX;
        html += `<div class="agenda-slot" style="top:${Math.round(top)}px;height:${Math.round(height)}px;" data-slot-time="${minToTime(m)}">
          <button type="button" class="agenda-slot-add" data-action="newSlot" data-time="${minToTime(m)}">+ Novo agendamento</button>
        </div>`;
      });
    }

    /* Cards de agendamento (por cima de tudo) */
    items.forEach(({ a, startMin, endMin, col, totalCols }) => {
      const top = (startMin - openMin) * PX;
      const height = Math.max(30, (endMin - startMin) * PX);
      const widthPct = 100 / totalCols;
      const leftPct = col * widthPct;
      const endLabel = a.end_date && a.end_date !== dateStr ? `${toDateBR(a.end_date)} ${a.end_time || ''}` : (a.end_time || '');
      html += `<div class="agenda-appt-card status-${a.status}" data-action="agendaDetail" data-id="${a.id}" tabindex="0"
        style="top:${Math.round(top)}px;height:${Math.round(height)}px;left:calc(${leftPct}% + ${leftPct > 0 ? '4px' : '0px'});width:calc(${widthPct}% - ${totalCols > 1 ? '8px' : '4px'});">
        <div class="agenda-appt-head"><span class="agenda-appt-name">${escapeHtml(a.customer_name)}</span>${badge(a.status)}</div>
        <div class="agenda-appt-sub">${escapeHtml(a.service_name || '—')}${a.unit_name ? ' · ' + escapeHtml(a.unit_name) : ''}</div>
        <div class="agenda-appt-time">${escapeHtml(appointmentTimeLabel(a))}${endLabel ? ' → ' + escapeHtml(endLabel) : ''}</div>
      </div>`;
    });

    html += '</div></div>';
    return html;
  }

  function agendaBuildDailyPanel(dayAppts, settings) {
    const dateStr = state.agenda.selectedDate;
    const count = dayAppts.length;
    return `
      <div class="agenda-daily-head">
        <h3 class="agenda-daily-title">${toDateFull(dateStr)}</h3>
        <span class="agenda-daily-count">${count} agendamento${count === 1 ? '' : 's'}</span>
      </div>
      ${count === 0 ? '<div class="agenda-empty-note">Nenhum agendamento para esta data. Os horários disponíveis estão exibidos abaixo.</div>' : ''}
      ${agendaBuildDailyHtml(dayAppts, settings)}
    `;
  }

  function agendaSkeletonHtml() {
    return `
      <div class="agenda-skeleton-cal"></div>
      <div class="panel" style="margin-top:18px;"><div class="agenda-skeleton-line"></div><div class="agenda-skeleton-line"></div></div>
    `;
  }

  function agendaBindSidePanels(el) {
    el.querySelectorAll('[data-action="agendaDetail"]').forEach((card) => {
      const open = () => openDetailModal(Number(card.dataset.id));
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    el.querySelectorAll('[data-action="newSlot"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openAppointmentModal(undefined, { date: state.agenda.selectedDate, time: btn.dataset.time });
      });
    });
    const viewAll = $('agViewAll');
    if (viewAll) viewAll.addEventListener('click', () => showView('appointments'));
  }

  async function agendaRenderSidePanels() {
    const el = $('view-agenda');
    if (!el || el.classList.contains('hidden')) return;
    await agendaEnsureDayBlocks(state.agenda.selectedDate);
    const dayAppts = agendaAppointmentsForDate(state.agenda.selectedDate);
    const summaryEl = $('agSummaryBody');
    const upcomingEl = $('agUpcomingBody');
    const dailyEl = $('agDailyBody');
    if (summaryEl) summaryEl.innerHTML = agendaBuildSummaryHtml(dayAppts);
    if (upcomingEl) upcomingEl.innerHTML = agendaBuildUpcomingHtml(dayAppts);
    if (dailyEl) dailyEl.innerHTML = agendaBuildDailyPanel(dayAppts, state.agenda.settings || {});
    agendaBindSidePanels(el);
  }

  function agendaSelectDate(dateStr, { changeMonth } = {}) {
    const ag = state.agenda;
    ag.selectedDate = dateStr;
    if (changeMonth) {
      const d = parseDate(dateStr);
      ag.year = d.getFullYear();
      ag.month = d.getMonth();
    }
  }

  async function agendaGoToMonth(year, month, selectedDate) {
    const ag = state.agenda;
    ag.year = year;
    ag.month = month;
    ag.selectedDate = selectedDate || toDateStr(new Date(year, month, 1));
    await renderAgenda();
  }

  function agendaMonthOptionsHtml() {
    const ag = state.agenda;
    const opts = [];
    const base = new Date(ag.year, ag.month, 1);
    for (let i = -12; i <= 12; i += 1) {
      const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
      const val = `${d.getFullYear()}-${d.getMonth()}`;
      const label = `${MONTH_LABELS[d.getMonth()]} de ${d.getFullYear()}`;
      opts.push(`<option value="${val}" ${i === 0 ? 'selected' : ''}>${label}</option>`);
    }
    return opts.join('');
  }

  async function renderAgenda() {
    const el = $('view-agenda');
    if (!state.agenda) state.agenda = agendaDefaultState();
    const ag = state.agenda;
    const firstLoad = !ag.monthKey;

    if (firstLoad) {
      el.innerHTML = `
        <div class="admin-header agenda-header"><div><h1><span class="agenda-icon">📅</span>Agenda</h1><div class="sub">Visualize e gerencie os agendamentos.</div></div></div>
        <div class="agenda-grid"><div class="agenda-col-left">${agendaSkeletonHtml()}</div><div class="agenda-col-right"><div class="panel">${agendaSkeletonHtml()}</div></div></div>
      `;
    }

    await Promise.all([agendaEnsureSettings(), agendaEnsureMonth(firstLoad)]);

    if (ag.error) {
      el.innerHTML = `
        <div class="admin-header agenda-header"><div><h1><span class="agenda-icon">📅</span>Agenda</h1><div class="sub">Visualize e gerencie os agendamentos.</div></div></div>
        <div class="agenda-error">Não foi possível carregar os agendamentos.<br /><button class="btn btn-outline" id="agRetry">Tentar novamente</button></div>
      `;
      $('agRetry').addEventListener('click', () => renderAgenda());
      return;
    }

    el.innerHTML = `
      <div class="admin-header agenda-header">
        <div><h1><span class="agenda-icon">📅</span>Agenda</h1><div class="sub">Visualize e gerencie os agendamentos.</div></div>
        <div class="agenda-controls">
          <button type="button" class="btn btn-outline btn-sm" id="agToday">Hoje</button>
          <button type="button" class="btn btn-outline btn-sm agenda-nav-btn" id="agPrev" aria-label="Mês anterior">‹</button>
          <button type="button" class="btn btn-outline btn-sm agenda-nav-btn" id="agNext" aria-label="Próximo mês">›</button>
          <select id="agMonthSelect" class="agenda-month-select" aria-label="Selecionar mês">${agendaMonthOptionsHtml()}</select>
          <div class="agenda-mode-switch" role="group" aria-label="Alternar período">
            <button type="button" class="active" data-mode="month">Mês</button>
            <button type="button" data-mode="week" title="Visualização semanal em breve">Semana</button>
          </div>
        </div>
      </div>
      <div class="agenda-grid">
        <div class="agenda-col-left">
          <div class="panel agenda-cal-panel">
            <div class="agenda-panel-title">${MONTH_LABELS[ag.month]} de ${ag.year}</div>
            <div class="agenda-cal-weekdays">${WEEKDAY_LABELS.map((w) => `<span>${w}</span>`).join('')}</div>
            <div class="agenda-cal-grid" id="agCalGrid">${agendaBuildCalendarGrid()}</div>
          </div>
          <div class="panel" id="agSummaryBody"></div>
          <div class="panel" id="agUpcomingBody"></div>
        </div>
        <div class="agenda-col-right">
          <div class="panel agenda-daily-panel" id="agDailyBody"></div>
        </div>
      </div>
    `;

    await agendaRenderSidePanels();

    $('agToday').addEventListener('click', () => {
      const t = new Date();
      agendaGoToMonth(t.getFullYear(), t.getMonth(), todayStr());
    });
    $('agPrev').addEventListener('click', () => {
      const d = new Date(ag.year, ag.month - 1, 1);
      agendaGoToMonth(d.getFullYear(), d.getMonth());
    });
    $('agNext').addEventListener('click', () => {
      const d = new Date(ag.year, ag.month + 1, 1);
      agendaGoToMonth(d.getFullYear(), d.getMonth());
    });
    $('agMonthSelect').addEventListener('change', (e) => {
      const [y, m] = e.target.value.split('-').map(Number);
      agendaGoToMonth(y, m);
    });
    el.querySelectorAll('.agenda-mode-switch button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode === 'week') { toast('Visualização semanal em breve.'); return; }
      });
    });
    el.querySelectorAll('#agCalGrid .agenda-cal-day').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dateStr = btn.dataset.date;
        const d = parseDate(dateStr);
        if (d.getMonth() !== ag.month || d.getFullYear() !== ag.year) {
          agendaGoToMonth(d.getFullYear(), d.getMonth(), dateStr);
          return;
        }
        agendaSelectDate(dateStr);
        el.querySelectorAll('#agCalGrid .agenda-cal-day').forEach((c) => {
          c.classList.toggle('is-selected', c.dataset.date === dateStr);
          c.setAttribute('aria-selected', String(c.dataset.date === dateStr));
        });
        agendaRenderSidePanels();
      });
    });
  }

  /* ---------- appointments ---------- */

  async function renderAppointments() {
    const el = $('view-appointments');
    const params = new URLSearchParams({ status: state.appointmentStatus });
    const data = await api('/api/admin/appointments?' + params.toString());

    const counts = { all: 0 };
    STATUS_BADGES.forEach((s) => { counts[s] = 0; });
    data.forEach((a) => { counts.all += 1; counts[a.status] = (counts[a.status] || 0) + 1; });

    const tabs = ['all', ...STATUS_BADGES].map((s) => {
      const label = s === 'all' ? 'Todos' : STATUS_LABELS[s];
      const n = counts[s] || 0;
      return `<button class="tab ${state.appointmentStatus === s ? 'active' : ''}" data-status="${s}">${label} <span class="count">${n}</span></button>`;
    }).join('');

    const rowsAndCards = data.map((a) => {
      const actions = [];
      if (a.status === 'pending') {
        actions.push(actionButton('accept', a.id));
        actions.push(actionButton('reject', a.id));
      }
      if (a.status === 'confirmed') {
        actions.push(actionButton('complete', a.id));
        actions.push(actionButton('cancel', a.id));
      }
      if (a.status === 'pending' || a.status === 'confirmed') {
        actions.push(actionButton('edit', a.id));
      }
      actions.push(actionButton('detail', a.id));
      actions.push(actionButton('delete', a.id));
      const actionsHtml = actions.join('');

      const row = `
        <tr>
          <td><strong>${escapeHtml(a.appointment_code)}</strong></td>
          <td>${escapeHtml(a.customer_name)}<br /><span class="muted">${escapeHtml(a.customer_phone)}</span></td>
          <td>${toDateBR(a.appointment_date)}<br /><span class="muted">${escapeHtml(appointmentTimeLabel(a))}${isLongAppointment(a) ? '' : ' → ' + (a.end_date && a.end_date !== a.appointment_date ? toDateBR(a.end_date) + ' ' : '') + escapeHtml(a.end_time || '—')}</span></td>
          <td>${escapeHtml(a.service_name || '—')}<br /><span class="muted">${escapeHtml(a.modality_name || '')}${a.unit_name ? ' · ' + escapeHtml(a.unit_name) : ''}</span></td>
          <td>${money(a.total_price)}${a.price_is_estimate ? ' <span class="muted">(est.)</span>' : ''}<br />${a.payment_method ? `<span class="muted">${escapeHtml(PAYMENT_LABELS[a.payment_method] || a.payment_method)}</span>` : ''}</td>
          <td>${badge(a.status)}</td>
          <td><div class="appointment-actions">${actionsHtml}</div></td>
        </tr>`;

      /* Card mobile — layout próprio (não é a tabela reaproveitada), denso
         como um app: cada linha é um dado só, sem rótulo separado, com
         ícone identificando o campo. Serviços múltiplos viram um resumo
         ("N serviços" + primeiro + "+X adicionais") em vez da lista
         inteira — ver Visualizar/Editar para a lista completa. */
      const svc = servicesSummary(a);
      const timeRange = isLongAppointment(a)
        ? 'Horário a confirmar'
        : `${a.start_time || '—'} às ${a.end_time || '—'}`;
      const vehicle = vehicleSummary(a);
      const card = `
        <div class="appt-card">
          <div class="appt-card-top">
            <span class="appt-card-code">${escapeHtml(a.appointment_code)}</span>
            <span class="badge badge-${a.status} appt-card-badge">${STATUS_EMOJI[a.status] || ''} ${STATUS_LABELS[a.status] || a.status}</span>
          </div>
          <div class="appt-card-row appt-card-name">👤 ${escapeHtml(a.customer_name)}</div>
          <div class="appt-card-row muted">📞 ${escapeHtml(a.customer_phone)}</div>
          ${vehicle ? `<div class="appt-card-row muted">🚗 ${escapeHtml(vehicle)}</div>` : ''}
          <div class="appt-card-row">📅 ${toDateBR(a.appointment_date)} &nbsp;🕐 ${escapeHtml(timeRange)}</div>
          ${svc.count > 1 ? `<div class="appt-card-row">🧽 ${svc.count} serviços</div>` : ''}
          <div class="appt-card-row appt-card-service-line">
            <span class="appt-card-service-name">${svc.count === 1 ? '🧽 ' : ''}${escapeHtml(svc.first)}</span>
            ${svc.extra > 0 ? `<span class="appt-card-extra">+${svc.extra} adicional${svc.extra === 1 ? '' : 'ais'}</span>` : ''}
          </div>
          <div class="appt-card-row appt-card-price">💰 ${money(a.total_price)}${a.price_is_estimate ? ' <span class="muted">(est.)</span>' : ''}</div>
          <div class="appt-card-actions">${actionsHtml}</div>
        </div>`;

      return { row, card };
    });

    const rows = rowsAndCards.map((x) => x.row).join('');
    const cards = rowsAndCards.map((x) => x.card).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Agendamentos</h1><div class="sub">Gerencie solicitações e reservas</div></div>
        <button class="btn btn-primary" id="btnNewAppointment">+ Novo agendamento</button>
      </div>
      <div class="tabs">${tabs}</div>
      ${data.length ? `
        <div class="panel appt-table-panel">
          <div class="table-wrap"><table>
            <thead><tr><th>Código</th><th>Cliente</th><th>Data</th><th>Serviço</th><th>Total</th><th>Status</th><th>Ações</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>
        <div class="appt-cards">${cards}</div>
      ` : '<div class="panel"><div class="empty-state">Nenhum agendamento neste filtro.</div></div>'}
    `;

    el.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
      state.appointmentStatus = t.dataset.status;
      renderAppointments();
    }));
    $('btnNewAppointment').addEventListener('click', () => openAppointmentModal());
    bindRowActions(el);
  }

  async function bindRowActions(root) {
    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const id = btn.dataset.id;
        try {
          if (action === 'accept') await confirmAction('Aceitar este agendamento?', `/api/admin/appointments/${id}/accept`, 'PATCH', null, () => renderAgendaOrAppointments());
          if (action === 'reject') openRejectModal(id);
          if (action === 'complete') await confirmAction('Marcar como concluído?', `/api/admin/appointments/${id}/status`, 'PATCH', { status: 'completed' }, () => renderAgendaOrAppointments());
          if (action === 'cancel') await confirmAction('Cancelar este agendamento?', `/api/admin/appointments/${id}/status`, 'PATCH', { status: 'cancelled' }, () => renderAgendaOrAppointments());
          if (action === 'delete') await confirmAction('Excluir definitivamente este agendamento?', `/api/admin/appointments/${id}`, 'DELETE', null, () => renderAgendaOrAppointments());
          if (action === 'detail') openDetailModal(id);
          if (action === 'edit') openAppointmentModal(id);
        } catch (e) {
          toast(e.message, 'error');
        }
      });
    });
  }

  async function confirmAction(msg, url, method, body, cb) {
    if (!confirm(msg)) return;
    showLoader();
    try {
      await api(url, { method, body: body ? JSON.stringify(body) : undefined });
      await cb();
      toast('Operação concluída.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  function renderAgendaOrAppointments() {
    if (state.view === 'agenda') {
      if (state.agenda) state.agenda.monthKey = ''; /* força recarregar após a mutação */
      return renderAgenda();
    }
    return renderAppointments();
  }

  /* ---------- finances ---------- */

  function financeParams() {
    const f = state.financeFilters;
    const params = new URLSearchParams();
    if (f.from) params.set('from', f.from);
    if (f.to) params.set('to', f.to);
    if (f.service_id && f.service_id !== 'all') params.set('service_id', f.service_id);
    if (f.type && f.type !== 'all') params.set('type', f.type);
    if (f.customer.trim()) params.set('customer', f.customer.trim());
    if (f.min !== '' && f.min != null) params.set('min', f.min);
    if (f.max !== '' && f.max != null) params.set('max', f.max);
    return params;
  }

  function mondayOfWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const diff = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - diff);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function financeRangeForPeriod(period) {
    const t = todayStr();
    if (period === 'today') return { from: t, to: t };
    if (period === 'week') {
      const monday = mondayOfWeek(t);
      const sunday = new Date(monday + 'T00:00:00');
      sunday.setDate(sunday.getDate() + 6);
      return { from: monday, to: `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}` };
    }
    if (period === 'month') {
      const last = new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)), 0).getDate();
      return { from: t.slice(0, 7) + '-01', to: t.slice(0, 7) + '-' + String(last).padStart(2, '0') };
    }
    return { from: state.financeFilters.from, to: state.financeFilters.to };
  }

  async function renderFinances() {
    await loadBase();
    const el = $('view-finances');
    const f = state.financeFilters;
    const range = financeRangeForPeriod(f.period);
    if (f.period !== 'custom') {
      f.from = range.from;
      f.to = range.to;
    }
    const params = financeParams();

    const [summary, entries] = await Promise.all([
      api('/api/admin/financials/summary?' + params.toString()),
      api('/api/admin/financials/entries?' + params.toString())
    ]);
    state.financeEntries = entries;

    const serviceOpts = state.services
      .map((s) => `<option value="${s.id}" ${String(s.id) === String(f.service_id) ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
      .join('');

    const typeBadge = (t) => t === 'saida'
      ? '<span class="badge badge-saida">Saída</span>'
      : '<span class="badge badge-entrada">Entrada</span>';

    const rows = entries.map((e) => `
      <tr>
        <td>${toDateBR(e.entry_date)}<br /><span class="muted">${escapeHtml(e.entry_time)}</span></td>
        <td>${typeBadge(e.type)}</td>
        <td><strong>${escapeHtml(e.customer_name)}</strong></td>
        <td>${escapeHtml(e.service_name || e.current_service_name || '—')}${e.payment_method ? `<br/><span class="muted">${escapeHtml(PAYMENT_LABELS[e.payment_method] || e.payment_method)}</span>` : ''}</td>
        <td><strong style="color:${e.type === 'saida' ? 'var(--red)' : 'var(--green)'}">${e.type === 'saida' ? '−' : '+'} ${money(e.amount)}</strong></td>
        <td><div class="row-actions">
          <button class="btn btn-sm btn-outline" data-action="editEntry" data-id="${e.id}">Editar</button>
          <button class="btn btn-sm btn-danger" data-action="deleteEntry" data-id="${e.id}">Excluir</button>
        </div></td>
      </tr>`).join('');

    const dayRows = summary.by_day.map((d) => `
      <tr><td>${toDateBR(d.date)}</td><td>${d.count}</td><td><strong style="color:var(--green)">${money(d.total)}</strong></td><td><strong style="color:var(--red)">${money(d.saida)}</strong></td><td><strong>${money(d.saldo)}</strong></td></tr>`).join('');

    const serviceRows = summary.by_service.map((s) => `
      <tr><td>${escapeHtml(s.service_name)}</td><td>${s.count}</td><td><strong>${money(s.total)}</strong></td></tr>`).join('');

    const clientRows = summary.by_client.slice(0, 10).map((c) => `
      <tr><td>${escapeHtml(c.customer_name)}</td><td>${c.count}</td><td><strong>${money(c.total)}</strong></td></tr>`).join('');

    const t = summary.totals;
    const plural = (n) => (n === 1 ? 'lançamento' : 'lançamentos');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Financeiro</h1><div class="sub">Entradas e saídas de caixa — dia, semana e mês</div></div>
        <div class="header-actions">
          <button class="btn btn-outline" id="btnNewOutcome">+ Cadastrar saída</button>
          <button class="btn btn-primary" id="btnNewEntry">+ Nova entrada</button>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-value" style="color:var(--green)">${money(t.day.entrada)}</div><div class="stat-label">Faturado hoje</div><div class="stat-sub">Semana ${money(t.week.entrada)} · Mês ${money(t.month.entrada)}</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--red)">${money(t.day.saida)}</div><div class="stat-label">Saídas hoje</div><div class="stat-sub">Semana ${money(t.week.saida)} · Mês ${money(t.month.saida)}</div></div>
        <div class="stat-card"><div class="stat-value">${money(t.day.saldo)}</div><div class="stat-label">Saldo de hoje</div><div class="stat-sub">Entradas − saídas do dia</div></div>
        <div class="stat-card"><div class="stat-value" style="color:var(--accent)">${money(summary.filtered.saldo)}</div><div class="stat-label">Saldo do período (${summary.filtered.count} ${plural(summary.filtered.count)})</div><div class="stat-sub">Entradas ${money(summary.filtered.entrada)} · Saídas ${money(summary.filtered.saida)}</div></div>
      </div>
      <div class="panel" style="margin-top:18px;">
        <h3 class="review-section-title">Filtros</h3>
        <div class="toolbar">
          <select id="finPeriod">
            <option value="today">Hoje</option>
            <option value="week">Esta semana</option>
            <option value="month">Este mês</option>
            <option value="custom">Personalizado</option>
          </select>
          <input type="date" id="finFrom" value="${escapeHtml(f.from || '')}" title="De" />
          <input type="date" id="finTo" value="${escapeHtml(f.to || '')}" title="Até" />
          <select id="finType">
            <option value="all">Entrada e saída</option>
            <option value="entrada">Somente entradas</option>
            <option value="saida">Somente saídas</option>
          </select>
          <select id="finService"><option value="all">Todos os serviços</option>${serviceOpts}</select>
          <input type="text" id="finCustomer" value="${escapeHtml(f.customer)}" placeholder="Cliente..." />
          <input type="number" id="finMin" value="${escapeHtml(f.min)}" placeholder="Valor mín. (R$)" min="0" step="0.01" style="min-width:130px;" />
          <input type="number" id="finMax" value="${escapeHtml(f.max)}" placeholder="Valor máx. (R$)" min="0" step="0.01" style="min-width:130px;" />
          <button class="btn btn-primary btn-sm" id="finApply">Aplicar</button>
          <button class="btn btn-ghost btn-sm" id="finClear">Limpar</button>
        </div>
      </div>
      <div class="panel">
        <h3 class="review-section-title">Lançamentos</h3>
        ${entries.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Data</th><th>Tipo</th><th>Cliente</th><th>Serviço</th><th>Valor</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhum lançamento neste filtro.</div>'}
      </div>
      <div class="grid-3">
        <div class="panel">
          <h3 class="review-section-title">Faturamento por dia</h3>
          ${summary.by_day.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Dia</th><th>Nº</th><th>Entradas</th><th>Saídas</th><th>Saldo</th></tr></thead>
            <tbody>${dayRows}</tbody>
          </table></div>` : '<div class="empty-state">Sem dados.</div>'}
        </div>
        <div class="panel">
          <h3 class="review-section-title">Por serviço</h3>
          ${summary.by_service.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Serviço</th><th>Nº</th><th>Total</th></tr></thead>
            <tbody>${serviceRows}</tbody>
          </table></div>` : '<div class="empty-state">Sem dados.</div>'}
        </div>
        <div class="panel">
          <h3 class="review-section-title">Por cliente (top 10)</h3>
          ${summary.by_client.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Cliente</th><th>Nº</th><th>Total</th></tr></thead>
            <tbody>${clientRows}</tbody>
          </table></div>` : '<div class="empty-state">Sem dados.</div>'}
        </div>
      </div>
    `;

    $('finPeriod').value = f.period;
    $('finPeriod').addEventListener('change', (e) => {
      const p = e.target.value;
      f.period = p;
      if (p !== 'custom') {
        const r = financeRangeForPeriod(p);
        f.from = r.from;
        f.to = r.to;
      }
      renderFinances();
    });
    $('finFrom').addEventListener('change', (e) => { f.from = e.target.value; f.period = 'custom'; $('finPeriod').value = 'custom'; });
    $('finTo').addEventListener('change', (e) => { f.to = e.target.value; f.period = 'custom'; $('finPeriod').value = 'custom'; });
    $('finApply').addEventListener('click', () => {
      f.service_id = $('finService').value;
      f.type = $('finType').value;
      f.customer = $('finCustomer').value;
      f.min = $('finMin').value;
      f.max = $('finMax').value;
      renderFinances();
    });
    $('finClear').addEventListener('click', () => {
      Object.assign(f, { period: 'month', from: '', to: '', service_id: 'all', type: 'all', customer: '', min: '', max: '' });
      renderFinances();
    });
    $('btnNewEntry').addEventListener('click', () => openEntryModal(null, 'entrada'));
    $('btnNewOutcome').addEventListener('click', () => openEntryModal(null, 'saida'));
    el.querySelectorAll('[data-action="editEntry"]').forEach((b) => b.addEventListener('click', () => openEntryModal(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="deleteEntry"]').forEach((b) => b.addEventListener('click', () => deleteEntry(Number(b.dataset.id))));
  }

  async function openEntryModal(id, presetType) {
    await loadBase();
    const entry = id ? ((state.financeEntries || []).find((r) => r.id === id) || null) : null;
    const type = entry ? (entry.type === 'saida' ? 'saida' : 'entrada') : (presetType === 'saida' ? 'saida' : 'entrada');
    const isSaida = type === 'saida';
    const v = (field, def) => (entry && entry[field] != null ? entry[field] : def);
    const now = new Date();
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const serviceOpts = '<option value="">Sem serviço</option>' + state.services
      .map((s) => `<option value="${s.id}" ${entry && entry.service_id == s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`)
      .join('');
    const payOpts = ['', 'local', 'card', 'pix', 'qrcode'].map((p) =>
      `<option value="${p}" ${entry && entry.payment_method === p ? 'selected' : ''}>${p ? PAYMENT_LABELS[p] : 'Sem forma de pagamento'}</option>`
    ).join('');

    openModal(isSaida ? 'Cadastrar saída' : (id ? 'Editar entrada' : 'Nova entrada'), `
      <form id="entryForm" novalidate>
        <div class="form-grid">
          <div class="field span-2"><label for="entryType">Tipo de lançamento</label>
            <select id="entryType">
              <option value="entrada" ${type === 'entrada' ? 'selected' : ''}>Entrada (receita)</option>
              <option value="saida" ${type === 'saida' ? 'selected' : ''}>Saída (despesa)</option>
            </select></div>
          <div class="field span-2">${fieldHtml('entryName', isSaida ? 'Nome / descrição' : 'Nome do cliente', v('customer_name', isSaida ? '' : null), 'text', isSaida ? 'Ex: Compra de produtos de limpeza' : 'Cliente')}</div>
          <div class="field"><label for="entryDate">Data</label><input type="date" id="entryDate" value="${escapeHtml(v('entry_date', todayStr()))}" /></div>
          <div class="field"><label for="entryTime">Horário</label><input type="time" id="entryTime" value="${escapeHtml(v('entry_time', nowTime))}" /></div>
          <div class="field span-2" id="entryServiceWrap"><label for="entryService">Serviço</label>
            <select id="entryService">${serviceOpts}</select></div>
          <div class="field"><label for="entryAmount">Valor (R$)</label>
            <input type="number" id="entryAmount" value="${escapeHtml(v('amount', ''))}" step="0.01" min="0" /></div>
          <div class="field"><label for="entryPayment">Forma de pagamento</label>
            <select id="entryPayment">${payOpts}</select></div>
          <div class="field span-2"><label for="entryNotes">Observações</label>
            <textarea id="entryNotes" rows="2">${escapeHtml(v('notes', ''))}</textarea></div>
        </div>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="entrySave">${id ? 'Salvar' : (isSaida ? 'Registrar saída' : 'Registrar entrada')}</button>
    `);

    $('entryServiceWrap').style.display = isSaida ? 'none' : '';

    $('entryType').addEventListener('change', () => {
      const nowIsSaida = $('entryType').value === 'saida';
      const nameLabel = document.querySelector('label[for="entryName"]');
      if (nameLabel) nameLabel.textContent = nowIsSaida ? 'Nome / descrição' : 'Nome do cliente';
      $('entryServiceWrap').style.display = nowIsSaida ? 'none' : '';
    });

    $('entrySave').addEventListener('click', async () => {
      const isNowSaida = $('entryType').value === 'saida';
      const body = {
        type: isNowSaida ? 'saida' : 'entrada',
        customer_name: $('entryName').value,
        entry_date: $('entryDate').value,
        entry_time: $('entryTime').value || null,
        service_id: isNowSaida ? null : ($('entryService').value ? Number($('entryService').value) : null),
        amount: $('entryAmount').value,
        payment_method: $('entryPayment').value || null,
        notes: $('entryNotes').value || null
      };
      try {
        showLoader();
        await api(id ? '/api/admin/financials/entries/' + id : '/api/admin/financials/entries', {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(body)
        });
        closeModal();
        await renderFinances();
        toast(id ? 'Lançamento atualizado.' : (isNowSaida ? 'Saída registrada.' : 'Entrada registrada.'), 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  async function deleteEntry(id) {
    if (!confirm('Excluir este lançamento?')) return;
    try {
      showLoader();
      await api('/api/admin/financials/entries/' + id, { method: 'DELETE' });
      await renderFinances();
      toast('Lançamento excluído.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  /* ---------- appointment modal (create/edit) ---------- */

  async function openAppointmentModal(id, prefill) {
    let appt = null;
    if (id) appt = await api('/api/admin/appointments/' + id);
    await loadBase();

    const modOpts = state.modalities.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
    const unitOpts = state.units.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    const serviceOpts = state.services.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    const catOpts = Object.keys(CATEGORY_LABELS).map((k) => `<option value="${k}">${CATEGORY_LABELS[k]}</option>`).join('');
    const statusOpts = STATUS_BADGES.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('');

    /* Pacotes vendidos utilizáveis (usados para escolher crédito no agendamento). */
    state.customerPackages = await api('/api/admin/customer-packages').catch(() => []);

    const v = (field, def) => (appt && appt[field] != null ? appt[field] : def);

    const packageOptsFor = (serviceId) => {
      const usable = state.customerPackages.filter((cp) => cp.can_reserve);
      return usable.map((cp) => {
        let label = `${cp.package_name} — ${cp.totals ? cp.totals.available : 0} crédito(s)`;
        if (serviceId && cp.balances) {
          const bal = cp.balances.find((b) => b.service_id === serviceId);
          if (bal) label = `${cp.package_name} — ${bal.available} × ${bal.service_name}`;
          else return '';
        }
        if (cp.expires_at) label += ` · válido até ${toDateBR(cp.expires_at)}`;
        return `<option value="${cp.id}">${escapeHtml(label)}</option>`;
      }).filter(Boolean).join('');
    };

    openModal(id ? 'Editar agendamento' : 'Novo agendamento', `
      <form id="apptForm" novalidate>
        <div class="form-grid">
          <div class="field"><label>Forma de atendimento</label>
            <select id="apptModality">${modOpts}</select></div>
          <div class="field"><label>Unidade</label>
            <select id="apptUnit"><option value="">—</option>${unitOpts}</select></div>
          <div class="field span-2"><label>Serviço</label>
            <select id="apptService"><option value="">—</option>${serviceOpts}</select></div>
          <div class="field span-2"><label>Pacote de serviços</label>
            <select id="apptPackage">
              <option value="">Sem pacote (pagamento normal)</option>
              ${packageOptsFor('')}
            </select>
            <div class="muted" style="font-size:12px;">Ao selecionar um pacote, o serviço acima é reservado do saldo do cliente.</div></div>
          <div class="field">${fieldHtml('apptName', 'Nome', v('customer_name'), 'text', 'Cliente')}</div>
          <div class="field">${fieldHtml('apptPhone', 'Telefone', v('customer_phone'), 'text', '(00) 00000-0000')}</div>
          <div class="field">${fieldHtml('apptBrand', 'Marca', v('vehicle_brand'), 'text', 'Marca')}</div>
          <div class="field">${fieldHtml('apptModel', 'Modelo', v('vehicle_model'), 'text', 'Modelo')}</div>
          <div class="field"><label for="apptCategory">Categoria</label>
            <select id="apptCategory">${catOpts}</select></div>
          <div class="field">${fieldHtml('apptPlate', 'Placa', v('vehicle_plate'), 'text', 'ABC-1D23')}</div>
          <div class="field"><label for="apptDate">Data</label><input type="date" id="apptDate" value="${escapeHtml(v('appointment_date', (prefill && prefill.date) || todayStr()))}" /></div>
          <div class="field">${fieldHtml('apptTime', 'Início', v('start_time', (prefill && prefill.time) || ''), 'time')}</div>
          <div class="field"><label class="switch-row"><input type="checkbox" id="apptManualEnd" ${v('end_time') ? 'checked' : ''} /><span>Definir término manualmente</span></label></div>
          <div class="field" id="apptEndWrap"><label for="apptEndDate">Término (data)</label><input type="date" id="apptEndDate" value="${escapeHtml(v('end_date', v('appointment_date', todayStr())))}" /></div>
          <div class="field" id="apptEndTimeWrap">${fieldHtml('apptEndTime', 'Término (hora)', v('end_time', ''), 'time')}</div>
          <div class="field"><label for="apptStatus">Status</label>
            <select id="apptStatus">${statusOpts}</select></div>
          <div class="field"><label for="apptPayment">Forma de pagamento</label>
            <select id="apptPayment">
              <option value="">—</option>
              <option value="local">Pagamento no local</option>
              <option value="card">Crédito ou débito no local</option>
              <option value="pix">Pix (copia e cola)</option>
              <option value="qrcode">Pix (QR Code)</option>
            </select></div>
          <div class="field"><label for="apptPrice">Preço do serviço (R$)</label>
            <input type="number" id="apptPrice" value="${escapeHtml(v('service_price', ''))}" step="0.01" min="0" /></div>
          <div class="field"><label for="apptFee">Taxa da modalidade (R$)</label>
            <input type="number" id="apptFee" value="${escapeHtml(v('modality_fee', ''))}" step="0.01" min="0" /></div>
          <div class="field span-2"><label for="apptNotes">Observações</label>
            <textarea id="apptNotes" rows="2">${escapeHtml(v('customer_notes', ''))}</textarea></div>
        </div>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="apptSave">${id ? 'Salvar' : 'Criar agendamento'}</button>
    `);

    if (appt) {
      $('apptModality').value = appt.modality_id;
      $('apptUnit').value = appt.unit_id || '';
      $('apptService').value = appt.service_id || '';
      $('apptCategory').value = appt.vehicle_category;
      $('apptStatus').value = appt.status;
      $('apptPayment').value = appt.payment_method || '';
      if (appt.customer_package_id) {
        const sel = $('apptPackage');
        const existing = sel.querySelector(`option[value="${appt.customer_package_id}"]`);
        if (!existing) {
          const cp = state.customerPackages.find((x) => x.id === appt.customer_package_id);
          sel.insertAdjacentHTML('beforeend', `<option value="${appt.customer_package_id}">${escapeHtml(cp ? cp.package_name : 'Pacote ' + appt.customer_package_id)}</option>`);
        }
        sel.value = String(appt.customer_package_id);
      }
    } else if (prefill && prefill.unitId) {
      $('apptUnit').value = prefill.unitId;
    }
    const refreshPackageOpts = () => {
      const sel = $('apptPackage');
      const current = appt && appt.customer_package_id ? String(appt.customer_package_id) : (sel.value || '');
      const serviceId = Number($('apptService').value) || 0;
      sel.innerHTML = `<option value="">Sem pacote (pagamento normal)</option>${packageOptsFor(serviceId)}`;
      if (current && sel.querySelector(`option[value="${current}"]`)) sel.value = current;
    };
    $('apptService').addEventListener('change', refreshPackageOpts);
    const toggleManualEnd = () => {
      const on = $('apptManualEnd').checked;
      $('apptEndWrap').hidden = !on;
      $('apptEndTimeWrap').hidden = !on;
    };
    $('apptManualEnd').addEventListener('change', toggleManualEnd);
    toggleManualEnd();
    $('apptSave').addEventListener('click', async () => {
      const manualEnd = $('apptManualEnd').checked;
      const body = {
        modality_id: Number($('apptModality').value),
        unit_id: $('apptUnit').value ? Number($('apptUnit').value) : null,
        service_id: Number($('apptService').value),
        customer_name: $('apptName').value,
        customer_phone: $('apptPhone').value,
        vehicle_brand: $('apptBrand').value,
        vehicle_model: $('apptModel').value,
        vehicle_year: null,
        vehicle_plate: $('apptPlate').value || null,
        vehicle_color: null,
        vehicle_category: $('apptCategory').value,
        appointment_date: $('apptDate').value,
        start_time: $('apptTime').value,
        status: $('apptStatus').value,
        payment_method: $('apptPayment').value || null,
        customer_notes: $('apptNotes').value || null,
        customer_package_id: $('apptPackage').value ? Number($('apptPackage').value) : null
      };
      if (manualEnd) {
        body.manual_end = 1;
        body.end_date = $('apptEndDate').value;
        body.end_time = $('apptEndTime').value;
      }
      try {
        showLoader();
        const saved = await api(id ? '/api/admin/appointments/' + id : '/api/admin/appointments', {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(body)
        });
        closeModal();
        await renderAgendaOrAppointments();
        toast(id ? 'Agendamento atualizado.' : `Agendamento ${saved.appointment_code} criado.`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  /* ---------- reject modal ---------- */

  function openRejectModal(id) {
    openModal('Recusar agendamento', `
      <p class="muted" style="margin-bottom:14px;">Informe o motivo da recusa. O horário será liberado automaticamente.</p>
      <div class="field"><label for="rejectReason">Motivo da recusa</label>
        <select id="rejectReason">${REJECTION_REASONS.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}</select></div>
      <div class="field"><label for="rejectMsg">Mensagem (opcional)</label>
        <textarea id="rejectMsg" rows="3" placeholder="Explique o motivo ao cliente..."></textarea></div>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-danger" id="rejectSave">Confirmar recusa</button>
    `);
    $('rejectSave').addEventListener('click', async () => {
      const body = { rejection_reason: $('rejectReason').value, rejection_message: $('rejectMsg').value || null };
      try {
        showLoader();
        await api(`/api/admin/appointments/${id}/reject`, { method: 'PATCH', body: JSON.stringify(body) });
        closeModal();
        await renderAgendaOrAppointments();
        toast('Agendamento recusado.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  /* ---------- appointment detail modal ---------- */

  async function openDetailModal(id) {
    const a = await api('/api/admin/appointments/' + id);
    const lines = [
      ['Código', a.appointment_code],
      ['Status', STATUS_LABELS[a.status] || a.status],
      ['Cliente', a.customer_name],
      ['Telefone', a.customer_phone],
      ['E-mail', a.customer_email],
      ['CPF', a.customer_cpf],
      ['Veículo', `${a.vehicle_brand || ''} ${a.vehicle_model || ''}${a.vehicle_year ? ' · ' + a.vehicle_year : ''}`],
      ['Placa', a.vehicle_plate],
      ['Cor', a.vehicle_color],
      ['Categoria', CATEGORY_LABELS[a.vehicle_category] || a.vehicle_category],
      ['Data', toDateBR(a.appointment_date) + (a.end_date && a.end_date !== a.appointment_date ? ' → ' + toDateBR(a.end_date) : '')],
      ['Horário', isLongAppointment(a) ? 'Horário a confirmar' : `${a.start_time} às ${a.end_time}`],
      ['Duração', a.booked_duration_minutes ? fmtDur(a.booked_duration_minutes) : ''],
      ['Serviço', a.service_name],
      ['Modalidade', a.modality_name],
      ['Unidade', a.unit_name],
      ['Pagamento', a.payment_method ? (PAYMENT_LABELS[a.payment_method] || a.payment_method) : ''],
      ['Preço serviço', money(a.service_price)],
      ['Taxa', money(a.modality_fee)],
      ['Total', money(a.total_price) + (a.price_is_estimate ? ' (estimativa)' : '')],
      ['Endereço', [a.address_street, a.address_number, a.address_complement, a.address_neighborhood, a.address_city, a.address_state].filter(Boolean).join(', ')],
      ['Responsável chave', a.responsible_name],
      ['Observações', a.customer_notes]
    ];
    const reasonLines = [];
    if (a.rejection_reason) reasonLines.push(['Motivo recusa', a.rejection_reason], ['Mensagem', a.rejection_message]);
    if (a.rejected_at) reasonLines.push(['Recusado em', a.rejected_at + (a.rejected_by ? ' por ' + a.rejected_by : '')]);
    if (a.approved_at) reasonLines.push(['Aprovado em', a.approved_at + (a.approved_by ? ' por ' + a.approved_by : '')]);

    const actionButtons = [];
    if (a.status === 'pending') {
      actionButtons.push('<button class="btn btn-success" data-modal-action="accept">Aceitar</button>');
      actionButtons.push('<button class="btn btn-danger" data-modal-action="reject">Recusar</button>');
    }
    if (a.status === 'confirmed') {
      actionButtons.push('<button class="btn btn-success" data-modal-action="complete">Concluir</button>');
      actionButtons.push('<button class="btn btn-outline" data-modal-action="cancel">Cancelar</button>');
    }
    if (a.status === 'pending' || a.status === 'confirmed') {
      actionButtons.push('<button class="btn btn-outline" data-modal-action="edit">Editar</button>');
    }
    actionButtons.push('<button class="btn btn-danger" data-modal-action="delete">Excluir</button>');

    const overlay = openModal('Detalhes do agendamento', `
      <div class="panel">
        ${lines.filter(([, val]) => val).map(([k, val]) => `<div class="review-line"><span>${escapeHtml(k)}</span><strong>${escapeHtml(val)}</strong></div>`).join('')}
        ${reasonLines.length ? `<div class="review-total">${reasonLines.filter(([, val]) => val).map(([k, val]) => `<div class="review-line"><span>${escapeHtml(k)}</span><strong>${escapeHtml(val)}</strong></div>`).join('')}</div>` : ''}
      </div>
    `, `${actionButtons.join('')}<button class="btn btn-ghost" data-close>Fechar</button>`);

    overlay.querySelectorAll('[data-modal-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.modalAction;
        if (action === 'edit') { closeModal(); openAppointmentModal(id); return; }
        if (action === 'reject') { closeModal(); openRejectModal(id); return; }
        if (action === 'accept') { confirmAction('Aceitar este agendamento?', `/api/admin/appointments/${id}/accept`, 'PATCH', null, () => { closeModal(); renderAgendaOrAppointments(); }); return; }
        if (action === 'complete') { confirmAction('Marcar como concluído?', `/api/admin/appointments/${id}/status`, 'PATCH', { status: 'completed' }, () => { closeModal(); renderAgendaOrAppointments(); }); return; }
        if (action === 'cancel') { confirmAction('Cancelar este agendamento?', `/api/admin/appointments/${id}/status`, 'PATCH', { status: 'cancelled' }, () => { closeModal(); renderAgendaOrAppointments(); }); return; }
        if (action === 'delete') { confirmAction('Excluir definitivamente este agendamento?', `/api/admin/appointments/${id}`, 'DELETE', null, () => { closeModal(); renderAgendaOrAppointments(); }); }
      });
    });
  }

  /* ---------- contrato ---------- */

  const CONTRACT_TYPE_LABELS = { SUBSCRIPTION: 'Assinatura', RENEWAL: 'Renovação', ADDENDUM: 'Aditivo', CANCELLATION: 'Distrato', CUSTOM: 'Personalizado' };
  const CONTRACT_STATUS_LABELS = { FINALIZED: 'Vigente', CANCELLED: 'Cancelado', EXPIRED: 'Expirado', REPLACED: 'Substituído' };

  function contractTypeLabel(t) { return CONTRACT_TYPE_LABELS[t] || t; }
  function contractStatusBadge(s) {
    const cls = { FINALIZED: 'badge-entrada', CANCELLED: 'badge-saida', EXPIRED: 'badge-saida', REPLACED: 'badge-saida' }[s] || '';
    return `<span class="badge ${cls}">${escapeHtml(CONTRACT_STATUS_LABELS[s] || s)}</span>`;
  }

  /* Baixa o PDF do contrato autenticado (o navegador não envia o Bearer
     token em downloads via <a href>, por isso busca com fetch e monta o
     blob localmente — mesmo padrão usado no painel do desenvolvedor). */
  async function downloadContractPdf(id, fallbackName) {
    try {
      const headers = {};
      if (state.token) headers.Authorization = 'Bearer ' + state.token;
      const res = await fetch(`/api/admin/contracts/${id}/download`, { headers });
      if (!res.ok) {
        if (res.status === 404) throw new Error('Arquivo não encontrado.');
        const data = await res.json().catch(() => null);
        throw new Error((data && data.error) || 'Falha ao baixar o contrato.');
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const cd = res.headers.get('Content-Disposition') || '';
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      a.download = m ? m[1] : (fallbackName || 'contrato.pdf');
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('Contrato baixado.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function renderContract() {
    const el = $('view-contract');
    const contracts = await api('/api/admin/contracts');
    if (!contracts.length) {
      el.innerHTML = `
        <div class="admin-header"><div><h1>Contrato</h1><div class="sub">Contrato de prestação de serviços com a PapiCore</div></div></div>
        <div class="empty-state">Nenhum contrato disponível ainda. Assim que a PapiCore finalizar seu contrato, ele aparece aqui para download.</div>`;
      return;
    }
    const rows = contracts.map((c) => `
      <tr>
        <td><strong>${escapeHtml(c.contract_number)}</strong></td>
        <td>${escapeHtml(contractTypeLabel(c.contract_type))}</td>
        <td>${escapeHtml(c.plan_name || '—')}</td>
        <td><strong>${money((c.total_cents || 0) / 100)}</strong></td>
        <td>${toDateBR(c.start_date)} – ${toDateBR(c.end_date)}</td>
        <td>${contractStatusBadge(c.status)}</td>
        <td>${c.has_pdf ? `<button class="btn btn-sm btn-primary" data-action="downloadContract" data-id="${c.id}" data-number="${escapeHtml(c.contract_number)}">Baixar PDF</button>` : '<span class="muted">Sem PDF</span>'}</td>
      </tr>`).join('');
    el.innerHTML = `
      <div class="admin-header"><div><h1>Contrato</h1><div class="sub">Contrato de prestação de serviços com a PapiCore</div></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Número</th><th>Tipo</th><th>Plano</th><th>Valor</th><th>Vigência</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
    el.querySelectorAll('[data-action="downloadContract"]').forEach((btn) => {
      btn.addEventListener('click', () => downloadContractPdf(btn.dataset.id, `${btn.dataset.number}.pdf`));
    });
  }

  /* ---------- services ---------- */

  async function renderServices() {
    await loadBase();
    const el = $('view-services');
    const catRows = state.categories.map((c) => {
      const n = state.services.filter((s) => s.category_id === c.id).length;
      return `<tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${n} serviço(s)</td>
        <td>${c.display_order}</td>
        <td>${c.active ? badge('confirmed') : badge('cancelled')}</td>
        <td><div class="appointment-actions">${actionButton('editCategory', c.id, { icon: 'edit', label: 'Editar categoria' })}</div></td>
      </tr>`;
    }).join('');

    const serviceRows = state.services.map((s) => {
      let priceHtml = '';
      if (s.price_type === 'fixed') priceHtml = money(s.fixed_price);
      else if (s.price_type === 'starting') priceHtml = `a partir de ${money(s.starting_price)}`;
      else {
        priceHtml = Object.keys(CATEGORY_LABELS).map((k) => `${CATEGORY_LABELS[k]}: ${money(s['price_' + k] || 0)}`).join('<br/>');
      }
      const flags = [];
      if (s.available_at_unit) flags.push('Unidade');
      if (s.available_pickup_delivery) flags.push('Leva e traz');
      if (s.available_mobile_delivery) flags.push('Delivery');
      return `<tr>
        <td><strong>${escapeHtml(s.name)}</strong><br /><span class="muted">${escapeHtml(s.category_name)}</span></td>
        <td>${priceHtml}</td>
        <td>${fmtDur(s.duration_minutes)}${s.utilitario_extra_minutes ? `<br/><span class="muted">utilitário +${fmtDur(s.utilitario_extra_minutes)}</span>` : ''}</td>
        <td><span class="muted">${flags.join(' · ') || '—'}</span></td>
        <td>${s.active ? badge('confirmed') : badge('cancelled')}</td>
        <td><div class="appointment-actions">
          ${actionButton('editService', s.id, { icon: 'edit', label: 'Editar serviço' })}
          ${actionButton('toggleService', s.id, { icon: s.active ? 'cancel' : 'accept', label: s.active ? 'Desativar serviço' : 'Ativar serviço' })}
          ${actionButton('deleteService', s.id, { icon: 'delete', label: 'Excluir serviço' })}
        </div></td>
      </tr>`;
    }).join('');

    el.innerHTML = `
        <div class="admin-header">
        <div><h1>Serviços e valores</h1><div class="sub">Catálogo exibido no agendamento do cliente</div></div>
        <div class="header-actions">
          <button class="btn btn-ghost" id="btnNewCategory">+ Nova categoria</button>
          <button class="btn btn-primary" id="btnNewService">+ Novo serviço</button>
        </div>
      </div>
      <div class="panel">
        <h3 class="review-section-title">Categorias</h3>
        ${state.categories.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Categoria</th><th>Serviços</th><th>Ordem</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${catRows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhuma categoria.</div>'}
      </div>
      <div class="panel">
        <h3 class="review-section-title">Serviços</h3>
        ${state.services.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Serviço</th><th>Preço</th><th>Duração</th><th>Disponibilidade</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${serviceRows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhum serviço cadastrado.</div>'}
      </div>
    `;

    $('btnNewService').addEventListener('click', () => openServiceModal());
    $('btnNewCategory').addEventListener('click', () => openCategoryModal());
    el.querySelectorAll('[data-action="editService"]').forEach((b) => b.addEventListener('click', () => openServiceModal(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="editCategory"]').forEach((b) => b.addEventListener('click', () => openCategoryModal(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="toggleService"]').forEach((b) => b.addEventListener('click', () => toggleService(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="deleteService"]').forEach((b) => b.addEventListener('click', () => deleteService(Number(b.dataset.id))));
  }

  async function openServiceModal(id) {
    let svc = null;
    if (id) svc = state.services.find((s) => s.id === id) || await api('/api/admin/services/' + id);
    const catOpts = state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    const type = svc ? svc.price_type : 'category';
    const v = (f, def) => (svc && svc[f] != null ? svc[f] : def);

    openModal(id ? 'Editar serviço' : 'Novo serviço', `
      <form id="serviceForm" novalidate>
        <div class="form-grid">
          <div class="field"><label>Categoria</label><select id="svcCategory">${catOpts}</select></div>
          <div class="field">${fieldHtml('svcName', 'Nome', v('name'), 'text', 'Nome do serviço')}</div>
          <div class="field span-2"><label>Descrição</label>
            <textarea id="svcDesc" rows="2">${escapeHtml(v('description', ''))}</textarea></div>
          <div class="field"><label>Tipo de preço</label>
            <select id="svcPriceType">
              <option value="category">Por categoria de veículo</option>
              <option value="fixed">Preço fixo</option>
              <option value="starting">A partir de</option>
            </select></div>
          <div class="field">${fieldHtml('svcDuration', 'Duração (minutos)', v('duration_minutes', 60), 'number')}</div>
          <div class="field">${fieldHtml('svcUtilitarioExtra', 'Acréscimo para utilitário (min)', v('utilitario_extra_minutes', 0), 'number')}</div>
        </div>
        <div id="svcPriceFields"></div>
        <div class="field"><label for="svcItems">Itens do pacote (um por linha)</label>
          <textarea id="svcItems" rows="4" placeholder="Lavagem técnica&#10;Cera de proteção">${escapeHtml((v('package_items', []) || []).join('\n'))}</textarea></div>
        <div class="checkbox-row" style="gap:16px;margin-bottom:6px;">
          <label class="switch-row"><input type="checkbox" id="svcUnit" ${v('available_at_unit', 1) ? 'checked' : ''} /><span>Unidade</span></label>
          <label class="switch-row"><input type="checkbox" id="svcPickup" ${v('available_pickup_delivery', 1) ? 'checked' : ''} /><span>Leva e traz</span></label>
          <label class="switch-row"><input type="checkbox" id="svcDelivery" ${v('available_mobile_delivery', 1) ? 'checked' : ''} /><span>Delivery</span></label>
          <label class="switch-row"><input type="checkbox" id="svcActive" ${v('active', 1) ? 'checked' : ''} /><span>Ativo</span></label>
        </div>
        <div class="field">${fieldHtml('svcOrder', 'Ordem de exibição', v('display_order', 0), 'number')}</div>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="svcSave">${id ? 'Salvar' : 'Criar serviço'}</button>
    `);

    $('svcCategory').value = svc ? svc.category_id : (state.categories[0] ? state.categories[0].id : '');
    $('svcPriceType').value = type;
    $('svcPriceType').addEventListener('change', renderServicePriceFields);
    renderServicePriceFields();

    $('svcSave').addEventListener('click', async () => {
      const priceType = $('svcPriceType').value;
      const body = {
        category_id: Number($('svcCategory').value),
        name: $('svcName').value,
        description: $('svcDesc').value || null,
        price_type: priceType,
        fixed_price: priceType === 'fixed' ? Number($('pfFixed').value) : null,
        price_passeio: priceType === 'category' ? Number($('pfPasseio').value) : null,
        price_utilitario: priceType === 'category' ? Number($('pfUtilitario').value) : null,
        starting_price: priceType === 'starting' ? Number($('pfStarting').value) : null,
        duration_minutes: Number($('svcDuration').value),
        utilitario_extra_minutes: Number($('svcUtilitarioExtra').value || 0),
        package_items: $('svcItems').value.split('\n').map((i) => i.trim()).filter(Boolean),
        available_at_unit: $('svcUnit').checked ? 1 : 0,
        available_pickup_delivery: $('svcPickup').checked ? 1 : 0,
        available_mobile_delivery: $('svcDelivery').checked ? 1 : 0,
        active: $('svcActive').checked ? 1 : 0,
        display_order: Number($('svcOrder').value || 0)
      };
      try {
        showLoader();
        await api(id ? '/api/admin/services/' + id : '/api/admin/services', {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(body)
        });
        closeModal();
        await renderServices();
        toast(id ? 'Serviço atualizado.' : 'Serviço criado.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });

    function renderServicePriceFields() {
      const t = $('svcPriceType').value;
      const wrap = $('svcPriceFields');
      if (t === 'fixed') {
        wrap.innerHTML = `<div class="field">${fieldHtml('pfFixed', 'Preço fixo (R$)', v('fixed_price', ''), 'number')}</div>`;
      } else if (t === 'starting') {
        wrap.innerHTML = `<div class="field">${fieldHtml('pfStarting', 'Preço a partir de (R$)', v('starting_price', ''), 'number')}</div>`;
      } else {
        wrap.innerHTML = `
          <div class="field-row">
            <div class="field">${fieldHtml('pfPasseio', 'Passeio (R$)', v('price_passeio', ''), 'number')}</div>
            <div class="field">${fieldHtml('pfUtilitario', 'Utilitário (R$)', v('price_utilitario', ''), 'number')}</div>
          </div>`;
      }
    }
  }

  async function toggleService(id) {
    const s = state.services.find((x) => x.id === id);
    if (!s) return;
    try {
      showLoader();
      await api('/api/admin/services/' + id, { method: 'PUT', body: JSON.stringify({ ...s, active: s.active ? 0 : 1 }) });
      await renderServices();
      toast(s.active ? 'Serviço desativado.' : 'Serviço ativado.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  async function deleteService(id) {
    if (!confirm('Excluir este serviço?')) return;
    try {
      showLoader();
      await api('/api/admin/services/' + id, { method: 'DELETE' });
      await renderServices();
      toast('Serviço excluído.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  /* ---------- category modal ---------- */

  async function openCategoryModal(id) {
    let cat = null;
    if (id) cat = state.categories.find((c) => c.id === id);
    openModal(id ? 'Editar categoria' : 'Nova categoria', `
      <form id="catForm" novalidate>
        <div class="field">${fieldHtml('catName', 'Nome', cat ? cat.name : '', 'text', 'Nome da categoria')}</div>
        <div class="field"><label>Descrição</label>
          <textarea id="catDesc" rows="2">${escapeHtml(cat ? cat.description : '')}</textarea></div>
        <div class="field">${fieldHtml('catOrder', 'Ordem de exibição', cat ? cat.display_order : 0, 'number')}</div>
        <label class="switch-row"><input type="checkbox" id="catActive" ${!cat || cat.active ? 'checked' : ''} /><span>Ativa</span></label>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="catSave">${id ? 'Salvar' : 'Criar'}</button>
    `);
    $('catSave').addEventListener('click', async () => {
      try {
        showLoader();
        if (id) {
          await api('/api/admin/service-categories/' + id, {
            method: 'PUT',
            body: JSON.stringify({ name: $('catName').value, description: $('catDesc').value || null, display_order: Number($('catOrder').value || 0), active: $('catActive').checked ? 1 : 0 })
          });
        } else {
          await api('/api/admin/service-categories', {
            method: 'POST',
            body: JSON.stringify({ name: $('catName').value, display_order: Number($('catOrder').value || 0) })
          });
        }
        closeModal();
        await renderServices();
        toast('Categoria salva.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  /* ---------- packages (Fase 1 — Pacotes de Serviços) ---------- */

  function isPackageManager() {
    return state.user && ['owner', 'admin'].includes(state.user.role);
  }

  function packageServiceLine(item) {
    return `${escapeHtml(item.service_name)} × ${item.quantity}`;
  }

  async function renderPackages() {
    await loadBase();
    const isManager = isPackageManager();
    const el = $('view-packages');
    const [models, sold] = await Promise.all([
      api('/api/admin/packages?includeInactive=true').catch(() => []),
      api('/api/admin/customer-packages').catch(() => [])
    ]);

    const modelRows = models.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong><br/><span class="muted">${escapeHtml(p.description || '—')}</span></td>
        <td>${money((p.price_cents || 0) / 100)}</td>
        <td>${p.validity_days ? `${p.validity_days} dias` : 'Sem validade'}</td>
        <td><span class="muted">${p.items.map(packageServiceLine).join('<br/>') || '—'}</span></td>
        <td>${p.active ? badge('confirmed') : badge('cancelled')}</td>
        <td><div class="appointment-actions">
          ${actionButton('editPackage', p.id, { icon: 'edit', label: 'Editar pacote' })}
          ${actionButton('togglePackage', p.id, { icon: p.active ? 'cancel' : 'accept', label: p.active ? 'Desativar pacote' : 'Ativar pacote' })}
        </div></td>
      </tr>`).join('');

    const soldRows = sold.map((cp) => {
      const exp = cp.expires_at ? toDateBR(cp.expires_at) : 'Sem validade';
      const expiredNote = cp.expired ? `<br/><span class="muted" style="color:var(--red);">expirado</span>` : '';
      return `
      <tr>
        <td><strong>${escapeHtml(cp.customer_name)}</strong><br/><span class="muted">${escapeHtml(cp.customer_phone || '')}</span></td>
        <td>${escapeHtml(cp.package_name)}<br/><span class="muted">${money((cp.purchase_price_cents || 0) / 100)}${cp.discount_cents ? ` <span style="color:var(--green);">(−${money(cp.discount_cents / 100)})</span>` : ''}</span></td>
        <td><strong>${cp.totals ? cp.totals.available : 0}</strong> disp. · ${cp.totals ? cp.totals.reserved : 0} reserv. · ${cp.totals ? cp.totals.consumed : 0} usad.</td>
        <td>${exp}${expiredNote}</td>
        <td>${packageBadge(cp.status)}</td>
        <td><div class="appointment-actions">
          ${actionButton('packageStatement', cp.id, { icon: 'detail', label: 'Extrato e saldos' })}
          ${isManager ? actionButton('adjustPackage', cp.id, { icon: 'edit', label: 'Débito/crédito manual' }) : ''}
          ${isManager ? actionButton('cancelPackage', cp.id, { icon: 'cancel', label: 'Cancelar pacote' }) : ''}
        </div></td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Pacotes de serviços</h1><div class="sub">Venda pacotes, acompanhe saldos por cliente e use créditos nos agendamentos</div></div>
        <div class="header-actions">
          ${isManager ? `<button class="btn btn-ghost" id="btnNewPackage">+ Novo pacote</button>` : ''}
          ${isManager ? `<button class="btn btn-primary" id="btnSellPackage">+ Vender pacote</button>` : ''}
        </div>
      </div>
      <div class="panel">
        <h3 class="review-section-title">Modelos de pacote</h3>
        ${models.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Pacote</th><th>Preço</th><th>Validade</th><th>Serviços</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${modelRows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhum modelo de pacote cadastrado.</div>'}
      </div>
      <div class="panel">
        <h3 class="review-section-title">Pacotes vendidos</h3>
        <div class="form-grid" style="grid-template-columns: 1fr 180px auto; margin-bottom: 12px;">
          <div class="field">${fieldHtml('pkgSearch', 'Buscar', '', 'text', 'Cliente, pacote ou telefone')}</div>
          <div class="field"><label for="pkgStatus">Status</label>
            <select id="pkgStatus">
              <option value="all">Todos</option>
              <option value="ACTIVE">Ativo</option>
              <option value="EXHAUSTED">Esgotado</option>
              <option value="EXPIRED">Expirado</option>
              <option value="CANCELLED">Cancelado</option>
              <option value="SUSPENDED">Suspenso</option>
            </select></div>
          <div class="field"><button class="btn btn-ghost" id="pkgFilterBtn" style="margin-top:22px;">Filtrar</button></div>
        </div>
        ${sold.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Cliente</th><th>Pacote</th><th>Saldo</th><th>Validade</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${soldRows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhum pacote vendido.</div>'}
      </div>
    `;

    if (isManager) {
      $('btnNewPackage').addEventListener('click', () => openPackageModal());
      $('btnSellPackage').addEventListener('click', () => openSellPackageModal());
    }
    const doFilter = () => {
      const params = new URLSearchParams();
      const s = ($('pkgSearch') ? $('pkgSearch').value : '').trim();
      const st = $('pkgStatus') ? $('pkgStatus').value : 'all';
      if (s) params.set('search', s);
      if (st !== 'all') params.set('status', st);
      renderPackagesWith(params);
    };
    $('pkgFilterBtn').addEventListener('click', doFilter);
    $('pkgSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') doFilter(); });
    $('pkgStatus').addEventListener('change', doFilter);
    el.querySelectorAll('[data-action="editPackage"]').forEach((b) => b.addEventListener('click', () => openPackageModal(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="togglePackage"]').forEach((b) => b.addEventListener('click', () => togglePackage(Number(b.dataset.id), b.dataset.id)));
    el.querySelectorAll('[data-action="packageStatement"]').forEach((b) => b.addEventListener('click', () => openPackageStatementModal(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="adjustPackage"]').forEach((b) => b.addEventListener('click', () => openAdjustPackageModal(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="cancelPackage"]').forEach((b) => b.addEventListener('click', () => cancelCustomerPackage(Number(b.dataset.id))));
  }

  /* Re-render da lista de vendidos aplicando filtros. */
  async function renderPackagesWith(params) {
    showLoader();
    try {
      const sold = await api('/api/admin/customer-packages?' + params.toString()).catch(() => []);
      const isManager = isPackageManager();
      const rows = sold.map((cp) => {
        const exp = cp.expires_at ? toDateBR(cp.expires_at) : 'Sem validade';
        const expiredNote = cp.expired ? `<br/><span class="muted" style="color:var(--red);">expirado</span>` : '';
        return `
        <tr>
          <td><strong>${escapeHtml(cp.customer_name)}</strong><br/><span class="muted">${escapeHtml(cp.customer_phone || '')}</span></td>
          <td>${escapeHtml(cp.package_name)}<br/><span class="muted">${money((cp.purchase_price_cents || 0) / 100)}</span></td>
          <td><strong>${cp.totals ? cp.totals.available : 0}</strong> disp. · ${cp.totals ? cp.totals.reserved : 0} reserv. · ${cp.totals ? cp.totals.consumed : 0} usad.</td>
          <td>${exp}${expiredNote}</td>
          <td>${packageBadge(cp.status)}</td>
          <td><div class="appointment-actions">
            ${actionButton('packageStatement', cp.id, { icon: 'detail', label: 'Extrato e saldos' })}
            ${isManager ? actionButton('adjustPackage', cp.id, { icon: 'edit', label: 'Débito/crédito manual' }) : ''}
            ${isManager ? actionButton('cancelPackage', cp.id, { icon: 'cancel', label: 'Cancelar pacote' }) : ''}
          </div></td>
        </tr>`;
      }).join('');
      $('view-packages').querySelector('.table-wrap').innerHTML = `<table>
        <thead><tr><th>Cliente</th><th>Pacote</th><th>Saldo</th><th>Validade</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
      $('view-packages').querySelectorAll('[data-action="packageStatement"]').forEach((b) => b.addEventListener('click', () => openPackageStatementModal(Number(b.dataset.id))));
      $('view-packages').querySelectorAll('[data-action="adjustPackage"]').forEach((b) => b.addEventListener('click', () => openAdjustPackageModal(Number(b.dataset.id))));
      $('view-packages').querySelectorAll('[data-action="cancelPackage"]').forEach((b) => b.addEventListener('click', () => cancelCustomerPackage(Number(b.dataset.id))));
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  /* ---------- modelo de pacote ---------- */

  function packageItemsHtml(items) {
    const rows = (items || []).map((it) => `
      <div class="form-grid" data-item-row style="grid-template-columns: 1fr 120px 36px; gap: 8px;">
        <div class="field"><select class="pkgItemService">
          ${state.services.map((s) => `<option value="${s.id}" ${s.id === it.service_id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select></div>
        <div class="field"><input type="number" class="pkgItemQty" min="1" value="${it.quantity || 1}" /></div>
        <button type="button" class="action-btn action-btn-danger pkgItemRemove" title="Remover" aria-label="Remover">×</button>
      </div>`).join('');
    return `<div id="pkgItemsWrap">${rows || '<div class="empty-state">Nenhum serviço adicionado.</div>'}</div>`;
  }

  async function openPackageModal(id) {
    await loadBase();
    let pkg = null;
    if (id) {
      const all = await api('/api/admin/packages?includeInactive=true').catch(() => []);
      pkg = all.find((p) => p.id === id);
    }
    const v = (f, def) => (pkg && pkg[f] != null ? pkg[f] : def);

    openModal(id ? 'Editar pacote' : 'Novo pacote', `
      <form id="pkgForm" novalidate>
        <div class="form-grid">
          <div class="field">${fieldHtml('pkgName', 'Nome do pacote', v('name', ''), 'text', 'Ex.: Lavagem Premium')}</div>
          <div class="field">${fieldHtml('pkgPrice', 'Preço (R$)', v('price_cents', '') ? String((v('price_cents') / 100).toFixed(2).replace('.', ',')) : '', 'text', '0,00')}</div>
          <div class="field span-2"><label for="pkgDesc">Descrição</label>
            <textarea id="pkgDesc" rows="2">${escapeHtml(v('description', ''))}</textarea></div>
          <div class="field">${fieldHtml('pkgValidity', 'Validade (dias — vazio = sem validade)', v('validity_days', '') || '', 'number')}</div>
          <div class="field"><label>&nbsp;</label>
            <div class="checkbox-row" style="gap:16px;">
              <label class="switch-row"><input type="checkbox" id="pkgVehicleBound" ${v('is_vehicle_bound', 0) ? 'checked' : ''} /><span>Vincular a um veículo</span></label>
              <label class="switch-row"><input type="checkbox" id="pkgTransferable" ${v('is_transferable', 0) ? 'checked' : ''} /><span>Transferível</span></label>
            </div></div>
          <div class="field span-2"><label>Serviços do pacote</label>${packageItemsHtml(pkg ? pkg.items : [{ service_id: '', quantity: 1 }])}</div>
          <div class="field span-2"><button type="button" class="btn btn-ghost" id="pkgAddItem">+ Adicionar serviço</button></div>
        </div>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="pkgSave">${id ? 'Salvar' : 'Criar pacote'}</button>
    `);

    $('pkgAddItem').addEventListener('click', () => {
      const wrap = $('pkgItemsWrap');
      const empty = wrap.querySelector('.empty-state');
      if (empty) empty.remove();
      wrap.insertAdjacentHTML('beforeend', `
        <div class="form-grid" data-item-row style="grid-template-columns: 1fr 120px 36px; gap: 8px;">
          <div class="field"><select class="pkgItemService">
            ${state.services.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
          </select></div>
          <div class="field"><input type="number" class="pkgItemQty" min="1" value="1" /></div>
          <button type="button" class="action-btn action-btn-danger pkgItemRemove" title="Remover" aria-label="Remover">×</button>
        </div>`);
    });
    $('pkgItemsWrap').addEventListener('click', (e) => {
      if (e.target.classList.contains('pkgItemRemove')) {
        const row = e.target.closest('[data-item-row]');
        row.remove();
        const rows = $('pkgItemsWrap').querySelectorAll('[data-item-row]');
        if (!rows.length) $('pkgItemsWrap').innerHTML = '<div class="empty-state">Nenhum serviço adicionado.</div>';
      }
    });

    $('pkgSave').addEventListener('click', async () => {
      const rows = [...$('pkgItemsWrap').querySelectorAll('[data-item-row]')].map((r) => ({
        service_id: Number(r.querySelector('.pkgItemService').value),
        quantity: Number(r.querySelector('.pkgItemQty').value)
      }));
      const body = {
        name: $('pkgName').value,
        description: $('pkgDesc').value || null,
        price: $('pkgPrice').value.trim() || '0',
        validity_days: $('pkgValidity').value ? Number($('pkgValidity').value) : null,
        is_vehicle_bound: $('pkgVehicleBound').checked ? 1 : 0,
        is_transferable: $('pkgTransferable').checked ? 1 : 0,
        items: rows
      };
      showLoader();
      try {
        await api(id ? '/api/admin/packages/' + id : '/api/admin/packages', {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(body)
        });
        closeModal();
        await renderPackages();
        toast(id ? 'Pacote atualizado.' : 'Pacote criado.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  async function togglePackage(id) {
    const all = await api('/api/admin/packages?includeInactive=true').catch(() => []);
    const pkg = all.find((p) => p.id === id);
    if (!pkg) return;
    confirmAction(`Deseja ${pkg.active ? 'desativar' : 'ativar'} o pacote "${pkg.name}"?`, '/api/admin/packages/' + id + '/active', 'PATCH', { active: pkg.active ? 0 : 1 }, renderPackages);
  }

  /* ---------- venda de pacote ---------- */

  async function openSellPackageModal() {
    await loadBase();
    const [models, customers] = await Promise.all([
      api('/api/admin/packages').catch(() => []),
      api('/api/admin/customers?search=').catch(() => [])
    ]);

    openModal('Vender pacote', `
      <form id="sellForm" novalidate>
        <div class="form-grid">
          <div class="field span-2"><label>Pacote</label>
            <select id="sellPackage">
              <option value="">Selecione o pacote</option>
              ${models.map((p) => `<option value="${p.id}" data-price="${p.price_cents || 0}">${escapeHtml(p.name)} — ${money((p.price_cents || 0) / 100)}</option>`).join('')}
            </select></div>
          <div class="field span-2"><label>Cliente</label>
            <div style="display:flex; gap:8px;">
              <input type="text" id="sellCustomerSearch" placeholder="Buscar cliente por nome, telefone ou e-mail..." style="flex:1;" />
              <button type="button" class="btn btn-ghost" id="sellCustomerBtn">Buscar</button>
            </div>
            <div id="sellCustomerList" class="muted" style="margin-top:6px;">Nenhum cliente selecionado. Preencha os dados abaixo para cadastrar um novo.</div>
            <div class="checkbox-row"><label class="switch-row"><input type="checkbox" id="sellNewCustomer" /><span>Novo cliente</span></label></div>
          </div>
          <div class="field">${fieldHtml('sellName', 'Nome', '', 'text', 'Nome do cliente')}</div>
          <div class="field">${fieldHtml('sellPhone', 'Telefone', '', 'text', '(00) 00000-0000')}</div>
          <div class="field">${fieldHtml('sellEmail', 'E-mail', '', 'email')}</div>
          <div class="field">${fieldHtml('sellCpf', 'CPF', '', 'text')}</div>
          <div class="field span-2"><label>Veículo (se o pacote exigir)</label>
            <select id="sellVehicle"><option value="">Sem veículo</option></select>
            <div class="checkbox-row"><label class="switch-row"><input type="checkbox" id="sellNewVehicle" /><span>Informar um veículo novo</span></label></div>
          </div>
          <div class="field">${fieldHtml('sellVBrand', 'Marca', '', 'text')}</div>
          <div class="field">${fieldHtml('sellVModel', 'Modelo', '', 'text')}</div>
          <div class="field">${fieldHtml('sellVPlate', 'Placa', '', 'text', 'ABC-1D23')}</div>
          <div class="field">${fieldHtml('sellVYear', 'Ano', '', 'text')}</div>
          <div class="field"><label for="sellVColor">Cor</label><input type="text" id="sellVColor" /></div>
          <div class="field"><label for="sellVCategory">Categoria</label>
            <select id="sellVCategory">
              ${Object.keys(CATEGORY_LABELS).map((k) => `<option value="${k}">${CATEGORY_LABELS[k]}</option>`).join('')}
            </select></div>
          <div class="field">${fieldHtml('sellDiscount', 'Desconto (R$)', '', 'text', '0,00')}</div>
          <div class="field"><label for="sellPayment">Forma de pagamento</label>
            <select id="sellPayment">
              <option value="">—</option>
              ${PAYMENT_METHOD_KEYS.map((k) => `<option value="${k}">${PAYMENT_LABELS[k]}</option>`).join('')}
            </select></div>
          <div class="field"><label for="sellDate">Data da compra</label><input type="date" id="sellDate" value="${todayStr()}" /></div>
          <div class="field span-2"><label for="sellNotes">Observações</label>
            <textarea id="sellNotes" rows="2"></textarea></div>
        </div>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="sellSave">Vender pacote</button>
    `);

    let selectedCustomer = null;
    const customerList = (list) => {
      const el = $('sellCustomerList');
      if (!list.length) {
        el.innerHTML = 'Nenhum cliente encontrado.';
        return;
      }
      el.innerHTML = list.map((c) => `
        <label class="choice" style="display:flex; align-items:center; gap:8px; padding:6px 0; cursor:pointer;">
          <input type="radio" name="sellCustomerRadio" value="${c.id}" data-name="${escapeHtml(c.name)}" data-phone="${escapeHtml(c.phone || '')}" />
          <span><strong>${escapeHtml(c.name)}</strong> · ${escapeHtml(c.phone || 'sem telefone')}</span>
        </label>`).join('');
      el.querySelectorAll('input[name="sellCustomerRadio"]').forEach((r) => r.addEventListener('change', () => {
        selectedCustomer = list.find((c) => c.id === Number(r.value));
        $('sellName').value = selectedCustomer.name;
        $('sellPhone').value = selectedCustomer.phone || '';
        $('sellEmail').value = selectedCustomer.email || '';
        $('sellCpf').value = selectedCustomer.cpf || '';
        fillVehicles(selectedCustomer.id);
      }));
    };
    const fillVehicles = async (customerId) => {
      const cust = await api('/api/admin/customers/' + customerId).catch(() => null);
      const sel = $('sellVehicle');
      sel.innerHTML = '<option value="">Sem veículo</option>' + (cust && cust.vehicles ? cust.vehicles.map((v) =>
        `<option value="${v.id}">${escapeHtml(v.model)} ${escapeHtml(v.plate || '')}</option>`).join('') : '');
    };
    const showNewCustomerFields = () => {
      const isNew = $('sellNewCustomer').checked;
      ['sellName', 'sellPhone', 'sellEmail', 'sellCpf'].forEach((f) => { $(f).disabled = !isNew; });
    };
    const showNewVehicleFields = () => {
      const isNew = $('sellNewVehicle').checked;
      ['sellVBrand', 'sellVModel', 'sellVPlate', 'sellVYear', 'sellVColor', 'sellVCategory'].forEach((f) => { $(f).disabled = !isNew; });
      $('sellVehicle').disabled = isNew;
    };

    $('sellCustomerBtn').addEventListener('click', async () => {
      const q = $('sellCustomerSearch').value.trim();
      const list = await api('/api/admin/customers?search=' + encodeURIComponent(q)).catch(() => []);
      customerList(list);
    });
    $('sellNewCustomer').addEventListener('change', () => {
      selectedCustomer = null;
      customerList([]);
      $('sellCustomerList').innerHTML = 'Novo cliente. Preencha os dados abaixo.';
      showNewCustomerFields();
    });
    $('sellNewVehicle').addEventListener('change', showNewVehicleFields);
    showNewCustomerFields();
    showNewVehicleFields();

    $('sellSave').addEventListener('click', async () => {
      const body = {
        package_id: Number($('sellPackage').value),
        payment_method: $('sellPayment').value || null,
        purchased_at: $('sellDate').value || todayStr(),
        notes: $('sellNotes').value || null,
        discount: $('sellDiscount').value.trim() || null
      };
      if (selectedCustomer) body.customer_id = selectedCustomer.id;
      else {
        body.customer = {
          name: $('sellName').value,
          phone: $('sellPhone').value,
          email: $('sellEmail').value || null,
          cpf: $('sellCpf').value || null
        };
      }
      if ($('sellNewVehicle').checked) {
        body.vehicle = {
          brand: $('sellVBrand').value,
          model: $('sellVModel').value,
          year: $('sellVYear').value,
          plate: $('sellVPlate').value,
          color: $('sellVColor').value,
          category: $('sellVCategory').value
        };
      } else if ($('sellVehicle').value) {
        body.vehicle_id = Number($('sellVehicle').value);
      }
      if (!body.package_id) { toast('Selecione o pacote.', 'error'); return; }
      showLoader();
      try {
        const sold = await api('/api/admin/customer-packages', { method: 'POST', body: JSON.stringify(body) });
        closeModal();
        await renderPackages();
        toast(`Pacote vendido a ${sold.customer ? sold.customer.name : ''}.`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  /* ---------- extrato / ajuste / cancelamento ---------- */

  async function openPackageStatementModal(id) {
    showLoader();
    try {
      const stmt = await api('/api/admin/customer-packages/' + id + '/statement');
      const cp = stmt.package;
      const balanceRows = cp.balances.map((b) => `
        <tr>
          <td>${escapeHtml(b.service_name)}</td>
          <td>${b.total}</td>
          <td>${b.adjusted}</td>
          <td>${b.reserved}</td>
          <td>${b.consumed}</td>
          <td><strong>${b.available}</strong></td>
        </tr>`).join('');
      const txRows = stmt.transactions.map((t) => `
        <tr>
          <td>${toDateBR(t.created_at ? t.created_at.slice(0, 10) : '')}</td>
          <td>${PACKAGE_TX_LABELS[t.transaction_type] || t.transaction_type}</td>
          <td>${escapeHtml(t.service_name)}</td>
          <td>${t.quantity}</td>
          <td>${t.appointment_code ? escapeHtml(t.appointment_code) : '—'}</td>
          <td><span class="muted">${escapeHtml(t.reason || '')}</span></td>
        </tr>`).join('');

      openModal(`Pacote ${cp.package_name_snapshot}`, `
        <div class="form-grid" style="margin-bottom:14px;">
          <div class="field"><strong>Cliente</strong><div>${escapeHtml(cp.customer ? cp.customer.name : '')} · ${escapeHtml(cp.customer ? cp.customer.phone || '' : '')}</div></div>
          <div class="field"><strong>Status</strong><div>${packageBadge(cp.status)}</div></div>
          <div class="field"><strong>Validade</strong><div>${cp.expires_at ? toDateBR(cp.expires_at) : 'Sem validade'}${cp.expired ? ' <span style="color:var(--red);">(expirado)</span>' : ''}</div></div>
          <div class="field"><strong>Compra</strong><div>${toDateBR(cp.purchased_at)} · ${money((cp.purchase_price_cents || 0) / 100)}</div></div>
        </div>
        <h3 class="review-section-title">Saldos por serviço</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Serviço</th><th>Total</th><th>Ajuste</th><th>Reservado</th><th>Consumido</th><th>Disponível</th></tr></thead>
          <tbody>${balanceRows || '<tr><td colspan="6">Sem saldos.</td></tr>'}</tbody>
        </table></div>
        <h3 class="review-section-title">Movimentações</h3>
        <div class="table-wrap" style="max-height:320px; overflow:auto;"><table>
          <thead><tr><th>Data</th><th>Tipo</th><th>Serviço</th><th>Qtd</th><th>Agendamento</th><th>Motivo</th></tr></thead>
          <tbody>${txRows || '<tr><td colspan="6">Sem movimentações.</td></tr>'}</tbody>
        </table></div>
      `, `<button class="btn btn-ghost" data-close>Fechar</button>`);
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  async function openAdjustPackageModal(id) {
    showLoader();
    let cp = null;
    try {
      cp = await api('/api/admin/customer-packages/' + id);
    } catch (e) {
      toast(e.message, 'error');
      hideLoader();
      return;
    }
    hideLoader();

    openModal(`Ajuste manual — ${cp.package_name_snapshot}`, `
      <form id="adjustForm" novalidate>
        <div class="form-grid">
          <div class="field"><label for="adjService">Serviço</label>
            <select id="adjService">
              ${cp.balances.map((b) => `<option value="${b.service_id}">${escapeHtml(b.service_name)} (${b.available} disponíveis)</option>`).join('')}
            </select></div>
          <div class="field"><label for="adjType">Tipo</label>
            <select id="adjType">
              <option value="MANUAL_DEBIT">Débito</option>
              <option value="MANUAL_CREDIT">Crédito</option>
            </select></div>
          <div class="field">${fieldHtml('adjQty', 'Quantidade', '', 'number')}</div>
          <div class="field span-2"><label for="adjReason">Motivo (obrigatório)</label>
            <textarea id="adjReason" rows="2" placeholder="Descreva o motivo do ajuste"></textarea></div>
        </div>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="adjSave">Aplicar ajuste</button>
    `);

    $('adjSave').addEventListener('click', async () => {
      showLoader();
      try {
        await api('/api/admin/customer-packages/' + id + '/adjust', {
          method: 'POST',
          body: JSON.stringify({
            service_id: Number($('adjService').value),
            type: $('adjType').value,
            quantity: Number($('adjQty').value),
            reason: $('adjReason').value
          })
        });
        closeModal();
        await renderPackages();
        toast('Ajuste aplicado.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  async function cancelCustomerPackage(id) {
    const all = await api('/api/admin/customer-packages').catch(() => []);
    const cp = all.find((x) => x.id === id);
    if (!cp) return;
    const msg = cp.totals && cp.totals.reserved
      ? 'Este pacote tem saldo reservado em agendamentos. Cancele ou conclua os agendamentos antes de cancelar o pacote.'
      : `Cancelar o pacote "${cp.package_name}"? O saldo remanescente será zerado e registrado no histórico.`;
    if (cp.totals && cp.totals.reserved) { toast(msg, 'error'); return; }
    if (!confirm(msg)) return;
    showLoader();
    try {
      await api('/api/admin/customer-packages/' + id + '/cancel', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Cancelamento pelo painel administrativo' })
      });
      await renderPackages();
      toast('Pacote cancelado.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  /* ---------- units ---------- */

  function splitUnitAddress(addr) {
    const out = {
      address_street: '', address_number: '', address_complement: '',
      address_neighborhood: '', address_city: '', address_state: '', address_zipcode: ''
    };
    const s = String(addr || '').trim();
    if (!s) return out;
    const sections = s.split(' - ').map((x) => x.trim()).filter(Boolean);
    const first = sections.shift() || '';
    const m = first.match(/^(.+?)\s*,\s*(\d+)([^\d].*)?$/);
    if (m) {
      out.address_street = m[1].trim();
      out.address_number = m[2];
      out.address_complement = (m[3] || '').trim().replace(/^[,;\s]+/, '');
    } else {
      out.address_street = first;
    }
    if (sections.length) {
      if (/^[A-Za-z]{2}$/.test(sections[sections.length - 1])) {
        out.address_state = sections.pop().toUpperCase();
      }
      if (sections.length === 1) {
        out.address_neighborhood = sections[0];
      } else if (sections.length >= 2) {
        out.address_neighborhood = sections[0];
        out.address_city = sections[1];
        if (sections.length > 2) {
          const rest = sections.slice(2).join(' - ');
          out.address_complement = out.address_complement ? `${out.address_complement} - ${rest}` : rest;
        }
      }
    }
    return out;
  }

  async function renderUnits() {
    await loadBase();
    const el = $('view-units');
    const rows = state.units.map((u) => `
      <tr>
        <td><strong>${escapeHtml(u.name)}</strong><br /><span class="muted">${escapeHtml(u.address || '')}</span></td>
        <td>${escapeHtml(u.phone || '')}</td>
        <td>${escapeHtml(u.opening_time)} às ${escapeHtml(u.closing_time)}</td>
        <td>${u.capacity || 1}</td>
        <td>${u.active ? badge('confirmed') : badge('cancelled')}</td>
        <td><div class="appointment-actions">
          ${actionButton('editUnit', u.id, { icon: 'edit', label: 'Editar unidade' })}
          ${actionButton('toggleUnit', u.id, { icon: u.active ? 'cancel' : 'accept', label: u.active ? 'Desativar unidade' : 'Ativar unidade' })}
          ${actionButton('deleteUnit', u.id, { icon: 'delete', label: 'Excluir unidade' })}
        </div></td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Unidades</h1><div class="sub">Pontos de atendimento da Lavagem na unidade</div></div>
        <button class="btn btn-primary" id="btnNewUnit">+ Nova unidade</button>
      </div>
      <div class="panel">
        ${state.units.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Unidade</th><th>Telefone</th><th>Horário</th><th>Capacidade</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhuma unidade cadastrada.</div>'}
      </div>
    `;
    $('btnNewUnit').addEventListener('click', () => openUnitModal());
    el.querySelectorAll('[data-action="editUnit"]').forEach((b) => b.addEventListener('click', () => openUnitModal(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="toggleUnit"]').forEach((b) => b.addEventListener('click', () => toggleUnit(Number(b.dataset.id))));
    el.querySelectorAll('[data-action="deleteUnit"]').forEach((b) => b.addEventListener('click', () => deleteUnit(Number(b.dataset.id))));
  }

  async function openUnitModal(id) {
    let u = null;
    if (id) u = state.units.find((x) => x.id === id);
    if (u && !u.address_street && !u.address_number && u.address) {
      u = { ...u, ...splitUnitAddress(u.address) };
    }
    const v = (f, def) => (u && u[f] != null ? u[f] : def);
    const days = v('working_days', [1, 2, 3, 4, 5, 6]);

    openModal(id ? 'Editar unidade' : 'Nova unidade', `
      <form id="unitForm" novalidate>
        <div class="form-grid">
          <div class="field span-2">${fieldHtml('unitName', 'Nome', v('name'), 'text', 'Nome da unidade')}</div>
          <div class="field">${fieldHtml('unitStreet', 'Rua', v('address_street'), 'text')}</div>
          <div class="field">${fieldHtml('unitNumber', 'Número', v('address_number'), 'text')}</div>
          <div class="field">${fieldHtml('unitComplement', 'Complemento', v('address_complement'), 'text')}</div>
          <div class="field">${fieldHtml('unitNeighborhood', 'Bairro', v('address_neighborhood'), 'text')}</div>
          <div class="field">${fieldHtml('unitCity', 'Cidade', v('address_city'), 'text')}</div>
          <div class="field">${fieldHtml('unitState', 'UF', v('address_state'), 'text', 'MG')}</div>
          <div class="field">${fieldHtml('unitZipcode', 'CEP', v('address_zipcode'), 'text', '00000-000')}</div>
          <div class="field span-2">${fieldHtml('unitReference', 'Ponto de referência', v('address_reference'), 'text')}</div>
          <div class="field span-2">${fieldHtml('unitMaps', 'Link Google Maps', v('maps_link'), 'text', 'https://maps.google.com/...')}</div>
          <div class="field">${fieldHtml('unitPhone', 'Telefone', v('phone'), 'text', '(00) 00000-0000')}</div>
          <div class="field">${fieldHtml('unitCapacity', 'Capacidade simultânea', v('capacity', 1), 'number')}</div>
          <div class="field"><label for="unitOpen">Abertura</label><input type="time" id="unitOpen" value="${escapeHtml(v('opening_time', '08:00'))}" /></div>
          <div class="field"><label for="unitClose">Fechamento</label><input type="time" id="unitClose" value="${escapeHtml(v('closing_time', '17:00'))}" /></div>
          <div class="field"><label for="unitLunchStart">Almoço — início</label><input type="time" id="unitLunchStart" value="${escapeHtml(v('lunch_start', '12:00'))}" /></div>
          <div class="field"><label for="unitLunchEnd">Almoço — fim</label><input type="time" id="unitLunchEnd" value="${escapeHtml(v('lunch_end', '13:00'))}" /></div>
          <div class="field">${fieldHtml('unitInterval', 'Intervalo (minutos)', v('appointment_interval', 60), 'number')}</div>
        </div>
        <div class="field"><label>Dias de funcionamento</label>
          <div class="checkbox-row">
            ${WEEKDAY_KEYS.map((d) => `<label class="switch-row"><input type="checkbox" class="unitDay" data-day="${d}" ${days.includes(d) ? 'checked' : ''} /><span>${WEEKDAY_LABELS[d]}</span></label>`).join('')}
          </div>
        </div>
        <label class="switch-row"><input type="checkbox" id="unitActive" ${v('active', 1) ? 'checked' : ''} /><span>Ativa</span></label>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="unitSave">${id ? 'Salvar' : 'Criar unidade'}</button>
    `);

    $('unitSave').addEventListener('click', async () => {
      const saveBtn = $('unitSave');
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      const days = [...document.querySelectorAll('.unitDay:checked')].map((c) => Number(c.dataset.day));
      const addrParts = ['unitStreet', 'unitNumber', 'unitComplement', 'unitNeighborhood', 'unitCity', 'unitState']
        .map((f) => $(f).value.trim()).filter(Boolean);
      const body = {
        name: $('unitName').value,
        address: addrParts.length ? addrParts.join(', ') : (u && u.address) || '',
        address_street: $('unitStreet').value,
        address_number: $('unitNumber').value,
        address_complement: $('unitComplement').value,
        address_neighborhood: $('unitNeighborhood').value,
        address_city: $('unitCity').value,
        address_state: $('unitState').value,
        address_zipcode: $('unitZipcode').value,
        address_reference: $('unitReference').value || null,
        maps_link: $('unitMaps').value || null,
        phone: $('unitPhone').value,
        capacity: Number($('unitCapacity').value),
        opening_time: $('unitOpen').value,
        closing_time: $('unitClose').value,
        lunch_start: $('unitLunchStart').value,
        lunch_end: $('unitLunchEnd').value,
        appointment_interval: Number($('unitInterval').value),
        working_days: days,
        active: $('unitActive').checked ? 1 : 0
      };
      try {
        showLoader();
        await api(id ? '/api/admin/units/' + id : '/api/admin/units', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
        closeModal();
        await renderUnits();
        toast(id ? 'Unidade atualizada.' : 'Unidade criada.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
      saveBtn.disabled = false;
    });
  }

  async function toggleUnit(id) {
    const u = state.units.find((x) => x.id === id);
    if (!u) return;
    try {
      showLoader();
      await api('/api/admin/units/' + id, { method: 'PUT', body: JSON.stringify({ ...u, active: u.active ? 0 : 1 }) });
      await renderUnits();
      toast('Status da unidade atualizado.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  async function deleteUnit(id) {
    const u = state.units.find((x) => x.id === id);
    if (!u) return;
    if (!confirm(`Excluir a unidade "${u.name}"?`)) return;
    try {
      showLoader();
      await api('/api/admin/units/' + id, { method: 'DELETE' });
      await renderUnits();
      toast('Unidade excluída.', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  /* ---------- blocks ---------- */

  async function renderBlocks() {
    const el = $('view-blocks');
    const data = await api('/api/admin/blocked-schedules');
    const rows = data.map((b) => `
      <tr>
        <td>${toDateBR(b.blocked_date)}</td>
        <td>${b.block_full_day ? '<span class="badge badge-rejected">Dia inteiro</span>' : escapeHtml(b.blocked_time_end ? `${b.blocked_time} às ${b.blocked_time_end}` : b.blocked_time)}</td>
        <td>${escapeHtml(b.unit_name || 'Todas as unidades (global)')}</td>
        <td>${escapeHtml(b.reason || '—')}</td>
        <td><button class="btn btn-sm btn-danger" data-action="deleteBlock" data-id="${b.id}">Remover</button></td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Bloqueios</h1><div class="sub">Períodos sem atendimento (global ou por unidade)</div></div>
        <button class="btn btn-primary" id="btnNewBlock">+ Novo bloqueio</button>
      </div>
      <div class="panel">
        ${data.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Data</th><th>Período</th><th>Unidade</th><th>Motivo</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhum bloqueio cadastrado.</div>'}
      </div>
    `;
    $('btnNewBlock').addEventListener('click', () => openBlockModal());
    el.querySelectorAll('[data-action="deleteBlock"]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remover este bloqueio?')) return;
      try {
        showLoader();
        await api('/api/admin/blocked-schedules/' + b.dataset.id, { method: 'DELETE' });
        await renderBlocks();
        toast('Bloqueio removido.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    }));
  }

  function openBlockModal() {
    const unitOpts = state.units.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
    openModal('Novo bloqueio', `
      <form id="blockForm" novalidate>
        <div class="field"><label for="blockDate">Data</label><input type="date" id="blockDate" value="${todayStr()}" /></div>
        <div class="field"><label for="blockUnit">Unidade</label>
          <select id="blockUnit"><option value="">Todas as unidades (global)</option>${unitOpts}</select></div>
        <div class="field"><label>Horário (apenas se não for dia inteiro)</label>
          <div class="field-row">
            <div class="field"><label>De</label><input type="time" id="blockTime" /></div>
            <div class="field"><label>Até (opcional)</label><input type="time" id="blockTimeEnd" /></div>
          </div>
          <p class="muted" style="margin-top:-6px;font-size:12px;">Preencha "De" e "Até" para bloquear um intervalo (ex.: 08:00 às 11:00).</p>
        </div>
        <label class="switch-row" style="margin-bottom:12px;"><input type="checkbox" id="blockFullDay" /><span>Bloquear o dia inteiro</span></label>
        <div class="field">${fieldHtml('blockReason', 'Motivo', '', 'text', 'Ex.: feriado, manutenção')}</div>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="blockSave">Criar bloqueio</button>
    `);
    const blockTime = $('blockTime');
    const blockTimeEnd = $('blockTimeEnd');
    const blockFullDay = $('blockFullDay');
    const syncTimeDisabled = () => {
      blockTime.disabled = blockFullDay.checked;
      blockTimeEnd.disabled = blockFullDay.checked;
    };
    blockFullDay.addEventListener('change', syncTimeDisabled);
    syncTimeDisabled();
    $('blockSave').addEventListener('click', async () => {
      const body = {
        unit_id: $('blockUnit').value || null,
        blocked_date: $('blockDate').value,
        blocked_time: blockTime.value || null,
        blocked_time_end: blockTimeEnd.value || null,
        block_full_day: blockFullDay.checked ? 1 : 0,
        reason: $('blockReason').value || null
      };
      try {
        showLoader();
        await api('/api/admin/blocked-schedules', { method: 'POST', body: JSON.stringify(body) });
        closeModal();
        await renderBlocks();
        toast('Bloqueio criado.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  /* ---------- modalities ---------- */

  async function renderModalities() {
    await loadBase();
    const el = $('view-modalities');
    const rows = state.modalities.map((m) => `
      <tr>
        <td><strong>${escapeHtml(m.name)}</strong><br /><span class="muted">${escapeHtml(m.description || '')}</span></td>
        <td>${m.fee > 0 ? money(m.fee) : 'Sem taxa'}</td>
        <td>${m.active ? badge('confirmed') : badge('cancelled')}</td>
        <td><div class="appointment-actions">${actionButton('editModality', m.id, { icon: 'edit', label: 'Editar modalidade' })}</div></td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Formas de atendimento</h1><div class="sub">Modalidades e taxas aplicadas no agendamento</div></div>
      </div>
      <div class="panel">
        <div class="table-wrap"><table>
          <thead><tr><th>Modalidade</th><th>Taxa</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>
    `;
    el.querySelectorAll('[data-action="editModality"]').forEach((b) => b.addEventListener('click', () => openModalityModal(Number(b.dataset.id))));
  }

  async function openModalityModal(id) {
    await loadBase();
    const m = state.modalities.find((x) => x.id === id);
    if (!m) return;
    openModal('Editar modalidade', `
      <form id="modalityForm" novalidate>
        <div class="field">${fieldHtml('modName', 'Nome', m.name, 'text')}</div>
        <div class="field"><label for="modDesc">Descrição</label><textarea id="modDesc" rows="2">${escapeHtml(m.description || '')}</textarea></div>
        <div class="field">${fieldHtml('modFee', 'Taxa (R$)', m.fee, 'number')}</div>
        <label class="switch-row"><input type="checkbox" id="modActive" ${m.active ? 'checked' : ''} /><span>Ativa</span></label>
      </form>
    `, `
      <button class="btn btn-ghost" data-close>Cancelar</button>
      <button class="btn btn-primary" id="modSave">Salvar</button>
    `);
    $('modSave').addEventListener('click', async () => {
      try {
        showLoader();
        await api('/api/admin/modalities/' + id, {
          method: 'PUT',
          body: JSON.stringify({
            name: $('modName').value,
            description: $('modDesc').value || null,
            fee: Number($('modFee').value || 0),
            active: $('modActive').checked ? 1 : 0
          })
        });
        closeModal();
        await renderModalities();
        toast('Modalidade atualizada.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  /* ---------- whatsapp ---------- */

  const WHATSAPP_EVENT_LABELS = {
    APPOINTMENT_REQUESTED_CUSTOMER: 'Novo agendamento (cliente)',
    APPOINTMENT_REQUESTED_STORE: 'Novo agendamento (loja)',
    APPOINTMENT_CONFIRMED: 'Confirmação',
    APPOINTMENT_CANCELLED: 'Cancelamento',
    APPOINTMENT_RESCHEDULED: 'Reagendamento',
    APPOINTMENT_COMPLETED: 'Conclusão',
    APPOINTMENT_COMPLETED_PACKAGE: 'Conclusão — pacote'
  };

  const WHATSAPP_STATUS_LABELS = {
    PENDING: 'Aguardando',
    PROCESSING: 'Enviando',
    SENT: 'Enviada',
    FAILED: 'Falhou',
    SIMULATED: 'Simulada',
    CANCELLED: 'Cancelada'
  };

  const WHATSAPP_STATUS_CLASS = {
    PENDING: 'pending',
    PROCESSING: 'pending',
    SENT: 'confirmed',
    FAILED: 'rejected',
    SIMULATED: 'pending',
    CANCELLED: 'cancelled'
  };

  async function renderWhatsapp() {
    const el = $('view-whatsapp');
    const tab = state.whatsappTab || 'conexao';
    el.innerHTML = `
      <div class="admin-header">
        <div><h1>WhatsApp</h1><div class="sub">Conexão com a conta, mensagens automáticas e histórico de envios</div></div>
      </div>
      <div class="tabs">
        <button type="button" class="tab ${tab === 'conexao' ? 'active' : ''}" data-whatsapp-tab="conexao">Conexão</button>
        <button type="button" class="tab ${tab === 'mensagens' ? 'active' : ''}" data-whatsapp-tab="mensagens">Mensagens automáticas</button>
        <button type="button" class="tab ${tab === 'historico' ? 'active' : ''}" data-whatsapp-tab="historico">Histórico</button>
      </div>
      <div id="whatsappTabBody"></div>
    `;
    el.querySelectorAll('[data-whatsapp-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.whatsappTab === btn.dataset.whatsappTab) return;
        state.whatsappTab = btn.dataset.whatsappTab;
        renderWhatsapp();
      });
    });
    if (tab === 'conexao') await renderWhatsappConnection($('whatsappTabBody'));
    else if (tab === 'historico') await renderWhatsappHistory($('whatsappTabBody'));
    else await renderWhatsappTemplates($('whatsappTabBody'));
  }

  /* QR do WhatsApp guardado SOMENTE em memória durante a vida da aba — nunca
     em localStorage, dataset ou console. O timer da contagem regressiva é
     compartilhado entre renders para nunca duplicar intervalos. */
  let whatsappQrTimer = null;

  /* Bloco de exibição do QR: imagem centralizada com <img id="whatsappQrCode">
     (src é o data URI recebido do backend, já com prefixo) ou, quando a
     Evolution devolve apenas código de pareamento, o código em destaque com
     botão de copiar. NUNCA renderiza imagem vazia. */
  function whatsappQrHtml(conn) {
    if (conn.qrType === 'image' && conn.qrCode) {
      return `
        <div class="wa-qr-wrap">
          <div class="wa-qr-box">
            <img id="whatsappQrCode" class="wa-qr" src="${escapeHtml(conn.qrCode)}" alt="QR Code para conectar o WhatsApp" />
            <p class="sub wa-qr-count" id="whatsappQrCountdown"></p>
          </div>
        </div>
      `;
    }
    if (conn.qrType === 'pairing_code' && conn.pairingCode) {
      return `
        <div class="wa-pairing-wrap">
          <div class="wa-pairing-box">
            <strong id="whatsappPairingCode">${escapeHtml(conn.pairingCode)}</strong>
            <button type="button" class="btn btn-ghost btn-sm" id="whatsappCopyPairing">Copiar código</button>
          </div>
          <p class="sub wa-qr-count" id="whatsappQrCountdown"></p>
        </div>
      `;
    }
    if (conn.qrType === 'text' && conn.qrCode) {
      return `
        <div class="wa-pairing-wrap">
          <div class="wa-pairing-box">
            <strong id="whatsappPairingCode">${escapeHtml(conn.qrCode)}</strong>
            <button type="button" class="btn btn-ghost btn-sm" id="whatsappCopyPairing">Copiar código</button>
          </div>
          <p class="sub wa-qr-count" id="whatsappQrCountdown"></p>
        </div>
      `;
    }
    return '';
  }

  /* Contagem regressiva até a expiração do QR/pairing (expiresAt vem do
     backend em UTC ISO). Ao zerar, oculta o código e deixa visível o botão
     "Gerar novo QR". */
  function startWhatsappQrCountdown(container, expiresAt) {
    if (whatsappQrTimer) { clearInterval(whatsappQrTimer); whatsappQrTimer = null; }
    const el = container.querySelector('#whatsappQrCountdown');
    if (!el) return;
    const target = new Date(expiresAt).getTime();
    if (Number.isNaN(target)) { el.remove(); return; }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      el.textContent = remaining > 0 ? `O código expira em ${remaining}s` : 'O código expirou.';
      if (remaining <= 0) {
        clearInterval(whatsappQrTimer);
        whatsappQrTimer = null;
        const img = container.querySelector('#whatsappQrCode');
        const pair = container.querySelector('#whatsappPairingCode');
        const wrap = (img && img.closest('.wa-qr-wrap')) || (pair && pair.closest('.wa-pairing-wrap'));
        if (wrap) wrap.remove();
        const btn = container.querySelector('.waReconnect');
        if (btn) { btn.classList.remove('hidden'); btn.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        toast('O QR Code expirou. Gere um novo QR.', 'info');
      }
    };
    tick();
    whatsappQrTimer = setInterval(tick, 1000);
  }

  async function renderWhatsappConnection(container, qrOverride) {
    container.innerHTML = '<div class="panel"><p class="sub">Carregando…</p></div>';
    let conn;
    try {
      conn = await api('/api/admin/whatsapp/connection');
    } catch (e) {
      container.innerHTML = `<div class="panel"><p class="error">${escapeHtml(e.message)}</p></div>`;
      return;
    }

    /* A resposta imediata do connect/reconnect vence o estado salvo: o QR
       recém-gerado é exibido na hora, sem depender de uma nova consulta. */
    if (qrOverride && qrOverride.qrType && qrOverride.qrType !== 'none') {
      conn = {
        ...conn,
        status: 'connecting',
        qrType: qrOverride.qrType,
        qrCode: qrOverride.qrCode || null,
        pairingCode: qrOverride.pairingCode || null,
        expiresAt: qrOverride.expiresAt || conn.expiresAt || null,
        qr_expired: false
      };
    }

    const labels = { connected: 'Conectado', connecting: 'Aguardando escaneamento', disconnected: 'Desconectado', error: 'Erro', missing_remote: 'Instância ausente na Evolution' };
    const classes = { connected: 'confirmed', connecting: 'pending', disconnected: 'cancelled', error: 'rejected', missing_remote: 'rejected' };
    const statusBadge = `<span class="badge badge-${classes[conn.status] || 'pending'}">${labels[conn.status] || conn.status}</span>`;

    const providerBadge = conn.provider === 'evolution'
      ? '<span class="badge badge-confirmed">Envio real (Evolution)</span>'
      : '<span class="badge badge-pending">Modo simulado (MOCK)</span>';

    const auditRows = [
      ['Conectado em', conn.connected_at],
      ['Última conexão', conn.last_connection],
      ['Última desconexão', conn.last_disconnect],
      ['QR gerado em', conn.last_qr_generated]
    ].filter(([, v]) => v);
    const timestampsHtml = auditRows.length
      ? `<p class="sub" style="margin:10px 0 0;">${auditRows.map(([k, v]) => `${k}: <strong>${escapeHtml(v)}</strong>`).join(' &nbsp;•&nbsp; ')}</p>`
      : '';

    const qrHtml = whatsappQrHtml(conn);

    let body = '';
    if (!conn.settings_configured) {
      body = `
        <div class="panel">
          <h3 class="review-section-title">Integração não configurada</h3>
          <p class="sub" style="margin-top:0;">A plataforma ainda não está com a Evolution API configurada. Enquanto isso, o WhatsApp opera em <strong>modo simulado</strong> (as mensagens automáticas são registradas no histórico, sem envio real).</p>
          <p class="sub">Fale com o suporte para liberar a conexão real do WhatsApp da sua empresa.</p>
        </div>
      `;
    } else if (conn.status === 'connected') {
      body = `
        <div class="panel">
          <h3 class="review-section-title">WhatsApp conectado</h3>
          <p class="sub" style="margin-top:0;">Status: ${statusBadge}${conn.instance && conn.instance.owner_number ? ` &nbsp;•&nbsp; Número: <strong>${escapeHtml(conn.instance.owner_number)}</strong>` : ''}${conn.instance && conn.instance.owner_name ? ` <span class="muted">(${escapeHtml(conn.instance.owner_name)})</span>` : ''}</p>
          <div class="actions">
            <button type="button" class="btn btn-ghost waReconnect">Reconectar</button>
            <button type="button" class="btn btn-danger waDisconnect">Desconectar</button>
          </div>
        </div>
      `;
    } else if (conn.status === 'connecting') {
      body = `
        <div class="panel">
          <h3 class="review-section-title">Escaneie o QR Code para conectar</h3>
          <p class="sub" style="margin-top:0;">Abra o WhatsApp no seu celular, toque em <strong>Menu (⋮) &gt; Aparelhos conectados &gt; Conectar um aparelho</strong> e escaneie o código abaixo. Ele expira em poucos minutos.</p>
          ${qrHtml || (conn.qr_expired ? '<p class="sub">O QR Code anterior <strong>expirou</strong>. Gere um novo QR para continuar.</p>' : '<p class="sub">Nenhum QR Code válido no momento. Gere um novo QR para conectar.</p>')}
          ${conn.instance && conn.instance.last_error ? `<p class="error">${escapeHtml(conn.instance.last_error)}</p>` : ''}
          ${conn.mode === 'simulation' ? '<p class="sub">Este é um <strong>QR de simulação</strong> (MODO SIMULAÇÃO) — nenhuma conta real é usada enquanto a plataforma não liberar a Evolution.</p>' : ''}
          <div class="actions">
            <button type="button" class="btn btn-ghost waReconnect">Gerar novo QR</button>
            <button type="button" class="btn btn-ghost waRefresh">Atualizar status</button>
            <button type="button" class="btn btn-danger waDisconnect">Cancelar</button>
          </div>
        </div>
      `;
    } else {
      body = `
        <div class="panel">
          <h3 class="review-section-title">Conectar WhatsApp</h3>
          <p class="sub" style="margin-top:0;">Status: ${statusBadge}. Conecte a conta oficial da sua empresa para que as mensagens automáticas sejam enviadas de verdade.</p>
          ${conn.last_error || conn.instance && conn.instance.last_error ? `<p class="error">${escapeHtml(conn.last_error || conn.instance.last_error)}</p>` : ''}
          <div class="actions">
            <button type="button" class="btn btn-primary waConnect">Conectar</button>
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="panel">
        <h3 class="review-section-title">Conexão da conta</h3>
        ${body}
      </div>
      <div class="panel">
        <h3 class="review-section-title">Modo de envio</h3>
        <p class="sub" style="margin-top:0;">${providerBadge} — as mensagens configuradas em <em>Mensagens automáticas</em> só saem de verdade quando a conexão estiver ativa.</p>
        ${timestampsHtml}
      </div>
    `;

    container.querySelector('.waConnect') && container.querySelector('.waConnect').addEventListener('click', () => whatsappAction('connect'));
    container.querySelector('.waReconnect') && container.querySelector('.waReconnect').addEventListener('click', () => whatsappAction('reconnect'));
    container.querySelector('.waDisconnect') && container.querySelector('.waDisconnect').addEventListener('click', () => whatsappAction('disconnect'));
    container.querySelector('.waRefresh') && container.querySelector('.waRefresh').addEventListener('click', () => whatsappAction('refresh'));

    const copyBtn = container.querySelector('#whatsappCopyPairing');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(conn.pairingCode || conn.qrCode || '');
          toast('Código copiado.', 'success');
        } catch (err) {
          toast('Não foi possível copiar automaticamente.', 'error');
        }
      });
    }

    startWhatsappQrCountdown(container, conn.expiresAt);
  }

  async function whatsappAction(action) {
    const map = { connect: 'connect', reconnect: 'reconnect', disconnect: 'disconnect' };
    showLoader();
    try {
      if (action === 'disconnect' && !confirm('Desconectar o WhatsApp desta empresa? As mensagens automáticas voltam a ser simuladas.')) return;
      if (action === 'refresh') {
        const conn = await api('/api/admin/whatsapp/connection');
        renderWhatsappConnection($('whatsappTabBody'));
        toast(conn.status === 'connected' ? 'WhatsApp conectado.' : `Status: ${conn.status}`, conn.status === 'connected' ? 'success' : 'info');
        return;
      }
      const result = await api(`/api/admin/whatsapp/connection/${map[action]}`, { method: 'POST' });
      if (result.status === 'connected') {
        toast(result.message || 'WhatsApp já está conectado.', 'info');
      } else {
        toast(action === 'connect' ? 'QR Code gerado. Escaneie com o WhatsApp.' : action === 'reconnect' ? 'Novo QR Code gerado.' : 'WhatsApp desconectado.', 'success');
      }
      renderWhatsappConnection($('whatsappTabBody'), result);
    } catch (e) {
      toast(e.message, 'error');
      renderWhatsappConnection($('whatsappTabBody'));
    } finally {
      hideLoader();
    }
  }

  async function renderWhatsappTemplates(container) {
    container.innerHTML = '<div class="panel"><p class="sub">Carregando…</p></div>';
    let status;
    let templates;
    try {
      [status, templates] = await Promise.all([
        api('/api/admin/whatsapp/status'),
        api('/api/admin/whatsapp/templates')
      ]);
    } catch (e) {
      container.innerHTML = `<div class="panel"><p class="error">${escapeHtml(e.message)}</p></div>`;
      return;
    }
    const mode = status.mock
      ? '<span class="badge badge-pending">Modo simulado</span>'
      : '<span class="badge badge-confirmed">Envio real ativo</span>';
    container.innerHTML = `
      <div class="panel">
        <h3 class="review-section-title">Modo de envio</h3>
        <p class="sub" style="margin-top:0;">${mode} — enquanto o WhatsApp não estiver habilitado na plataforma, as mensagens são <strong>simuladas</strong> (registradas no histórico, sem envio real).</p>
      </div>
      <div class="panel">
        <h3 class="review-section-title">Mensagens automáticas</h3>
        <p class="sub" style="margin-top:0;">Ligue ou desligue cada evento e personalize o texto. Placeholders disponíveis: <code>{{CLIENTE_NOME}}</code>, <code>{{DATA_AGENDAMENTO}}</code>, <code>{{HORARIO_AGENDAMENTO}}</code>, <code>{{SERVICO}}</code>, <code>{{VEICULO}}</code>, <code>{{VALOR}}</code>, <code>{{SALDO_PACOTE}}</code>, <code>{{LINK_ADMIN}}</code> e outros.</p>
        ${templates.map((t) => `
          <div class="whatsapp-template" data-template="${escapeHtml(t.event_key)}">
            <div class="whatsapp-template-head">
              <strong>${escapeHtml(t.name)}</strong>
              <label class="switch-row" style="margin:0;"><input type="checkbox" class="wtEnabled" data-event="${escapeHtml(t.event_key)}" ${t.enabled ? 'checked' : ''} /><span>${t.enabled ? 'Ativa' : 'Desativada'}</span></label>
            </div>
            <textarea class="wtContent" data-event="${escapeHtml(t.event_key)}" rows="6" placeholder="Texto da mensagem">${escapeHtml(t.content)}</textarea>
            <div class="whatsapp-template-actions">
              <button type="button" class="btn btn-ghost btn-sm wtRestore" data-event="${escapeHtml(t.event_key)}">Restaurar modelo padrão</button>
              <button type="button" class="btn btn-primary btn-sm wtSave" data-event="${escapeHtml(t.event_key)}">Salvar</button>
            </div>
          </div>`).join('')}
      </div>
    `;
    container.querySelectorAll('.wtSave').forEach((b) => b.addEventListener('click', () => saveWhatsappTemplate(b.dataset.event)));
    container.querySelectorAll('.wtRestore').forEach((b) => b.addEventListener('click', () => restoreWhatsappTemplate(b.dataset.event)));
    container.querySelectorAll('.wtEnabled').forEach((c) => c.addEventListener('change', () => saveWhatsappTemplate(c.dataset.event)));
  }

  async function saveWhatsappTemplate(eventKey) {
    const box = document.querySelector(`[data-template="${eventKey}"]`);
    if (!box) return;
    const content = box.querySelector('.wtContent').value;
    const enabled = box.querySelector('.wtEnabled').checked;
    showLoader();
    try {
      await api(`/api/admin/whatsapp/templates/${encodeURIComponent(eventKey)}`, {
        method: 'PUT',
        body: JSON.stringify({ content, enabled })
      });
      toast('Modelo de mensagem salvo.', 'success');
      renderWhatsappTemplates($('whatsappTabBody'));
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  async function restoreWhatsappTemplate(eventKey) {
    showLoader();
    try {
      await api(`/api/admin/whatsapp/templates/${encodeURIComponent(eventKey)}/restore`, { method: 'POST' });
      toast('Modelo padrão restaurado.', 'success');
      renderWhatsappTemplates($('whatsappTabBody'));
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  async function renderWhatsappHistory(container, filters = {}) {
    container.innerHTML = '<div class="panel"><p class="sub">Carregando…</p></div>';
    let rows;
    try {
      const qs = new URLSearchParams(filters).toString();
      rows = await api(`/api/admin/whatsapp/history${qs ? '?' + qs : ''}`);
    } catch (e) {
      container.innerHTML = `<div class="panel"><p class="error">${escapeHtml(e.message)}</p></div>`;
      return;
    }
    if (!rows.length) {
      container.innerHTML = `
        <div class="panel">
          <div class="empty-state">Nenhuma mensagem ainda. As mensagens simuladas e os envios aparecem aqui.</div>
        </div>`;
      return;
    }
    const rowsHtml = rows.map((r) => `
      <tr>
        <td class="muted">${escapeHtml(r.created_at || '')}</td>
        <td><strong>${escapeHtml(r.recipient || '—')}</strong><br/><span class="muted">${escapeHtml(WHATSAPP_EVENT_LABELS[r.event_key] || r.event_label || r.event_key)}</span></td>
        <td class="wa-msg">${escapeHtml(r.message_text || '').replace(/\n/g, '<br/>')}</td>
        <td><span class="badge badge-${WHATSAPP_STATUS_CLASS[r.status] || 'pending'}">${WHATSAPP_STATUS_LABELS[r.status] || r.status}</span></td>
        <td>${r.attempts}</td>
        <td class="muted">${escapeHtml(r.error || '—')}</td>
        <td>${escapeHtml(r.sent_at || '—')}</td>
        <td><div class="appointment-actions">
          ${['FAILED', 'SIMULATED'].includes(r.status) && r.outbox_id
            ? `<button type="button" class="btn btn-ghost btn-sm waResend" data-id="${r.outbox_id}">Reenviar</button>`
            : ''}
        </div></td>
      </tr>`).join('');
    const eventOptions = Object.entries(WHATSAPP_EVENT_LABELS)
      .map(([k, v]) => `<option value="${k}" ${filters.event_key === k ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
    container.innerHTML = `
      <div class="panel">
        <h3 class="review-section-title">Histórico de mensagens</h3>
        <div class="form-grid" style="grid-template-columns: 1fr 1fr auto; margin-bottom:12px;">
          <div class="field">
            <label for="waHistStatus">Status</label>
            <select id="waHistStatus">
              <option value="">Todos</option>
              ${Object.entries(WHATSAPP_STATUS_LABELS).filter(([k]) => ['SENT', 'SIMULATED', 'FAILED'].includes(k))
                .map(([k, v]) => `<option value="${k}" ${filters.status === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="waHistEvent">Evento</label>
            <select id="waHistEvent"><option value="">Todos</option>${eventOptions}</select>
          </div>
          <div class="field" style="align-self:end;">
            <button type="button" class="btn btn-ghost" id="waHistFilter">Filtrar</button>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Data</th><th>Destinatário / evento</th><th>Mensagem</th><th>Status</th><th>Tentativas</th><th>Erro</th><th>Enviado em</th><th>Ações</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
      </div>
    `;
    container.querySelector('#waHistFilter').addEventListener('click', () => {
      renderWhatsappHistory(container, {
        status: container.querySelector('#waHistStatus').value,
        event_key: container.querySelector('#waHistEvent').value
      });
    });
    container.querySelectorAll('.waResend').forEach((b) => b.addEventListener('click', () => resendWhatsapp(b.dataset.id)));
  }

  async function resendWhatsapp(id) {
    showLoader();
    try {
      await api(`/api/admin/whatsapp/outbox/${id}/resend`, { method: 'POST' });
      toast('Mensagem reenviada.', 'success');
      renderWhatsappHistory($('whatsappTabBody'));
    } catch (e) {
      toast(e.message, 'error');
    }
    hideLoader();
  }

  /* ---------- settings ---------- */

  async function renderSettings() {
    const el = $('view-settings');
    const tab = state.settingsTab || 'geral';
    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Configurações</h1><div class="sub">Dados gerais, funcionamento e identidade visual</div></div>
      </div>
      <div class="tabs">
        <button type="button" class="tab ${tab === 'geral' ? 'active' : ''}" data-settings-tab="geral">Geral</button>
        <button type="button" class="tab ${tab === 'aparencia' ? 'active' : ''}" data-settings-tab="aparencia">Aparência</button>
        <button type="button" class="tab ${tab === 'documentos' ? 'active' : ''}" data-settings-tab="documentos">Documentos e privacidade</button>
      </div>
      <div id="settingsTabBody"></div>
    `;
    el.querySelectorAll('[data-settings-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.settingsTab === btn.dataset.settingsTab) return;
        state.settingsTab = btn.dataset.settingsTab;
        renderSettings();
      });
    });
    if (tab === 'aparencia') await renderAppearanceTab($('settingsTabBody'));
    else if (tab === 'documentos') await renderLegalDocsTab($('settingsTabBody'));
    else await renderGeneralTab($('settingsTabBody'));
  }

  /* ---------- Configurações > Documentos e privacidade ---------- */

  const LEGAL_DOC_LABELS = { terms: 'Termos de Uso', privacy: 'Aviso de Privacidade' };

  function legalDocDate(raw) {
    if (!raw) return '';
    const d = new Date(String(raw).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
  }

  async function renderLegalDocsTab(container) {
    container.innerHTML = '<div class="loading">Carregando documentos...</div>';
    let docs;
    try {
      docs = await api('/api/admin/legal-documents');
    } catch (e) {
      container.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      return;
    }
    container.innerHTML = `
      <div class="panel">
        <h3 class="review-section-title" style="border:0;margin:0 0 4px;padding:0;">Documentos legais exibidos no agendamento</h3>
        <p class="sub" style="margin-top:0;">Termos de Uso e Aviso de Privacidade que o cliente precisa aceitar para concluir um agendamento. O conteúdo usa os dados cadastrados em Configurações &gt; Geral.</p>
        <div class="stat-grid" style="grid-template-columns:repeat(2,1fr);">
          ${docs.map((d) => `
            <div class="stat-card">
              <div class="stat-label">${escapeHtml(LEGAL_DOC_LABELS[d.doc_key] || d.title)}</div>
              <div class="stat-value" style="font-size:18px;">${d.published ? 'Publicado' : 'Não publicado'}</div>
              <p class="sub" style="margin:6px 0 12px;">Versão ${escapeHtml(d.version)}${d.effective_at ? ' · vigente desde ' + escapeHtml(legalDocDate(d.effective_at)) : ''}</p>
              <button type="button" class="btn btn-outline btn-sm" data-view-legal-doc="${d.id}">Visualizar</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    container.querySelectorAll('[data-view-legal-doc]').forEach((btn) => {
      btn.addEventListener('click', () => openLegalDocModal(btn.dataset.viewLegalDoc));
    });
  }

  async function openLegalDocModal(id) {
    openModal('Carregando...', '<div class="loading">Carregando documento...</div>');
    try {
      const doc = await api(`/api/admin/legal-documents/${id}`);
      const body = `
        <p class="sub" style="margin-top:0;">Versão ${escapeHtml(doc.version)}${doc.effective_at ? ' · vigente desde ' + escapeHtml(legalDocDate(doc.effective_at)) : ''}</p>
        <div style="max-height:55vh;overflow-y:auto;white-space:pre-wrap;line-height:1.6;font-size:14px;">${escapeHtml(doc.content)}</div>
      `;
      openModal(doc.title, body, '<button type="button" class="btn btn-primary" data-close>Fechar</button>');
    } catch (e) {
      openModal('Documento', `<div class="error-box">${escapeHtml(e.message)}</div>`);
    }
  }

  async function renderGeneralTab(container) {
    const s = await api('/api/admin/settings');
    const days = s.working_days || [];

    container.innerHTML = `
      <div class="panel">
        <div class="admin-header" style="margin-bottom:18px;">
          <h3 class="review-section-title" style="border:0;margin:0;padding:0;">Empresa e contato</h3>
          <button class="btn btn-primary" id="settingsSave">Salvar configurações</button>
        </div>
        <div class="form-grid">
          <div class="field">${fieldHtml('setName', 'Nome da empresa', s.company_name, 'text')}</div>
          <div class="field">${fieldHtml('setPhone', 'Telefone', s.phone, 'text', '(00) 00000-0000')}</div>
          <div class="field">${fieldHtml('setWhatsapp', 'WhatsApp', s.whatsapp, 'text', '(00) 00000-0000')}</div>
          <div class="field">${fieldHtml('setCapacity', 'Capacidade simultânea (padrão)', s.capacity || 1, 'number')}</div>
        </div>
        <h3 class="review-section-title">Dados para os documentos legais</h3>
        <p class="sub" style="margin-top:0;">Usados nos Termos de Uso e no Aviso de Privacidade exibidos ao cliente no agendamento. Deixe em branco o que não se aplicar — o texto omite o dado ausente.</p>
        <div class="form-grid">
          <div class="field">${fieldHtml('setDocument', 'CNPJ ou CPF', s.document, 'text', '00.000.000/0000-00')}</div>
          <div class="field">${fieldHtml('setEmail', 'E-mail (contato e privacidade)', s.email, 'email', 'contato@suaempresa.com.br')}</div>
          <div class="field span-2">${fieldHtml('setAddress', 'Endereço', s.address, 'text', 'Rua, número, bairro, cidade/UF')}</div>
        </div>
        <h3 class="review-section-title">Horário de funcionamento</h3>
        <div class="form-grid">
          <div class="field"><label for="setOpen">Abertura</label><input type="time" id="setOpen" value="${escapeHtml(s.default_opening_time)}" /></div>
          <div class="field"><label for="setClose">Fechamento</label><input type="time" id="setClose" value="${escapeHtml(s.default_closing_time)}" /></div>
          <div class="field"><label for="setLunchStart">Almoço — início</label><input type="time" id="setLunchStart" value="${escapeHtml(s.lunch_start || '12:00')}" /></div>
          <div class="field"><label for="setLunchEnd">Almoço — fim</label><input type="time" id="setLunchEnd" value="${escapeHtml(s.lunch_end || '13:00')}" /></div>
          <div class="field">${fieldHtml('setInterval', 'Intervalo padrão (minutos)', s.default_interval, 'number')}</div>
          <div class="field"><label>Dias de funcionamento</label>
            <div class="checkbox-row">
              ${WEEKDAY_KEYS.map((d) => `<label class="switch-row"><input type="checkbox" class="setDay" data-day="${d}" ${days.includes(d) ? 'checked' : ''} /><span>${WEEKDAY_LABELS[d]}</span></label>`).join('')}
            </div>
          </div>
        </div>
        <h3 class="review-section-title">Mensagem de sucesso</h3>
        <div class="field"><label for="setMsg">Mensagem exibida ao cliente após enviar a solicitação</label>
          <textarea id="setMsg" rows="3">${escapeHtml(s.confirmation_message || '')}</textarea></div>
        <h3 class="review-section-title">Pagamento</h3>
        <div class="field">
          <label>Formas de pagamento habilitadas</label>
          <p class="sub" style="margin-top:0;">As opções desmarcadas não aparecem para o cliente no passo de pagamento do agendamento.</p>
          <div class="checkbox-row">
            ${PAYMENT_METHOD_KEYS.map((m) => `<label class="switch-row"><input type="checkbox" class="setPaymentMethod" data-method="${m}" ${(s.payment_methods_enabled || PAYMENT_METHOD_KEYS).includes(m) ? 'checked' : ''} /><span>${PAYMENT_LABELS[m]}</span></label>`).join('')}
          </div>
        </div>
        <h3 class="review-section-title">Pagamento — Pix</h3>
        <p class="sub" style="margin-top:0;">Dados exibidos ao cliente no passo de pagamento do agendamento.</p>
        <div class="form-grid">
          <div class="field span-2">
            <label>QR Code do Pix</label>
            <div class="branding-grid" id="pixQrBox"></div>
            <p class="sub">Imagem do QR Code final que o cliente escaneia (PNG, JPG ou WEBP, máx 3 MB).</p>
          </div>
          <div class="field">${fieldHtml('setPixCompany', 'Nome do recebedor (empresa)', s.pix_company_name, 'text', 'Ex: Sua Empresa')}</div>
          <div class="field"><label for="setPixCode">Chave Pix — copia e cola</label>
            <textarea id="setPixCode" rows="4" placeholder="Cole aqui o código Pix completo (copia e cola)">${escapeHtml(s.pix_code || '')}</textarea></div>
        </div>
      </div>
    `;
    bindPixQrCard(s);
    $('settingsSave').addEventListener('click', async () => {
      const days = [...document.querySelectorAll('.setDay:checked')].map((c) => Number(c.dataset.day));
      const body = {
        company_name: $('setName').value,
        phone: $('setPhone').value || null,
        whatsapp: $('setWhatsapp').value || null,
        document: $('setDocument').value || null,
        email: $('setEmail').value || null,
        address: $('setAddress').value || null,
        default_opening_time: $('setOpen').value,
        default_closing_time: $('setClose').value,
        lunch_start: $('setLunchStart').value,
        lunch_end: $('setLunchEnd').value,
        default_interval: Number($('setInterval').value),
        working_days: days,
        capacity: Number($('setCapacity').value),
        confirmation_message: $('setMsg').value,
        payment_methods_enabled: [...document.querySelectorAll('.setPaymentMethod:checked')].map((c) => c.dataset.method),
        pix_company_name: $('setPixCompany').value || null,
        pix_code: $('setPixCode').value || null
      };
      try {
        showLoader();
        const saved = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
        state.settings = saved;
        applyBrandName(saved && saved.company_name);
        toast('Configurações salvas.', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
      hideLoader();
    });
  }

  /* QR Code do Pix (Configurações > Geral): cartão de prévia + upload/remoção.
     Atualiza apenas o cartão após cada operação, sem perder os textos digitados
     (chave/nome). A prévia usa a rota pública /api/payment/pix-qr — como o admin
     roda no próprio domínio do tenant, a rota pública resolve para a mesma
     empresa do usuário logado, sem precisar de auth no <img> (mesmo padrão da
     logo na aba Aparência). */
  function pixQrCardHtml(hasQr, url) {
    return `
      <div class="branding-card">
        <div class="branding-preview">${hasQr
          ? `<img src="${escapeHtml(url)}" alt="QR Code Pix" />`
          : '<span class="sub">Nenhum QR Code enviado</span>'}</div>
        <p class="sub">PNG, JPG ou WEBP (máx 3 MB)</p>
        <div class="branding-actions">
          ${hasQr ? '<button type="button" class="btn btn-outline btn-sm" data-pixqr-action="remove">Remover</button>' : ''}
          <label class="btn btn-ghost btn-sm branding-upload">${hasQr ? 'Substituir' : 'Enviar QR Code'}<input type="file" data-pixqr-file accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden /></label>
        </div>
      </div>`;
  }

  function bindPixQrCard(s) {
    const box = $('pixQrBox');
    if (!box) return;
    const hasQr = Boolean(s.pix_qr_path);
    const url = hasQr ? `/api/payment/pix-qr?v=${encodeURIComponent(s.updated_at || '')}` : null;
    box.innerHTML = pixQrCardHtml(hasQr, url);

    box.onclick = async (e) => {
      const btn = e.target.closest('[data-pixqr-action="remove"]');
      if (!btn) return;
      try {
        showLoader();
        const res = await api('/api/admin/settings/pix-qr', { method: 'DELETE' });
        box.innerHTML = pixQrCardHtml(res.has_pix_qr, res.pix_qr_url);
        toast('QR Code Pix removido.', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      hideLoader();
    };

    /* Delegado no container: sobrevive à troca de innerHTML do cartão. */
    box.onchange = async (e) => {
      const input = e.target.closest('[data-pixqr-file]');
      if (!input || !input.files.length) return;
      const label = box.querySelector('.branding-upload');
      const original = label.textContent;
      label.textContent = 'Enviando…';
      label.classList.add('disabled');
      const fd = new FormData();
      fd.append('file', input.files[0]);
      try {
        showLoader();
        const res = await apiForm('/api/admin/settings/pix-qr', fd);
        box.innerHTML = pixQrCardHtml(res.has_pix_qr, res.pix_qr_url);
        toast('QR Code Pix enviado.', 'success');
      } catch (err) {
        toast(err.message, 'error');
        input.value = '';
      }
      hideLoader();
    };
  }

  /* ---------- Configurações > Aparência ---------- */

  /* Usa a rota pública (sem auth) para a prévia: <img src> não consegue
     enviar o header Authorization exigido por /api/admin/branding/*, e como
     o admin roda no próprio domínio do tenant, a rota pública já resolve
     para a mesma empresa do usuário logado — mesmo arquivo, sem precisar de
     fetch + blob URL. */
  function brandingAssetUrl(kind, ts) {
    return `/api/branding/${kind}?v=${encodeURIComponent(ts || '')}`;
  }

  const BRAND_MESSAGES = {
    logo: { uploaded: 'Logo enviada.', removed: 'Logo removida.' },
    favicon: { uploaded: 'Favicon enviado.', removed: 'Favicon removido.' },
    'admin-icon': { uploaded: 'Ícone do Admin enviado.', removed: 'Ícone do Admin removido.' }
  };

  function themeCardHtml(theme, isSelected, isSaved) {
    const c = theme.colors;
    const dots = [c.primary, c.secondary, c.accent, c.background, c.surface, c.success].map(
      (hex) => `<span class="theme-dot" style="background:${escapeHtml(hex)}"></span>`
    ).join('');
    return `
      <button type="button" class="theme-card ${isSelected ? 'selected' : ''}" data-theme-key="${escapeHtml(theme.key)}"
        role="radio" aria-checked="${isSelected ? 'true' : 'false'}">
        ${isSaved ? '<span class="theme-current">Tema atual</span>' : ''}
        <div class="theme-preview" style="background:${escapeHtml(c.background)};border-color:${escapeHtml(c.border)};">
          <span class="theme-preview-btn" style="background:${escapeHtml(c.primary)};color:${escapeHtml(c.text)};">Agendar</span>
          <span class="theme-preview-card" style="background:${escapeHtml(c.surface)};border-color:${escapeHtml(c.border)};"></span>
        </div>
        <div class="theme-dots">${dots}</div>
        <div class="theme-name">${escapeHtml(theme.name)}${isSelected ? ' <span class="theme-selected-mark">✓ Selecionado</span>' : ''}</div>
        <div class="theme-desc">${escapeHtml(theme.description)}</div>
      </button>
    `;
  }

  async function renderAppearanceTab(container) {
    container.innerHTML = '<div class="panel"><p class="sub">Carregando…</p></div>';
    let data;
    try {
      data = await api('/api/admin/branding');
    } catch (e) {
      container.innerHTML = `<div class="panel"><p class="error">${escapeHtml(e.message)}</p></div>`;
      return;
    }

    const savedThemeKey = data.branding.theme_key;
    const savedColors = data.branding.colors;
    let selectedThemeKey = savedThemeKey;

    function paint() {
      const b = data.branding;
      const hasLogo = b.has_logo, hasFav = b.has_favicon, hasAdminIcon = b.has_admin_icon, ts = b.updated_at;
      const companyName = (state.settings && state.settings.company_name) || 'Sua empresa';
      container.innerHTML = `
        <div class="panel">
          <h3 class="review-section-title">Logo, favicon e ícone do Admin</h3>
          <div class="branding-grid">
            <div class="branding-card">
              <h4 class="branding-card-title">Logo da empresa</h4>
              <div class="branding-preview"><img data-preview="logo" src="${hasLogo ? escapeHtml(brandingAssetUrl('logo', ts)) : '/assets/logo.png'}" alt="Logo atual" /></div>
              <p class="sub">PNG, JPG ou WEBP (máx 3 MB)</p>
              <div class="branding-actions">
                ${hasLogo ? '<button type="button" class="btn btn-outline btn-sm" data-brand-action="remove" data-brand-kind="logo">Remover</button>' : ''}
                <label class="btn btn-ghost btn-sm branding-upload">${hasLogo ? 'Substituir' : 'Enviar logo'}<input type="file" data-brand-file="logo" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden /></label>
              </div>
            </div>
            <div class="branding-card">
              <h4 class="branding-card-title">Favicon / ícone público</h4>
              <div class="branding-preview"><img data-preview="favicon" src="${hasFav ? escapeHtml(brandingAssetUrl('favicon', ts)) : '/assets/favicon.png'}" alt="Favicon atual" /></div>
              <p class="sub">PNG ou ICO (máx 1 MB) — ícone do agendamento público quando instalado no celular, use uma imagem quadrada (ex.: 512×512)</p>
              <div class="branding-actions">
                ${hasFav ? '<button type="button" class="btn btn-outline btn-sm" data-brand-action="remove" data-brand-kind="favicon">Remover</button>' : ''}
                <label class="btn btn-ghost btn-sm branding-upload">${hasFav ? 'Substituir' : 'Enviar favicon'}<input type="file" data-brand-file="favicon" accept=".png,.ico,image/png,image/x-icon,image/vnd.microsoft.icon" hidden /></label>
              </div>
            </div>
            <div class="branding-card">
              <h4 class="branding-card-title">Ícone do Admin</h4>
              <div class="branding-preview"><img data-preview="admin-icon" src="${escapeHtml(brandingAssetUrl('admin-icon', ts))}" alt="Ícone do Admin atual" /></div>
              <p class="sub">Ícone usado quando o painel administrativo é instalado ou adicionado à tela inicial do celular. Recomendado: 512×512, PNG ou WEBP, quadrado, sem textos pequenos (máx 3 MB).</p>
              <div class="branding-actions">
                ${hasAdminIcon ? '<button type="button" class="btn btn-outline btn-sm" data-brand-action="remove" data-brand-kind="admin-icon">Remover</button>' : ''}
                <label class="btn btn-ghost btn-sm branding-upload">${hasAdminIcon ? 'Substituir' : 'Enviar imagem'}<input type="file" data-brand-file="admin-icon" accept=".png,.jpg,.jpeg,.webp,.ico,image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon" hidden /></label>
              </div>
              ${!hasAdminIcon ? '<p class="sub branding-fallback-note">Sem imagem própria, o Admin usa o favicon, depois a logo, e por fim o ícone padrão do PapiCore.</p>' : ''}
            </div>
          </div>
          <div class="branding-preview-sim">
            <p class="sub" style="margin-bottom:8px;">Como aparecerá na tela inicial do celular:</p>
            <div class="branding-preview-sim-row">
              <div class="branding-preview-sim-item">
                <img src="${hasFav ? escapeHtml(brandingAssetUrl('favicon', ts)) : '/assets/favicon.png'}" alt="" />
                <span>${escapeHtml(companyName)}</span>
              </div>
              <div class="branding-preview-sim-item">
                <img src="${escapeHtml(brandingAssetUrl('admin-icon', ts))}" alt="" />
                <span>${escapeHtml(companyName)} Admin</span>
              </div>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="admin-header" style="margin-bottom:14px;">
            <h3 class="review-section-title" style="border:0;margin:0;padding:0;">Tema de cores</h3>
            <div class="row-actions">
              <button type="button" class="btn btn-ghost btn-sm" id="themeCancel" ${selectedThemeKey === savedThemeKey ? 'hidden' : ''}>Cancelar</button>
              <button type="button" class="btn btn-primary" id="themeSave" ${selectedThemeKey === savedThemeKey ? 'disabled' : ''}>Salvar aparência</button>
            </div>
          </div>
          <div class="theme-grid" id="themeGrid" role="radiogroup" aria-label="Tema de cores">
            ${themes.map((t) => themeCardHtml(t, t.key === selectedThemeKey, t.key === savedThemeKey)).join('')}
          </div>
        </div>
      `;

      const box = container.querySelector('.branding-grid').closest('.panel');
      box.onclick = async (e) => {
        const btn = e.target.closest('[data-brand-action="remove"]');
        if (!btn) return;
        const kind = btn.dataset.brandKind;
        try {
          showLoader();
          const res = await api(`/api/admin/branding/${kind}`, { method: 'DELETE' });
          data.branding = res.branding;
          toast(BRAND_MESSAGES[kind].removed, 'success');
          paint();
        } catch (err) {
          toast(err.message, 'error');
        }
        hideLoader();
      };
      box.querySelectorAll('[data-brand-file]').forEach((input) => {
        input.onchange = async () => {
          const file = input.files[0];
          if (!file) return;
          const kind = input.dataset.brandFile;
          const fd = new FormData();
          fd.append('file', file);
          try {
            showLoader();
            const res = await apiForm(`/api/admin/branding/${kind}`, fd);
            data.branding = res.branding;
            toast(BRAND_MESSAGES[kind].uploaded, 'success');
            paint();
          } catch (err) {
            toast(err.message, 'error');
            input.value = '';
          }
          hideLoader();
        };
      });

      $('themeGrid').addEventListener('click', (e) => {
        const card = e.target.closest('[data-theme-key]');
        if (!card) return;
        selectedThemeKey = card.dataset.themeKey;
        const preset = themes.find((t) => t.key === selectedThemeKey);
        if (preset && window.applyTenantTheme) window.applyTenantTheme(preset.colors);
        paint();
      });

      const cancelBtn = $('themeCancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          selectedThemeKey = savedThemeKey;
          if (window.applyTenantTheme) window.applyTenantTheme(savedColors);
          paint();
        });
      }

      const saveBtn = $('themeSave');
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Salvando…';
          try {
            const res = await api('/api/admin/branding/theme', {
              method: 'PUT',
              body: JSON.stringify({ theme_key: selectedThemeKey })
            });
            data.branding = res.branding;
            if (window.applyTenantTheme) window.applyTenantTheme(res.branding.colors);
            toast('Aparência salva.', 'success');
            renderAppearanceTab(container);
          } catch (err) {
            toast(err.message, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Salvar aparência';
          }
        });
      }
    }

    const themes = data.available_themes;
    paint();
  }

  /* ---------- init ---------- */

  function bindGlobals() {
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('loginMsg');
      msg.classList.add('hidden');
      showLoader();
      try {
        await login($('loginEmail').value, $('loginPassword').value);
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.remove('hidden');
      }
      hideLoader();
    });

    $('btnForgotPassword').addEventListener('click', showForgotForm);
    $('btnBackToLogin').addEventListener('click', showLoginForm);

    $('forgotForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('forgotMsg');
      msg.classList.remove('hidden', 'success');
      showLoader();
      try {
        const data = await api('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email: $('forgotEmail').value })
        });
        msg.textContent = data.message;
        msg.classList.add('success');
      } catch (err) {
        msg.textContent = err.message;
      }
      hideLoader();
    });

    document.querySelectorAll('.admin-nav button[data-view]').forEach((b) => {
      b.addEventListener('click', () => showView(b.dataset.view));
    });

    $('btnLogout').addEventListener('click', () => { logout(); });
    $('btnMenu').addEventListener('click', () => {
      if ($('sidebar').classList.contains('open')) closeSidebar();
      else openSidebar();
    });
    $('sidebarBackdrop').addEventListener('click', closeSidebar);
  }

  async function init() {
    /* /admin/redefinir-senha serve este mesmo admin.html, num "modo"
       totalmente separado do login/painel — nem tenta autenticar. */
    if (window.location.pathname === '/admin/redefinir-senha') {
      return initResetPasswordView();
    }

    bindGlobals();

    /* Logo, favicon e título dinâmicos (identidade visual do tenant do
       domínio atual), aplicados na tela de login e no painel. */
    if (window.loadTenantBranding) window.loadTenantBranding();

    /* decora tabelas com data-label para o layout em cartões no mobile */
    function decorateTables() {
      document.querySelectorAll('#panelView table').forEach((table) => {
        if (table.dataset.decorated) return;
        table.dataset.decorated = '1';
        const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        table.querySelectorAll('tbody tr').forEach((tr) => {
          [...tr.children].forEach((td, i) => {
            if (heads[i]) td.dataset.label = heads[i];
            if (td.querySelector('button')) td.classList.add('cell-actions');
          });
        });
      });
    }
    new MutationObserver(() => decorateTables()).observe($('panelView'), { childList: true, subtree: true });

    if (state.token) {
      try {
        await enterPanel();
        return;
      } catch (e) {
        logout();
      }
    }
    $('loginView').classList.remove('hidden');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
