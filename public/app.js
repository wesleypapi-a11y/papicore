(function () {
  'use strict';

  const STORAGE_KEY = `papicore_booking_state:${window.location.hostname}`;
  const $ = (id) => document.getElementById(id);

  const state = {
    settings: {},
    modalities: [],
    units: [],
    currentStep: 1,
    modality: null,
    unit: null,
    customer: { name: '', phone: '', email: '', cpf: '' },
    vehicle: { brand: '', model: '', year: '', plate: '', color: '', category: '' },
    date: null,
    services: [],
    slot: null,
    slotEndDate: null,
    slotEndTime: null,
    slotDuration: null,
    address: {},
    responsible_name: '',
    key_delivery_confirmed: false,
    has_water_access: false,
    has_power_access: false,
    customer_notes: '',
    paymentMethod: '',
    cardPaid: false
  };

  const STEP_LABELS = ['Atendimento', 'Dados', 'Veículo', 'Data', 'Serviço', 'Horário', 'Revisão', 'Pagamento'];
  const TOTAL_STEPS = 8;

  const PAYMENT_METHODS = [
    { key: 'local', name: 'Pagamento no local', desc: 'Pague em dinheiro ou no meio que preferir na hora do serviço.' },
    { key: 'card', name: 'Crédito ou débito no local', desc: 'Informe os dados do cartão e finalize o pagamento.' },
    { key: 'pix', name: 'Pix (copia e cola)', desc: 'Copie o código Pix e pague pelo aplicativo do seu banco.' },
    { key: 'qrcode', name: 'Pix (QR Code)', desc: 'Escaneie o QR Code com o aplicativo do seu banco.' }
  ];

  const MODALITY_ICONS = {
    'in-store': '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    'pickup': '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4h14v12H1z"/><path d="M15 9h4l3 3v4h-7V9z"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>',
    'delivery': '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 9-7 9 7"/><path d="M5 11v10h14V11"/><path d="M9 21v-6h6v6"/></svg>'
  };

  function digits(v) {
    return String(v || '').replace(/\D/g, '');
  }

  function money(value) {
    const v = Number(value || 0);
    return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function todayStr() {
    return toDateStr(new Date());
  }

  function addDays(d, n) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function formatDateBR(dateStr) {
    const d = parseDate(dateStr);
    return d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }

  function formatDateShort(dateStr) {
    const d = parseDate(dateStr);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
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

  const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data && data.error ? data.error : 'Algo deu errado. Tente novamente.';
      throw new Error(msg);
    }
    return data;
  }

  function saveState() {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      Object.assign(state, saved);
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------- API data ---------- */

  async function init() {
    const [settings, modalities, units] = await Promise.all([
      api('/api/settings'),
      api('/api/modalities'),
      api('/api/units')
    ]);
    state.settings = settings || {};
    state.modalities = modalities || [];
    state.units = units || [];
    const companyName = state.settings.company_name || 'Empresa';
    const logoUrl = state.settings.logo_url || '/assets/logo.png';
    $('brandName').textContent = companyName;
    document.title = `${companyName} — Agendamento Online`;
    const watermark = $('brandWatermark');
    if (watermark) watermark.textContent = companyName.split(/\s+/)[0].toUpperCase();
    ['brandLogo', 'footerLogo'].forEach((id) => {
      const img = $(id);
      if (img) {
        img.src = logoUrl;
        img.alt = companyName;
      }
    });
    $('footerPhone').textContent = state.settings.phone || '';
    const wa = digits(state.settings.whatsapp || state.settings.phone || '');
    const waLink = $('footerWa');
    if (waLink && wa) waLink.href = 'https://wa.me/' + wa;
    const bookingWa = $('btnWhatsapp');
    if (bookingWa) bookingWa.textContent = `Falar com a ${companyName} pelo WhatsApp`;

    if (state.modality && !state.modalities.some((m) => m.id === state.modality.id)) state.modality = null;
    if (state.unit && !state.units.some((u) => u.id === state.unit.id)) state.unit = null;

    renderProgress();
    renderModalities();
    renderCategoryOptions();
    renderCalendar();
    goToStep(state.currentStep || 1, true);
    bindGlobal();

    /* Por último: aplica a logo/favicon enviados pelo desenvolvedor, se
       houver, sobrepondo os padrões já definidos acima. */
    if (window.loadTenantBranding) window.loadTenantBranding();
  }

  function renderProgress() {
    const wrap = $('progressWrap');
    const list = $('progress');
    list.innerHTML = '';
    for (let i = 1; i <= TOTAL_STEPS; i += 1) {
      const li = document.createElement('li');
      li.dataset.step = i;
      li.innerHTML = `<span class="lbl">${STEP_LABELS[i - 1]}</span><span class="dot-wrap"><span class="dot">${i}</span></span>`;
      list.appendChild(li);
    }
    wrap.hidden = false;
    updateProgress();
  }

  function updateProgress() {
    const items = $('progress').querySelectorAll('li');
    items.forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('done', n < state.currentStep);
      li.classList.toggle('active', n === state.currentStep);
    });
    const fill = $('pageProgressFill');
    if (fill) fill.style.width = ((state.currentStep - 1) / (TOTAL_STEPS - 1) * 100) + '%';
  }

  /* ---------- steps ---------- */

  function goToStep(n, force) {
    if (!force && state.currentStep === n) return;
    if (n < 1 || n > TOTAL_STEPS) return;
    state.currentStep = n;
    saveState();
    document.querySelectorAll('.step').forEach((sec) => {
      sec.hidden = Number(sec.dataset.step) !== n;
    });
    $('successScreen').hidden = true;
    const last = n === TOTAL_STEPS;
    const first = n === 1;
    $('navRow').hidden = false;
    $('navRow').style.display = last ? 'none' : 'flex';
    $('btnBack').hidden = first;
    updateProgress();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function validateStep(n) {
    if (n === 1) {
      if (!state.modality) { alert('Selecione a forma de atendimento.'); return false; }
    }
    if (n === 2) {
      if (state.customer.name.trim().length < 3) { alert('Informe seu nome completo.'); return false; }
      const ph = digits(state.customer.phone);
      if (ph.length < 10) { alert('Informe um telefone válido com DDD.'); return false; }
    }
    if (n === 3) {
      if (state.vehicle.brand.trim().length < 2) { alert('Informe a marca do veículo.'); return false; }
      if (state.vehicle.model.trim().length < 2) { alert('Informe o modelo do veículo.'); return false; }
      if (!/^\d{4}$/.test(state.vehicle.year.trim())) { alert('Informe o ano do veículo.'); return false; }
      if (!validPlate(state.vehicle.plate)) { alert('Informe uma placa válida. Use ABC-1234 ou o padrão Mercosul.'); return false; }
      if (state.vehicle.color.trim().length < 2) { alert('Informe a cor do veículo.'); return false; }
      if (!state.vehicle.category) { alert('Selecione a categoria do veículo.'); return false; }
    }
    if (n === 4) {
      if (state.modality.slug === 'in-store' && !state.unit) { alert('Selecione a unidade de atendimento.'); return false; }
      if (!state.date) { alert('Selecione a data do agendamento.'); return false; }
    }
    if (n === 5) {
      if (!state.services.length) { alert('Selecione ao menos um serviço.'); return false; }
    }
    if (n === 6) {
      if (!state.longService && !state.slot) { alert('Selecione um horário.'); return false; }
    }
    if (n === 7) {
      if (!validateAddressSubmit()) return false;
    }
    if (n === 8) {
      if (!state.paymentMethod) { alert('Selecione a forma de pagamento.'); return false; }
      if (state.paymentMethod === 'card' && !state.cardPaid) {
        alert('Finalize o pagamento com o cartão antes de enviar.');
        return false;
      }
    }
    return true;
  }

  function stepRender(n) {
    if (n === 4) renderCalendar();
    if (n === 5) renderCatalog();
    if (n === 6) renderSlots();
    if (n === 7) renderReview();
    if (n === 8) renderPayment();
  }

  /* ---------- step 1: modalities ---------- */

  function renderModalities() {
    const grid = $('modalityGrid');
    grid.innerHTML = '';
    const firstId = state.modalities.length ? state.modalities[0].id : null;
    state.modalities.forEach((m) => {
      const isFeatured = m.id === firstId;
      const icon = MODALITY_ICONS[m.slug] || '';
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'modality-card' + (isFeatured ? ' featured' : '');
      card.dataset.slug = m.slug;
      card.innerHTML = `
        ${isFeatured ? '<span class="modality-badge">Mais escolhido</span>' : ''}
        <span class="modality-media"><span class="modality-icon">${icon}</span></span>
        <span class="modality-body">
          <span class="modality-name">${m.name}</span>
          <span class="modality-desc">${m.description || ''}</span>
        </span>
      `;
      if (state.modality && state.modality.id === m.id) card.classList.add('selected');
      card.addEventListener('click', () => {
        state.modality = { id: m.id, name: m.name, slug: m.slug, fee: m.fee };
        state.unit = null;
        state.date = null;
        state.services = [];
      state.slot = null;
      state.slotEndDate = null;
      state.slotEndTime = null;
      state.slotDuration = null;
      state.longService = false;
      state.estimatedEnd = null;
      state.address = {};
        state.responsible_name = '';
        state.key_delivery_confirmed = false;
        state.has_water_access = false;
        state.has_power_access = false;
        state.paymentMethod = '';
        state.cardPaid = false;
        saveState();
        grid.querySelectorAll('.modality-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
      });
      grid.appendChild(card);
    });
  }

  /* ---------- step 3: vehicle category ---------- */

  const CATEGORY_META = {
    hatch: { label: 'Hatch' },
    sedan: { label: 'Sedan' },
    suv: { label: 'SUV' },
    pickup: { label: 'Picape' }
  };

  function renderCategoryOptions() {
    const grid = $('categoryGrid');
    grid.innerHTML = '';
    Object.keys(CATEGORY_META).forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-option';
      btn.dataset.key = key;
      btn.textContent = CATEGORY_META[key].label;
      if (state.vehicle.category === key) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        state.vehicle.category = key;
        state.slot = null;
        state.slotEndDate = null;
        state.slotEndTime = null;
        state.slotDuration = null;
        state.longService = false;
        state.estimatedEnd = null;
        slotCache = {};
        saveState();
        grid.querySelectorAll('.category-option').forEach((c) => c.classList.remove('selected'));
        btn.classList.add('selected');
      });
      grid.appendChild(btn);
    });
  }

  /* ---------- step 4: units + calendar ---------- */

  function renderUnits() {
    const block = $('unitBlock');
    const grid = $('unitGrid');
    grid.innerHTML = '';
    if (state.modality && state.modality.slug !== 'in-store') {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    state.units.forEach((u) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'unit-card';
      card.innerHTML = `
        <span class="unit-name">${u.name}</span>
        <span class="unit-address">${u.address || ''}</span>
        <span class="unit-hours">${u.opening_time} às ${u.closing_time} · ${u.phone || ''}</span>
      `;
      if (state.unit && state.unit.id === u.id) card.classList.add('selected');
      card.addEventListener('click', () => {
        state.unit = u;
        state.date = null;
        state.services = [];
        state.slot = null;
        state.slotEndDate = null;
        state.slotEndTime = null;
        state.slotDuration = null;
        saveState();
        renderCalendar();
      });
      grid.appendChild(card);
    });
  }

  const calView = { month: null };

  function renderCalendar() {
    renderUnits();
    const today = new Date();
    if (!calView.month) calView.month = new Date(today.getFullYear(), today.getMonth(), 1);
    if (state.date) {
      const d = parseDate(state.date);
      calView.month = new Date(d.getFullYear(), d.getMonth(), 1);
    }
    const monthStart = calView.month;
    const year = monthStart.getFullYear();
    const month = monthStart.getMonth();
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const working = (state.unit && state.unit.working_days && state.unit.working_days.length)
      ? state.unit.working_days
      : (state.settings.working_days && state.settings.working_days.length ? state.settings.working_days : [1, 2, 3, 4, 5, 6]);

    $('dateSubtitle').textContent = state.modality && state.modality.slug === 'in-store'
      ? 'Escolha a unidade e depois o dia disponível.'
      : 'Escolha o dia disponível.';

    const cal = $('calendar');
    cal.innerHTML = `
      <div class="cal-head">
        <button type="button" class="cal-nav" data-nav="-1" aria-label="Mês anterior">‹</button>
        <span class="cal-title">${monthStart.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}</span>
        <button type="button" class="cal-nav" data-nav="1" aria-label="Próximo mês">›</button>
      </div>
      <div class="cal-week">
        ${WEEKDAY_LABELS.map((w) => `<span class="cal-wd">${w}</span>`).join('')}
      </div>
      <div class="cal-grid"></div>
    `;
    const gridEl = cal.querySelector('.cal-grid');
    for (let i = 0; i < firstDow; i += 1) gridEl.appendChild(document.createElement('span'));
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateStr = toDateStr(new Date(year, month, day));
      const isWorking = working.includes(new Date(year, month, day).getDay());
      const isPast = dateStr < todayStr();
      const enabled = isWorking && !isPast;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day' + (enabled ? '' : ' disabled');
      if (state.date === dateStr) btn.classList.add('selected');
      btn.textContent = String(day);
      if (enabled) {
        btn.addEventListener('click', () => {
          state.date = dateStr;
          state.services = [];
          state.slot = null;
          state.slotEndDate = null;
          state.slotEndTime = null;
          state.slotDuration = null;
          state.longService = false;
          state.estimatedEnd = null;
          saveState();
          gridEl.querySelectorAll('.cal-day').forEach((c) => c.classList.remove('selected'));
          btn.classList.add('selected');
        });
      }
      gridEl.appendChild(btn);
    }
    cal.querySelector('[data-nav="1"]').addEventListener('click', () => {
      calView.month = new Date(year, month + 1, 1);
      renderCalendar();
    });
    cal.querySelector('[data-nav="-1"]').addEventListener('click', () => {
      const minMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const candidate = new Date(year, month - 1, 1);
      if (candidate < minMonth) return;
      calView.month = candidate;
      renderCalendar();
    });
  }

  /* ---------- step 5: catalog ---------- */

  const catalogCache = {};

  function servicePrice(service) {
    if (service.price_type === 'fixed') return { value: service.fixed_price, estimate: false };
    if (service.price_type === 'starting') return { value: service.starting_price, estimate: true };
    return { value: service['price_' + state.vehicle.category] || 0, estimate: false };
  }

  function liveServicePrice(s) {
    if (s.price_type === 'category') {
      const cat = catalogCache[state.modality.id];
      const found = cat && cat.flat().find((x) => x.id === s.id);
      if (found) return servicePrice(found);
      return { value: s.price || 0, estimate: false };
    }
    return { value: s.price || 0, estimate: !!s.estimate };
  }

  function servicesTotals() {
    let value = 0;
    let duration = 0;
    let estimate = false;
    state.services.forEach((s) => {
      const p = liveServicePrice(s);
      value += p.value;
      duration += Number(s.duration_minutes || 0) + (state.vehicle.category === 'pickup' ? Number(s.pickup_extra_minutes || 0) : 0);
      if (p.estimate) estimate = true;
    });
    return { value, duration, estimate };
  }

  async function renderCatalog() {
    const el = $('catalog');
    const subtitle = $('catalogSubtitle');
    el.innerHTML = '<div class="loading">Carregando serviços...</div>';
    subtitle.textContent = state.modality.name + ' · ' + state.vehicle.category.toUpperCase();
    try {
      const data = await api('/api/catalog?modality_id=' + state.modality.id);
      catalogCache[state.modality.id] = data.catalog.map((c) => c.services).flat();
      const sections = data.catalog.filter((c) => c.services.length > 0);
      subtitle.textContent = `${state.modality.name} · ${CATEGORY_META[state.vehicle.category].label}`;
      el.innerHTML = '';
      sections.forEach((cat) => {
        const section = document.createElement('div');
        section.className = 'catalog-section';
        section.innerHTML = `<h3 class="catalog-cat">${cat.name}</h3>`;
        const list = document.createElement('div');
        list.className = 'service-grid';
        cat.services.forEach((s) => {
          const p = servicePrice(s);
          const card = document.createElement('button');
          card.type = 'button';
          card.className = 'service-card';
          card.dataset.id = s.id;
          card.innerHTML = `
            <span class="service-name">${s.name}</span>
            ${s.description ? `<span class="service-desc">${s.description}</span>` : ''}
            ${s.package_items && s.package_items.length ? `<span class="service-items">${s.package_items.slice(0, 3).join(' · ')}${s.package_items.length > 3 ? ' · +' + (s.package_items.length - 3) + ' itens' : ''}</span>` : ''}
            <span class="service-foot">
              <span class="service-duration">${fmtDur(s.duration_minutes)}${s.pickup_extra_minutes ? ' · picape +' + fmtDur(s.pickup_extra_minutes) : ''}</span>
              <span class="service-price">${p.estimate ? 'a partir de ' : ''}${money(p.value)}</span>
            </span>
          `;
          if (state.services.some((x) => x.id === s.id)) card.classList.add('selected');
          card.addEventListener('click', () => {
            const idx = state.services.findIndex((x) => x.id === s.id);
            if (idx >= 0) {
              state.services.splice(idx, 1);
              card.classList.remove('selected');
            } else {
              state.services.push({
                id: s.id,
                name: s.name,
                price_type: s.price_type,
                price: p.value,
                estimate: p.estimate,
                duration_minutes: s.duration_minutes,
                pickup_extra_minutes: s.pickup_extra_minutes || 0,
                category_name: cat.name,
                description: s.description
              });
              card.classList.add('selected');
            }
            state.slot = null;
            state.slotEndDate = null;
            state.slotEndTime = null;
            state.slotDuration = null;
            saveState();
          });
          list.appendChild(card);
        });
        section.appendChild(list);
        el.appendChild(section);
      });
    } catch (err) {
      el.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
  }

  /* ---------- step 6: slots ---------- */

  let slotCache = {};

  async function renderSlots() {
    const grid = $('slotsGrid');
    const loading = $('slotLoading');
    const subtitle = $('slotSubtitle');
    const serviceIds = state.services.map((s) => s.id);
    subtitle.textContent = `${state.services.map((s) => s.name).join(' + ')} · ${formatDateBR(state.date)}`;
    grid.innerHTML = '';
    const key = `${state.modality.id}|${state.unit ? state.unit.id : ''}|${serviceIds.slice().sort((a, b) => a - b).join(',')}|${state.date}|${state.vehicle.category}`;
    if (!slotCache[key]) {
      loading.hidden = false;
      try {
        const params = new URLSearchParams({
          modality_id: state.modality.id,
          service_ids: serviceIds.join(','),
          date: state.date,
          vehicle_category: state.vehicle.category
        });
        if (state.unit) params.set('unit_id', state.unit.id);
        const data = await api('/api/availability?' + params.toString());
        slotCache[key] = data;
      } catch (err) {
        loading.hidden = true;
        grid.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
        return;
      }
      loading.hidden = true;
    }
    const data = slotCache[key];
    const longNote = $('slotLongNote');
    state.longService = false;
    state.estimatedEnd = null;
    if (longNote) longNote.hidden = true;
    if (!data.working || data.full_day_blocked) {
      grid.innerHTML = `<div class="error-box">Não há horários disponíveis nesta data.</div>`;
      return;
    }
    if (data.is_long_service) {
      state.longService = true;
      state.slot = null;
      state.slotEndDate = null;
      state.slotEndTime = null;
      state.slotDuration = data.duration_minutes || null;
      state.estimatedEnd = data.estimated_end_date && data.estimated_end_time
        ? { date: data.estimated_end_date, time: data.estimated_end_time }
        : null;
      saveState();
      grid.innerHTML = '';
      const pickupExtra = data.vehicle_category === 'pickup' ? ' (inclui acréscimo para picape)' : '';
      const deliveryWord = state.modality.slug === 'in-store' ? 'atendimento' : 'entrega';
      longNote.innerHTML = `
        <p class="slot-duration-note">Duração estimada: <strong>${fmtDur(data.duration_minutes)}</strong>${pickupExtra}</p>
        <p class="slot-long-message">Este serviço possui duração estimada de <strong>${fmtDur(data.duration_minutes)}</strong>. Por ser um serviço de longa duração, não é necessário escolher um horário. A empresa entrará em contato para confirmar o horário de ${deliveryWord} do veículo.</p>`;
      longNote.hidden = false;
      return;
    }
    const durNote = data.duration_minutes ? `<p class="slot-duration-note">Duração estimada: <strong>${fmtDur(data.duration_minutes)}</strong>${data.vehicle_category === 'pickup' ? ' (inclui acréscimo para picape)' : ''}</p>` : '';
    grid.innerHTML = durNote;
    data.slots.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-btn';
      const available = s.status === 'available';
      if (!available) btn.classList.add('disabled');
      btn.dataset.time = s.time;
      let label = s.time;
      let fullLabel = s.time;
      if (s.end_time) {
        if (s.end_date && s.end_date !== state.date) {
          const endShort = parseDate(s.end_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
          label = `${s.time} até ${endShort} às ${s.end_time}`;
          fullLabel = `${s.time} até ${formatDateShort(s.end_date)} às ${s.end_time}`;
        } else {
          label = `${s.time} às ${s.end_time}`;
          fullLabel = label;
        }
      }
      btn.textContent = label;
      btn.title = s.reason || fullLabel;
      if (state.slot === s.time && available) btn.classList.add('selected');
      if (available) {
        btn.addEventListener('click', () => {
          state.slot = s.time;
          state.slotEndDate = s.end_date || state.date;
          state.slotEndTime = s.end_time || null;
          state.slotDuration = data.duration_minutes || null;
          saveState();
          grid.querySelectorAll('.slot-btn').forEach((c) => c.classList.remove('selected'));
          btn.classList.add('selected');
        });
      }
      grid.appendChild(btn);
    });
    if (data.slots.length === 0) {
      grid.innerHTML = `<div class="error-box">Nenhum horário disponível neste dia.</div>`;
    }
  }

  /* ---------- step 7: review + address ---------- */

  function renderAddress() {
    const block = $('addressBlock');
    block.innerHTML = '';
    if (!state.modality) return;
    const slug = state.modality.slug;
    const isPickup = slug === 'pickup';
    const isDelivery = slug === 'delivery';
    block.hidden = !(isPickup || isDelivery);
    if (!(isPickup || isDelivery)) return;

    const title = document.createElement('h3');
    title.className = 'review-section-title';
    title.textContent = isPickup ? 'Local de retirada e entrega' : 'Endereço do serviço (Delivery)';
    block.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'address-grid';
    const fields = [
      { id: 'addrStreet', label: 'Rua', key: 'address_street' },
      { id: 'addrNumber', label: 'Número', key: 'address_number' },
      { id: 'addrComplement', label: 'Complemento (opcional)', key: 'address_complement' },
      { id: 'addrNeighborhood', label: 'Bairro', key: 'address_neighborhood' },
      { id: 'addrCity', label: 'Cidade', key: 'address_city' },
      { id: 'addrState', label: 'UF', key: 'address_state', max: 2 },
      { id: 'addrZipcode', label: 'CEP', key: 'address_zipcode' },
      { id: 'addrReference', label: 'Ponto de referência (opcional)', key: 'address_reference' }
    ];
    fields.forEach((f) => {
      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('label');
      label.setAttribute('for', f.id);
      label.textContent = f.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.id = f.id;
      if (f.max) input.maxLength = f.max;
      input.value = state.address[f.key] || '';
      if (f.key === 'address_zipcode') input.placeholder = '00000-000';
      if (f.key === 'address_state') input.placeholder = 'MG';
      input.addEventListener('input', () => {
        state.address[f.key] = input.value;
        if (f.key === 'address_zipcode') input.value = maskCep(input.value);
        saveState();
      });
      field.appendChild(label);
      field.appendChild(input);
      grid.appendChild(field);
    });
    block.appendChild(grid);

    const responsible = document.createElement('div');
    responsible.className = 'field';
    responsible.innerHTML = `<label for="responsibleName">Responsável pela entrega da chave</label>`;
    const respInput = document.createElement('input');
    respInput.type = 'text';
    respInput.id = 'responsibleName';
    respInput.value = state.responsible_name;
    respInput.addEventListener('input', () => { state.responsible_name = respInput.value; saveState(); });
    responsible.appendChild(respInput);
    block.appendChild(responsible);

    if (isPickup) {
      const chk = document.createElement('label');
      chk.className = 'checkbox';
      chk.innerHTML = `<input type="checkbox" id="keyCheckbox" ${state.key_delivery_confirmed ? 'checked' : ''} />
        <span>Confirmo que a chave do veículo será entregue ao responsável informado no momento da retirada.</span>`;
      chk.querySelector('input').addEventListener('change', () => { state.key_delivery_confirmed = chk.querySelector('input').checked; saveState(); });
      block.appendChild(chk);
    }
    if (isDelivery) {
      const chk1 = document.createElement('label');
      chk1.className = 'checkbox';
      chk1.innerHTML = `<input type="checkbox" id="waterCheckbox" ${state.has_water_access ? 'checked' : ''} />
        <span>Confirmo que há ponto de água disponível e em funcionamento no local do serviço.</span>`;
      chk1.querySelector('input').addEventListener('change', () => { state.has_water_access = chk1.querySelector('input').checked; saveState(); });
      block.appendChild(chk1);

      const chk2 = document.createElement('label');
      chk2.className = 'checkbox';
      chk2.innerHTML = `<input type="checkbox" id="powerCheckbox" ${state.has_power_access ? 'checked' : ''} />
        <span>Confirmo que há tomada elétrica em funcionamento no local do serviço.</span>`;
      chk2.querySelector('input').addEventListener('change', () => { state.has_power_access = chk2.querySelector('input').checked; saveState(); });
      block.appendChild(chk2);
    }
  }

  function renderReview() {
    renderAddress();
    const card = $('reviewCard');
    const totals = servicesTotals();
    const fee = Number(state.modality.fee || 0);
    const total = totals.value + fee;
    const duration = state.slotDuration || totals.duration;

    const servicesLines = state.services.map((s) => {
      const p = liveServicePrice(s);
      return `<div class="review-line"><span>${escapeHtml(s.name)}</span><strong>${p.estimate ? 'a partir de ' : ''}${money(p.value)}</strong></div>`;
    }).join('');

    let unitLine = '';
    if (state.modality.slug === 'in-store' && state.unit) {
      unitLine = `<div class="review-line"><span>Unidade</span><strong>${state.unit.name}</strong></div>`;
    }
    let addressLine = '';
    if (state.modality.slug !== 'in-store') {
      const a = state.address;
      if (a.address_street) {
        addressLine = `<div class="review-line"><span>Endereço</span><strong>${a.address_street}, ${a.address_number || ''}${a.address_neighborhood ? ' — ' + a.address_neighborhood : ''}${a.address_city ? ', ' + a.address_city + '/' + a.address_state : ''}</strong></div>`;
      }
    }

    card.innerHTML = `
      <h3 class="review-section-title">Resumo do agendamento</h3>
      <div class="review-line"><span>Forma de atendimento</span><strong>${state.modality.name}</strong></div>
      ${unitLine}
      <div class="review-line"><span>Veículo</span><strong>${state.vehicle.brand} ${state.vehicle.model}${state.vehicle.year ? ' · ' + state.vehicle.year : ''} · ${CATEGORY_META[state.vehicle.category].label}</strong></div>
      <div class="review-line"><span>Data</span><strong>${formatDateShort(state.date)}</strong></div>
      <h3 class="review-section-title">Serviços selecionados</h3>
      ${servicesLines}
      ${state.longService
        ? `<div class="review-line"><span>Início</span><strong>${formatDateShort(state.date)} · horário a confirmar</strong></div>`
        : `<div class="review-line"><span>Início</span><strong>${formatDateShort(state.date)} às ${state.slot}</strong></div>`}
      ${state.longService
        ? `<div class="review-line"><span>Previsão de término</span><strong>${state.estimatedEnd ? formatDateShort(state.estimatedEnd.date) + ' às ' + state.estimatedEnd.time : 'A confirmar'}</strong></div>`
        : `<div class="review-line"><span>Previsão de término</span><strong>${state.slotEndTime ? (state.slotEndDate !== state.date ? formatDateShort(state.slotEndDate) + ' às ' + state.slotEndTime : state.slotEndTime) : '—'}</strong></div>`}
      <div class="review-line"><span>Total de horas de trabalho</span><strong>${fmtDur(duration)}</strong></div>
      ${addressLine}
      <div class="review-total">
        <div class="review-line"><span>Serviços (${state.services.length})</span><strong>${totals.estimate ? 'a partir de ' : ''}${money(totals.value)}</strong></div>
        <div class="review-line"><span>Taxa (${state.modality.name})</span><strong>${fee > 0 ? money(fee) : 'Grátis'}</strong></div>
        <div class="review-line total"><span>Total estimado</span><strong>${money(total)}</strong></div>
      </div>
      ${totals.estimate ? '<p class="review-note">Valor a partir de: o preço final será confirmado após avaliação do veículo.</p>' : ''}
    `;
  }

  /* ---------- step 8: payment ---------- */

  function renderPayment() {
    const grid = $('paymentGrid');
    grid.innerHTML = '';
    const enabled = state.settings.payment_methods_enabled;
    const available = PAYMENT_METHODS.filter(
      (p) => !Array.isArray(enabled) || enabled.includes(p.key)
    );
    if (state.paymentMethod && !available.some((p) => p.key === state.paymentMethod)) {
      state.paymentMethod = '';
      state.cardPaid = false;
      saveState();
    }
    available.forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'payment-card';
      btn.dataset.key = p.key;
      btn.innerHTML = `<span class="payment-name">${p.name}</span><span class="payment-desc">${p.desc}</span>`;
      if (state.paymentMethod === p.key) btn.classList.add('selected');
      btn.addEventListener('click', () => {
        state.paymentMethod = p.key;
        state.cardPaid = false;
        saveState();
        grid.querySelectorAll('.payment-card').forEach((c) => c.classList.remove('selected'));
        btn.classList.add('selected');
        renderPaymentDetail();
      });
      grid.appendChild(btn);
    });
    renderPaymentDetail();
  }

  function paymentTotal() {
    const totals = servicesTotals();
    const fee = Number(state.modality.fee || 0);
    return totals.value + fee;
  }

  function renderPaymentDetail() {
    const detail = $('paymentDetail');
    detail.innerHTML = '';
    detail.hidden = !state.paymentMethod;
    if (!state.paymentMethod) return;
    const method = state.paymentMethod;
    const total = paymentTotal();

    if (method === 'local') {
      detail.innerHTML = `<p class="payment-note">Você pagará no local, no momento da entrega do veículo. Total estimado: <strong>${money(total)}</strong>.</p>`;
    } else if (method === 'card') {
      if (state.cardPaid) {
        detail.innerHTML = `
          <div class="payment-success">
            <div class="success-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#27c469" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </div>
            <strong>Pagamento aprovado!</strong>
            <p>Valor de ${money(total)} autorizado. Você já pode enviar a solicitação.</p>
          </div>`;
        return;
      }
      detail.innerHTML = `
        <div class="card-form">
          <h3 class="review-section-title">Dados do cartão</h3>
          <div class="field"><label for="cardNumber">Número do cartão</label>
            <input type="text" id="cardNumber" inputmode="numeric" maxlength="19" autocomplete="off" placeholder="0000 0000 0000 0000" /></div>
          <div class="field"><label for="cardName">Nome impresso no cartão</label>
            <input type="text" id="cardName" autocomplete="off" placeholder="Como está no cartão" /></div>
          <div class="field-row">
            <div class="field"><label for="cardExp">Validade</label>
              <input type="text" id="cardExp" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="MM/AA" /></div>
            <div class="field"><label for="cardCvv">CVV</label>
              <input type="text" id="cardCvv" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="123" /></div>
          </div>
          <div class="card-total">Total: <strong>${money(total)}</strong></div>
          <button type="button" class="btn btn-primary btn-lg" id="cardPayBtn">Pagar agora</button>
        </div>`;
      const num = $('cardNumber');
      const name = $('cardName');
      const exp = $('cardExp');
      const cvv = $('cardCvv');
      num.addEventListener('input', () => { maskCardNumber(num); });
      exp.addEventListener('input', () => { maskCardExp(exp); });
      cvv.addEventListener('input', () => { cvv.value = digits(cvv.value).slice(0, 4); });
      $('cardPayBtn').addEventListener('click', () => {
        if (digits(num.value).length < 15) { alert('Número do cartão inválido.'); return; }
        if (name.value.trim().length < 3) { alert('Informe o nome impresso no cartão.'); return; }
        if (!/^\d{2}\/\d{2}$/.test(exp.value)) { alert('Validade inválida. Use o formato MM/AA.'); return; }
        if (digits(cvv.value).length < 3) { alert('CVV inválido.'); return; }
        const btn = $('cardPayBtn');
        btn.disabled = true;
        btn.textContent = 'Processando pagamento...';
        setTimeout(() => {
          state.cardPaid = true;
          saveState();
          renderPaymentDetail();
        }, 1200);
      });
    } else if (method === 'pix') {
      const effectiveCode = (state.settings.pix_code || '').trim() || buildPixCode(total);
      const holder = (state.settings.pix_company_name || '').trim();
      detail.innerHTML = `
        <div class="pix-box">
          <p class="payment-note">Copie o código abaixo e pague pelo aplicativo do seu banco (Pix). Total: <strong>${money(total)}</strong>.</p>
          ${holder ? `<p class="payment-note">Recebedor: <strong>${escapeHtml(holder)}</strong></p>` : ''}
          ${pixCopyRowHtml(effectiveCode)}
        </div>`;
      bindPixCopy();
    } else if (method === 'qrcode') {
      const realCode = (state.settings.pix_code || '').trim();
      const code = realCode || buildPixCode(total);
      const holder = (state.settings.pix_company_name || '').trim();
      const realQr = state.settings.pix_qr_url;
      detail.innerHTML = `
        <div class="qr-box">
          <p class="payment-note">Escaneie o QR Code abaixo com o aplicativo do seu banco (Pix). Total: <strong>${money(total)}</strong>.</p>
          <div class="qr-image">${realQr
            ? `<img src="${escapeHtml(realQr)}" alt="QR Code Pix" width="240" height="240" />`
            : fakeQrSvg(code)}</div>
          ${holder ? `<p class="payment-note">Recebedor: <strong>${escapeHtml(holder)}</strong></p>` : ''}
          ${realCode ? pixCopyRowHtml(realCode) : ''}
          ${realQr ? '' : '<p class="payment-note muted">QR Code ilustrativo (fictício) — nenhuma cobrança real é gerada.</p>'}
        </div>`;
      bindPixCopy();
    }
  }

  function pixCopyRowHtml(code) {
    return `
      <div class="pix-code-wrap">
        <input type="text" class="pix-code-input" id="pixCodeInput" value="${escapeHtml(code)}" readonly />
        <button type="button" class="btn btn-primary" id="pixCopyBtn">Copiar código</button>
      </div>`;
  }

  function bindPixCopy() {
    const copyBtn = $('pixCopyBtn');
    if (!copyBtn) return;
    copyBtn.addEventListener('click', () => {
      const input = $('pixCodeInput');
      input.select();
      input.setSelectionRange(0, input.value.length);
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(() => {});
      copyBtn.textContent = 'Código copiado!';
      setTimeout(() => { copyBtn.textContent = 'Copiar código'; }, 2000);
    });
  }

  function maskCardNumber(input) {
    const v = digits(input.value).slice(0, 16);
    const parts = [];
    for (let i = 0; i < v.length; i += 4) parts.push(v.slice(i, i + 4));
    input.value = parts.join(' ');
  }

  function maskCardExp(input) {
    let v = digits(input.value).slice(0, 4);
    if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2);
    input.value = v;
  }

  function pixField(id, value) {
    const s = String(value);
    return `${id}${String(s.length).padStart(2, '0')}${s}`;
  }

  function crc16(text) {
    let crc = 0xffff;
    for (let i = 0; i < text.length; i += 1) {
      crc ^= text.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j += 1) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  function buildPixCode(total) {
    const s = state.settings;
    const phone = digits(s.phone || s.whatsapp || '') || '34999999999';
    const name = (s.pix_company_name || s.company_name || 'PAPICORE')
      .replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 25) || 'PAPICORE';
    const city = 'UBERLANDIA';
    const amt = (Number(total) || 0).toFixed(2);
    const txid = 'PAPICORE' + String(Date.now()).slice(-4);
    const sub = pixField('00', 'BR.GOV.BCB.PIX') + pixField('01', phone);
    let payload =
      '000201' +
      pixField('26', sub) +
      pixField('52', '0000') +
      pixField('53', '986') +
      pixField('54', amt) +
      pixField('58', 'BR') +
      pixField('59', name) +
      pixField('60', city) +
      pixField('62', pixField('05', txid)) +
      '6304';
    return payload + crc16(payload);
  }

  function fakeQrSvg(text) {
    const size = 25;
    let seed = 2166136261;
    for (let i = 0; i < text.length; i += 1) seed = ((seed ^ text.charCodeAt(i)) * 16777619) >>> 0;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const g = [];
    for (let r = 0; r < size; r += 1) { g.push([]); for (let c = 0; c < size; c += 1) g[r].push(rand() < 0.5); }
    const finder = (r0, c0) => {
      for (let r = 0; r < 7; r += 1) for (let c = 0; c < 7; c += 1) {
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        g[r0 + r][c0 + c] = border || core;
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);
    for (let i = 8; i < size - 8; i += 1) { g[6][i] = i % 2 === 0; g[i][6] = i % 2 === 0; }
    const cell = 12;
    let rects = '';
    for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) {
      if (g[r][c]) rects += `<rect x="${c * cell}" y="${r * cell}" width="${cell}" height="${cell}"/>`;
    }
    return `<svg viewBox="0 0 ${size * cell} ${size * cell}" role="img" aria-label="QR Code Pix (ilustrativo)">${rects}</svg>`;
  }

  /* ---------- submit ---------- */

  function validateAddressSubmit() {
    const slug = state.modality.slug;
    if (slug === 'in-store') return true;
    const a = state.address;
    const required = ['address_street', 'address_number', 'address_neighborhood', 'address_city', 'address_state', 'address_zipcode'];
    for (const k of required) {
      if (!a[k] || !String(a[k]).trim()) {
        alert('Informe o endereço completo para esta modalidade.');
        return false;
      }
    }
    if (state.responsible_name.trim().length < 3) {
      alert('Informe o responsável pela entrega da chave.');
      return false;
    }
    if (slug === 'pickup' && !state.key_delivery_confirmed) {
      alert('Confirme que a chave será entregue ao responsável.');
      return false;
    }
    if (slug === 'delivery' && !state.has_water_access) {
      alert('Confirme que há ponto de água disponível no local.');
      return false;
    }
    if (slug === 'delivery' && !state.has_power_access) {
      alert('Confirme que há tomada elétrica em funcionamento no local.');
      return false;
    }
    return true;
  }

  function buildPayload() {
    const a = state.address;
    return {
      modality_id: state.modality.id,
      unit_id: state.unit ? state.unit.id : null,
      service_ids: state.services.map((s) => s.id),
      customer_name: state.customer.name.trim(),
      customer_phone: state.customer.phone,
      customer_email: state.customer.email.trim() || null,
      customer_cpf: state.customer.cpf || null,
      vehicle_brand: state.vehicle.brand.trim(),
      vehicle_model: state.vehicle.model.trim(),
      vehicle_year: state.vehicle.year.trim() || null,
      vehicle_plate: state.vehicle.plate || null,
      vehicle_color: state.vehicle.color.trim() || null,
      vehicle_category: state.vehicle.category,
      appointment_date: state.date,
      start_time: state.longService ? null : state.slot,
      address_zipcode: a.address_zipcode || null,
      address_street: a.address_street || null,
      address_number: a.address_number || null,
      address_complement: a.address_complement || null,
      address_neighborhood: a.address_neighborhood || null,
      address_city: a.address_city || null,
      address_state: a.address_state || null,
      address_reference: a.address_reference || null,
      responsible_name: state.responsible_name.trim() || null,
      responsible_phone: state.customer.phone,
      has_water_access: state.has_water_access,
      has_power_access: state.has_power_access,
      key_delivery_confirmed: state.key_delivery_confirmed,
      payment_method: state.paymentMethod || null,
      customer_notes: state.customer_notes.trim() || null
    };
  }

  async function submitBooking() {
    if (!validateAddressSubmit()) return;
    const btn = $('submitBtn');
    btn.disabled = true;
    btn.textContent = 'Enviando...';
    try {
      const appointment = await api('/api/appointments', {
        method: 'POST',
        body: JSON.stringify(buildPayload())
      });
      showSuccess(appointment);
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enviar solicitação de agendamento';
    }
  }

  function showSuccess(appointment) {
    $('bookingForm').hidden = true;
    $('navRow').hidden = true;
    $('progressWrap').hidden = true;
    $('pageProgress').hidden = true;
    $('successScreen').hidden = false;
    $('successCode').textContent = appointment.appointment_code || '';
    const msg = state.settings.confirmation_message || 'Nossa equipe analisará a disponibilidade e entrará em contato para confirmar.';
    $('successMsg').textContent = msg;
    const phone = digits(state.settings.whatsapp || state.settings.phone || '');
    const companyName = state.settings.company_name || 'empresa';
    const text = encodeURIComponent(`Olá! Acabei de enviar a solicitação de agendamento ${appointment.appointment_code || ''} pela ${companyName}.`);
    const link = $('btnWhatsapp');
    if (phone) {
      link.href = `https://wa.me/${phone}?text=${text}`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
    sessionStorage.removeItem(STORAGE_KEY);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- masks ---------- */

  function maskPhone(input) {
    let v = digits(input.value);
    if (v.length > 11) v = v.slice(0, 11);
    if (v.length > 6) v = `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
    else if (v.length > 2) v = `(${v.slice(0, 2)}) ${v.slice(2)}`;
    else if (v.length > 0) v = `(${v}`;
    input.value = v;
  }

  function maskCep(input) {
    let v = digits(input.value);
    if (v.length > 8) v = v.slice(0, 8);
    if (v.length > 5) v = `${v.slice(0, 5)}-${v.slice(5)}`;
    input.value = v;
  }

  function maskPlate(input) {
    let v = String(input.value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
    if (v.length > 3) v = v.slice(0, 3) + '-' + v.slice(3);
    input.value = v;
  }

  function validPlate(v) {
    const p = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (p.length !== 7) return false;
    return /^[A-Z]{3}[0-9]{4}$/.test(p) || /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p);
  }

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- global events ---------- */

  function bindGlobal() {
    $('btnNext').addEventListener('click', () => {
      if (!validateStep(state.currentStep)) return;
      goToStep(state.currentStep + 1);
      stepRender(state.currentStep);
    });
    $('btnBack').addEventListener('click', () => {
      const n = state.currentStep - 1;
      goToStep(n, true);
      stepRender(n);
    });
    document.querySelectorAll('[data-action="back"]').forEach((b) => {
      b.addEventListener('click', () => {
        const n = state.currentStep - 1;
        goToStep(n, true);
        stepRender(n);
      });
    });
    $('bookingForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!validateStep(state.currentStep)) return;
      submitBooking();
    });
    $('btnHome').addEventListener('click', () => {
      sessionStorage.removeItem(STORAGE_KEY);
      location.reload();
    });

    document.querySelectorAll('.site-header .brand').forEach((b) => {
      b.addEventListener('click', () => {
        goToStep(1, true);
        stepRender(1);
      });
    });

    const nameInput = $('customerName');
    nameInput.addEventListener('input', () => { state.customer.name = nameInput.value; saveState(); });

    const phoneInput = $('customerPhone');
    phoneInput.addEventListener('input', () => { maskPhone(phoneInput); state.customer.phone = phoneInput.value; saveState(); });

    const brandInput = $('vehicleBrand');
    brandInput.addEventListener('change', () => { state.vehicle.brand = brandInput.value; saveState(); });

    const modelInput = $('vehicleModel');
    modelInput.addEventListener('input', () => { state.vehicle.model = modelInput.value; saveState(); });

    const yearInput = $('vehicleYear');
    yearInput.addEventListener('input', () => {
      yearInput.value = yearInput.value.replace(/\D/g, '').slice(0, 4);
      state.vehicle.year = yearInput.value;
      saveState();
    });

    const plateInput = $('vehiclePlate');
    plateInput.addEventListener('input', () => { maskPlate(plateInput); state.vehicle.plate = plateInput.value; saveState(); });

    const colorInput = $('vehicleColor');
    colorInput.addEventListener('input', () => { state.vehicle.color = colorInput.value; saveState(); });

    const notesInput = $('customerNotes');
    notesInput.addEventListener('input', () => { state.customer_notes = notesInput.value; saveState(); });
  }

  function restoreFields() {
    const nameInput = $('customerName');
    const phoneInput = $('customerPhone');
    const brandInput = $('vehicleBrand');
    const modelInput = $('vehicleModel');
    const yearInput = $('vehicleYear');
    const plateInput = $('vehiclePlate');
    const colorInput = $('vehicleColor');
    const notesInput = $('customerNotes');
    nameInput.value = state.customer.name;
    phoneInput.value = state.customer.phone;
    brandInput.value = state.vehicle.brand;
    modelInput.value = state.vehicle.model;
    yearInput.value = state.vehicle.year;
    plateInput.value = state.vehicle.plate;
    colorInput.value = state.vehicle.color;
    notesInput.value = state.customer_notes;
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadState();
    restoreFields();
    init();
  });
})();
