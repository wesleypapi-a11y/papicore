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
  const CATEGORY_LABELS = { hatch: 'Hatch', sedan: 'Sedan', suv: 'SUV', pickup: 'Picape' };
  const PAYMENT_LABELS = {
    local: 'Pagamento no local',
    card: 'Crédito/débito no local',
    pix: 'Pix (copia e cola)',
    qrcode: 'Pix (QR Code)'
  };
  const PAYMENT_METHOD_KEYS = ['local', 'card', 'pix', 'qrcode'];
  const LONG_SERVICE_THRESHOLD_MINUTES = 2 * 24 * 60;
  function isLongAppointment(a) {
    return Number(a && a.booked_duration_minutes || 0) > LONG_SERVICE_THRESHOLD_MINUTES;
  }
  function appointmentTimeLabel(a) {
    return isLongAppointment(a) ? 'Horário a confirmar' : (a.start_time || '—');
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
  function actionButton(action, id, opts) {
    opts = opts || {};
    const icon = opts.icon || action;
    const cls = opts.cls || ACTION_CLASSES[icon];
    const label = opts.label || ACTION_LABELS[action] || ACTION_LABELS[icon];
    return `<button type="button" class="action-btn ${cls}" data-action="${action}" data-id="${id}" title="${label}" aria-label="${label}">${ACTION_ICONS[icon]}</button>`;
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
    const [units, modalities, services, categories] = await Promise.all([
      api('/api/admin/units').catch(() => []),
      api('/api/admin/modalities').catch(() => []),
      api('/api/admin/services').catch(() => []),
      api('/api/admin/service-categories').catch(() => [])
    ]);
    state.units = units;
    state.modalities = modalities;
    state.services = services;
    state.categories = categories;
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
      units: 'Unidades',
      blocks: 'Bloqueios',
      modalities: 'Formas de atendimento',
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
      units: renderUnits,
      blocks: renderBlocks,
      modalities: renderModalities,
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

    const rows = data.map((a) => {
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
      return `
        <tr>
          <td><strong>${escapeHtml(a.appointment_code)}</strong></td>
          <td>${escapeHtml(a.customer_name)}<br /><span class="muted">${escapeHtml(a.customer_phone)}</span></td>
          <td>${toDateBR(a.appointment_date)}<br /><span class="muted">${escapeHtml(appointmentTimeLabel(a))}${isLongAppointment(a) ? '' : ' → ' + (a.end_date && a.end_date !== a.appointment_date ? toDateBR(a.end_date) + ' ' : '') + escapeHtml(a.end_time || '—')}</span></td>
          <td>${escapeHtml(a.service_name || '—')}<br /><span class="muted">${escapeHtml(a.modality_name || '')}${a.unit_name ? ' · ' + escapeHtml(a.unit_name) : ''}</span></td>
          <td>${money(a.total_price)}${a.price_is_estimate ? ' <span class="muted">(est.)</span>' : ''}<br />${a.payment_method ? `<span class="muted">${escapeHtml(PAYMENT_LABELS[a.payment_method] || a.payment_method)}</span>` : ''}</td>
          <td>${badge(a.status)}</td>
          <td><div class="appointment-actions">${actions.join('')}</div></td>
        </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Agendamentos</h1><div class="sub">Gerencie solicitações e reservas</div></div>
        <button class="btn btn-primary" id="btnNewAppointment">+ Novo agendamento</button>
      </div>
      <div class="tabs">${tabs}</div>
      <div class="panel">
        ${data.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Código</th><th>Cliente</th><th>Data</th><th>Serviço</th><th>Total</th><th>Status</th><th>Ações</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhum agendamento neste filtro.</div>'}
      </div>
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

    const v = (field, def) => (appt && appt[field] != null ? appt[field] : def);

    openModal(id ? 'Editar agendamento' : 'Novo agendamento', `
      <form id="apptForm" novalidate>
        <div class="form-grid">
          <div class="field"><label>Forma de atendimento</label>
            <select id="apptModality">${modOpts}</select></div>
          <div class="field"><label>Unidade</label>
            <select id="apptUnit"><option value="">—</option>${unitOpts}</select></div>
          <div class="field span-2"><label>Serviço</label>
            <select id="apptService"><option value="">—</option>${serviceOpts}</select></div>
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
    } else if (prefill && prefill.unitId) {
      $('apptUnit').value = prefill.unitId;
    }
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
        customer_notes: $('apptNotes').value || null
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
        <td>${fmtDur(s.duration_minutes)}${s.pickup_extra_minutes ? `<br/><span class="muted">picape +${fmtDur(s.pickup_extra_minutes)}</span>` : ''}</td>
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
          <div class="field">${fieldHtml('svcPickupExtra', 'Acréscimo para picape (min)', v('pickup_extra_minutes', 0), 'number')}</div>
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
        price_hatch: priceType === 'category' ? Number($('pfHatch').value) : null,
        price_sedan: priceType === 'category' ? Number($('pfSedan').value) : null,
        price_suv: priceType === 'category' ? Number($('pfSuv').value) : null,
        price_pickup: priceType === 'category' ? Number($('pfPickup').value) : null,
        starting_price: priceType === 'starting' ? Number($('pfStarting').value) : null,
        duration_minutes: Number($('svcDuration').value),
        pickup_extra_minutes: Number($('svcPickupExtra').value || 0),
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
            <div class="field">${fieldHtml('pfHatch', 'Hatch (R$)', v('price_hatch', ''), 'number')}</div>
            <div class="field">${fieldHtml('pfSedan', 'Sedan (R$)', v('price_sedan', ''), 'number')}</div>
            <div class="field">${fieldHtml('pfSuv', 'SUV (R$)', v('price_suv', ''), 'number')}</div>
            <div class="field">${fieldHtml('pfPickup', 'Picape (R$)', v('price_pickup', ''), 'number')}</div>
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
    else await renderGeneralTab($('settingsTabBody'));
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
        await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
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
      const hasLogo = b.has_logo, hasFav = b.has_favicon, ts = b.updated_at;
      container.innerHTML = `
        <div class="panel">
          <h3 class="review-section-title">Logo e favicon</h3>
          <div class="branding-grid">
            <div class="branding-card">
              <div class="branding-preview"><img data-preview="logo" src="${hasLogo ? escapeHtml(brandingAssetUrl('logo', ts)) : '/assets/logo.png'}" alt="Logo atual" /></div>
              <p class="sub">PNG, JPG ou WEBP (máx 3 MB)</p>
              <div class="branding-actions">
                ${hasLogo ? '<button type="button" class="btn btn-outline btn-sm" data-brand-action="remove-logo">Remover</button>' : ''}
                <label class="btn btn-ghost btn-sm branding-upload">${hasLogo ? 'Substituir' : 'Enviar logo'}<input type="file" data-brand-file="logo" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden /></label>
              </div>
            </div>
            <div class="branding-card">
              <div class="branding-preview"><img data-preview="favicon" src="${hasFav ? escapeHtml(brandingAssetUrl('favicon', ts)) : '/assets/favicon.png'}" alt="Favicon atual" /></div>
              <p class="sub">PNG ou ICO (máx 1 MB) — também vira o ícone do app no celular, use uma imagem quadrada (ex.: 512×512)</p>
              <div class="branding-actions">
                ${hasFav ? '<button type="button" class="btn btn-outline btn-sm" data-brand-action="remove-favicon">Remover</button>' : ''}
                <label class="btn btn-ghost btn-sm branding-upload">${hasFav ? 'Substituir' : 'Enviar favicon'}<input type="file" data-brand-file="favicon" accept=".png,.ico,image/png,image/x-icon,image/vnd.microsoft.icon" hidden /></label>
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
        const btn = e.target.closest('[data-brand-action]');
        if (!btn) return;
        const kind = btn.dataset.brandAction === 'remove-logo' ? 'logo' : 'favicon';
        try {
          showLoader();
          const res = await api(`/api/admin/branding/${kind}`, { method: 'DELETE' });
          data.branding = res.branding;
          toast(kind === 'logo' ? 'Logo removida.' : 'Favicon removido.', 'success');
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
            toast(kind === 'logo' ? 'Logo enviada.' : 'Favicon enviado.', 'success');
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
