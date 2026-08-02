(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'torque_admin_token';

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
  const CATEGORY_LABELS = { hatch: 'Hatch', sedan: 'Sedan', suv: 'SUV', pickup: 'Picape' };
  const PAYMENT_LABELS = {
    local: 'Pagamento no local',
    card: 'Crédito/débito no local',
    pix: 'Pix (copia e cola)',
    qrcode: 'Pix (QR Code)'
  };

  let state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: null,
    view: 'dashboard',
    appointmentStatus: 'all',
    modal: null,
    units: [],
    modalities: [],
    services: [],
    categories: []
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
    await loadBase();
    showView('dashboard');
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
      services: 'Serviços e valores',
      units: 'Unidades',
      blocks: 'Bloqueios',
      modalities: 'Formas de atendimento',
      settings: 'Configurações'
    };
    $('topbarTitle').textContent = titles[name];
    closeSidebar();
    const renderer = {
      dashboard: renderDashboard,
      agenda: renderAgenda,
      appointments: renderAppointments,
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

  async function renderDashboard() {
    const data = await api('/api/admin/dashboard');
    const el = $('view-dashboard');
    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Dashboard</h1><div class="sub">${toDateBR(todayStr())} · Olá, ${escapeHtml(state.user ? state.user.name : '')}</div></div>
      </div>
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
                  <td>${escapeHtml(a.start_time)}</td>
                  <td>${escapeHtml(a.service_name || '—')}</td>
                  <td>${badge(a.status)}</td>
                </tr>`).join('')}
            </tbody>
          </table></div>` : '<div class="empty-state">Nenhum agendamento futuro.</div>'}
      </div>
    `;
  }

  /* ---------- agenda ---------- */

  async function renderAgenda() {
    const el = $('view-agenda');
    const date = state.modal ? state.modal.agendaDate || todayStr() : todayStr();
    const data = await api('/api/admin/agenda?date=' + date);
    state.modal = { agendaDate: date };

    const rows = data.appointments.map((a) => {
      const actions = [];
      if (a.status === 'pending') {
        actions.push(`<button class="btn btn-sm btn-success" data-action="accept" data-id="${a.id}">Aceitar</button>`);
        actions.push(`<button class="btn btn-sm btn-danger" data-action="reject" data-id="${a.id}">Recusar</button>`);
      }
      actions.push(`<button class="btn btn-sm btn-outline" data-action="detail" data-id="${a.id}">Detalhes</button>`);
      return `
        <tr>
          <td><strong>${escapeHtml(a.start_time)}</strong><br /><span class="muted">${a.end_date && a.end_date !== date ? toDateBR(a.end_date) + ' ' : ''}${escapeHtml(a.end_time || '—')}</span></td>
          <td>${escapeHtml(a.customer_name)}</td>
          <td>${escapeHtml(a.vehicle_brand)} ${escapeHtml(a.vehicle_model)}</td>
          <td>${escapeHtml(a.service_name || '—')}${a.booked_duration_minutes ? `<br/><span class="muted">${fmtDur(a.booked_duration_minutes)}</span>` : ''}</td>
          <td>${escapeHtml(a.modality_name || '—')}${a.payment_method ? `<br/><span class="muted">${escapeHtml(PAYMENT_LABELS[a.payment_method] || a.payment_method)}</span>` : ''}</td>
          <td>${badge(a.status)}</td>
          <td><div class="row-actions">${actions.join('')}</div></td>
        </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Agenda</h1><div class="sub">Horários do dia (início → término)</div></div>
        <input type="date" id="agendaDate" value="${date}" style="width:auto;" />
      </div>
      <div class="panel">
        ${data.appointments.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Início → Término</th><th>Cliente</th><th>Veículo</th><th>Serviço</th><th>Modalidade</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhum agendamento nesta data.</div>'}
      </div>
    `;
    $('agendaDate').addEventListener('change', (e) => {
      state.modal.agendaDate = e.target.value;
      renderAgenda();
    });
    bindRowActions(el);
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
        actions.push(`<button class="btn btn-sm btn-success" data-action="accept" data-id="${a.id}">Aceitar</button>`);
        actions.push(`<button class="btn btn-sm btn-danger" data-action="reject" data-id="${a.id}">Recusar</button>`);
      }
      if (a.status === 'confirmed') {
        actions.push(`<button class="btn btn-sm btn-success" data-action="complete" data-id="${a.id}">Concluir</button>`);
        actions.push(`<button class="btn btn-sm btn-outline" data-action="cancel" data-id="${a.id}">Cancelar</button>`);
      }
      if (a.status === 'pending' || a.status === 'confirmed') {
        actions.push(`<button class="btn btn-sm btn-outline" data-action="edit" data-id="${a.id}">Editar</button>`);
      }
      actions.push(`<button class="btn btn-sm btn-outline" data-action="detail" data-id="${a.id}">Detalhes</button>`);
      actions.push(`<button class="btn btn-sm btn-danger" data-action="delete" data-id="${a.id}">Excluir</button>`);
      return `
        <tr>
          <td><strong>${escapeHtml(a.appointment_code)}</strong></td>
          <td>${escapeHtml(a.customer_name)}<br /><span class="muted">${escapeHtml(a.customer_phone)}</span></td>
          <td>${toDateBR(a.appointment_date)}<br /><span class="muted">${escapeHtml(a.start_time)} → ${a.end_date && a.end_date !== a.appointment_date ? toDateBR(a.end_date) + ' ' : ''}${escapeHtml(a.end_time || '—')}</span></td>
          <td>${escapeHtml(a.service_name || '—')}<br /><span class="muted">${escapeHtml(a.modality_name || '')}${a.unit_name ? ' · ' + escapeHtml(a.unit_name) : ''}</span></td>
          <td>${money(a.total_price)}${a.price_is_estimate ? ' <span class="muted">(est.)</span>' : ''}<br />${a.payment_method ? `<span class="muted">${escapeHtml(PAYMENT_LABELS[a.payment_method] || a.payment_method)}</span>` : ''}</td>
          <td>${badge(a.status)}</td>
          <td><div class="row-actions">${actions.join('')}</div></td>
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
          <thead><tr><th>Código</th><th>Cliente</th><th>Data</th><th>Serviço</th><th>Total</th><th>Status</th><th></th></tr></thead>
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
    if (state.view === 'agenda') return renderAgenda();
    return renderAppointments();
  }

  /* ---------- appointment modal (create/edit) ---------- */

  async function openAppointmentModal(id) {
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
          <div class="field"><label for="apptDate">Data</label><input type="date" id="apptDate" value="${escapeHtml(v('appointment_date', todayStr()))}" /></div>
          <div class="field">${fieldHtml('apptTime', 'Início', v('start_time'), 'time')}</div>
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
      ['Horário', `${a.start_time} às ${a.end_time}`],
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

    openModal('Detalhes do agendamento', `
      <div class="panel">
        ${lines.filter(([, val]) => val).map(([k, val]) => `<div class="review-line"><span>${escapeHtml(k)}</span><strong>${escapeHtml(val)}</strong></div>`).join('')}
        ${reasonLines.length ? `<div class="review-total">${reasonLines.filter(([, val]) => val).map(([k, val]) => `<div class="review-line"><span>${escapeHtml(k)}</span><strong>${escapeHtml(val)}</strong></div>`).join('')}</div>` : ''}
      </div>
    `, `<button class="btn btn-ghost" data-close>Fechar</button>`);
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
        <td><button class="btn btn-sm btn-outline" data-action="editCategory" data-id="${c.id}">Editar</button></td>
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
        <td><div class="row-actions">
          <button class="btn btn-sm btn-outline" data-action="editService" data-id="${s.id}">Editar</button>
          <button class="btn btn-sm ${s.active ? 'btn-outline' : 'btn-success'}" data-action="toggleService" data-id="${s.id}">${s.active ? 'Desativar' : 'Ativar'}</button>
          <button class="btn btn-sm btn-danger" data-action="deleteService" data-id="${s.id}">Excluir</button>
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
          <thead><tr><th>Categoria</th><th>Serviços</th><th>Ordem</th><th>Status</th><th></th></tr></thead>
          <tbody>${catRows}</tbody>
        </table></div>` : '<div class="empty-state">Nenhuma categoria.</div>'}
      </div>
      <div class="panel">
        <h3 class="review-section-title">Serviços</h3>
        ${state.services.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Serviço</th><th>Preço</th><th>Duração</th><th>Disponibilidade</th><th>Status</th><th></th></tr></thead>
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
        <td><div class="row-actions">
          <button class="btn btn-sm btn-outline" data-action="editUnit" data-id="${u.id}">Editar</button>
          ${u.active ? `<button class="btn btn-sm btn-outline" data-action="toggleUnit" data-id="${u.id}">Desativar</button>` : `<button class="btn btn-sm btn-success" data-action="toggleUnit" data-id="${u.id}">Ativar</button>`}
          <button class="btn btn-sm btn-danger" data-action="deleteUnit" data-id="${u.id}">Excluir</button>
        </div></td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Unidades</h1><div class="sub">Pontos de atendimento da Lavagem na unidade</div></div>
        <button class="btn btn-primary" id="btnNewUnit">+ Nova unidade</button>
      </div>
      <div class="panel">
        ${state.units.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Unidade</th><th>Telefone</th><th>Horário</th><th>Capacidade</th><th>Status</th><th></th></tr></thead>
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
      const days = [...document.querySelectorAll('.unitDay:checked')].map((c) => Number(c.dataset.day));
      const body = {
        name: $('unitName').value,
        address_street: $('unitStreet').value,
        address_number: $('unitNumber').value,
        address_complement: $('unitComplement').value,
        address_neighborhood: $('unitNeighborhood').value,
        address_city: $('unitCity').value,
        address_state: $('unitState').value,
        address_zipcode: $('unitZipcode').value,
        address_reference: $('unitReference').value,
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
        <td><button class="btn btn-sm btn-outline" data-action="editModality" data-id="${m.id}">Editar</button></td>
      </tr>`).join('');

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Formas de atendimento</h1><div class="sub">Modalidades e taxas aplicadas no agendamento</div></div>
      </div>
      <div class="panel">
        <div class="table-wrap"><table>
          <thead><tr><th>Modalidade</th><th>Taxa</th><th>Status</th><th></th></tr></thead>
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
    const s = await api('/api/admin/settings');
    const el = $('view-settings');
    const days = s.working_days || [];

    el.innerHTML = `
      <div class="admin-header">
        <div><h1>Configurações</h1><div class="sub">Dados gerais e funcionamento do agendamento</div></div>
        <button class="btn btn-primary" id="settingsSave">Salvar configurações</button>
      </div>
      <div class="panel">
        <h3 class="review-section-title">Empresa e contato</h3>
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
      </div>
    `;
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
        confirmation_message: $('setMsg').value
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
