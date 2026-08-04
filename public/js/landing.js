(() => {
  'use strict';

  const $ = (s, ctx) => (ctx || document).querySelector(s);
  const $$ = (s, ctx) => Array.from((ctx || document).querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DEFAULT_WHATSAPP_MESSAGE = 'Olá! Conheci o PapiCore pelo site e gostaria de saber mais sobre o sistema.';
  const FALLBACK_WHATSAPP = '5521964465949';

  /* ---------- Rolagem suave / animação de entrada das seções ---------- */

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initReveal() {
    if (prefersReducedMotion) return;
    const targets = $$('.reveal');
    if (!('IntersectionObserver' in window) || !targets.length) return;

    /* Só esconde o conteúdo depois de confirmar que o navegador vai
       revelá-lo — nunca antes. E mesmo com o observer ativo, uma rede de
       segurança marca tudo como visível após um tempo curto: ferramentas de
       captura de tela/crawlers que não rolam a página de verdade (e
       screenshots "full page", que renderizam a altura toda sem disparar
       scroll) nunca podem deixar a página com conteúdo permanentemente
       invisível — é uma landing page comercial, não pode "sumir". */
    document.documentElement.classList.add('js-anim');

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    targets.forEach((t) => observer.observe(t));

    setTimeout(() => targets.forEach((t) => t.classList.add('is-visible')), 1800);
  }

  /* ---------- Menu mobile ---------- */

  function initMobileNav() {
    const toggle = $('#navToggle');
    const nav = $('#primaryNav');
    const backdrop = $('#navBackdrop');
    if (!toggle || !nav) return;

    function closeNav() {
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
      backdrop.hidden = true;
    }
    function openNav() {
      toggle.setAttribute('aria-expanded', 'true');
      nav.classList.add('is-open');
      backdrop.hidden = false;
    }

    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      if (isOpen) closeNav(); else openNav();
    });
    backdrop.addEventListener('click', closeNav);
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeNav));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') closeNav();
    });
  }

  /* ---------- FAQ: mantém só um item aberto por vez ---------- */

  function initFaqAccordion() {
    const items = $$('.l-faq-item');
    items.forEach((item) => {
      item.addEventListener('toggle', () => {
        if (!item.open) return;
        items.forEach((other) => { if (other !== item) other.open = false; });
      });
    });
  }

  /* ---------- Abas de demonstração ---------- */

  function initDemoTabs() {
    const tabs = $$('.l-tab');
    const panels = $$('.l-tabpanel');
    if (!tabs.length) return;

    function activate(tab) {
      tabs.forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
        t.tabIndex = active ? 0 : -1;
      });
      panels.forEach((p) => { p.hidden = p.id !== `panel-${tab.dataset.tab}`; });
    }

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab));
      tab.addEventListener('keydown', (e) => {
        let target = null;
        if (e.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
        else if (e.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') target = tabs[0];
        else if (e.key === 'End') target = tabs[tabs.length - 1];
        if (target) { e.preventDefault(); target.focus(); activate(target); }
      });
    });
  }

  /* ---------- Vídeo demonstrativo ---------- */

  function detectEmbedUrl(url) {
    const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{6,})/);
    if (yt) return { type: 'iframe', src: `https://www.youtube.com/embed/${yt[1]}?autoplay=1&rel=0` };
    const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vimeo) return { type: 'iframe', src: `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1` };
    return { type: 'video', src: url };
  }

  function initVideo(videoUrlRaw) {
    const playBtn = $('#videoPlayBtn');
    const caption = $('#videoCaption');
    const frame = $('#videoFrame');
    const cover = $('#videoCover');
    if (!playBtn) return;

    const videoUrl = String(videoUrlRaw || '').trim();

    if (!videoUrl) {
      playBtn.setAttribute('aria-disabled', 'true');
      caption.textContent = 'Vídeo demonstrativo em breve';
      return;
    }

    caption.textContent = 'Assista à demonstração do PapiCore';

    playBtn.addEventListener('click', () => {
      const { type, src } = detectEmbedUrl(videoUrl);
      let el;
      if (type === 'iframe') {
        el = document.createElement('iframe');
        el.src = src;
        el.title = 'Vídeo demonstrativo do PapiCore';
        el.allow = 'autoplay; fullscreen; picture-in-picture';
        el.allowFullscreen = true;
      } else {
        el = document.createElement('video');
        el.src = src;
        el.controls = true;
        el.autoplay = true;
        el.setAttribute('playsinline', '');
      }
      frame.innerHTML = '';
      frame.appendChild(el);
      cover.remove();
    });
  }

  /* ---------- Planos (buscados da API pública) ---------- */

  const state = { plans: [], whatsapp: FALLBACK_WHATSAPP };

  function formatCentsToBRL(cents) {
    return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function unitsLabel(maxUnits) {
    if (maxUnits === null || maxUnits === undefined) return 'Unidades ilimitadas';
    return maxUnits === 1 ? '1 unidade' : `Até ${maxUnits} unidades`;
  }

  function pickHighlightedPlan(plans) {
    const bySlug = plans.find((p) => String(p.slug || '').toUpperCase() === 'PRO');
    if (bySlug) return bySlug.id;
    const professional = plans.find((p) => String(p.slug || '').toUpperCase() === 'PROFESSIONAL');
    if (professional) return professional.id;
    if (plans.length === 3) return plans[1].id;
    return null;
  }

  function planCardHtml(plan, highlightId) {
    const isHighlighted = plan.id === highlightId;
    const waMessage = `Olá! Conheci o PapiCore pelo site e gostaria de saber mais sobre o plano ${plan.name}.`;
    const waLink = buildWhatsAppLink(state.whatsapp, waMessage);
    const cta = waLink
      ? `<a class="l-btn ${isHighlighted ? 'l-btn-primary' : 'l-btn-outline'} l-btn-block" href="${esc(waLink)}" target="_blank" rel="noopener">Começar agora</a>`
      : `<button type="button" class="l-btn ${isHighlighted ? 'l-btn-primary' : 'l-btn-outline'} l-btn-block" data-open-contact data-plan="${esc(plan.name)}">Começar agora</button>`;
    return `
      <article class="l-plan-card${isHighlighted ? ' is-highlighted' : ''}">
        ${isHighlighted ? '<span class="l-plan-badge">Mais escolhido</span>' : ''}
        <h3 class="l-plan-name">${esc(plan.name)}</h3>
        <p class="l-plan-desc">${esc(plan.description || '')}</p>
        <div class="l-plan-price"><strong>${esc(formatCentsToBRL(plan.monthly_price_cents))}</strong><span>/mês</span></div>
        <ul class="l-plan-feature-list">
          <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>${esc(unitsLabel(plan.max_units))}</li>
          <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Recursos do PapiCore 1.0</li>
          <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>${esc(plan.support_level_label || 'Suporte padrão')}</li>
        </ul>
        ${cta}
      </article>`;
  }

  async function loadPlans(whatsapp) {
    const grid = $('#plansGrid');
    const planSelect = $('#cf-plan');
    if (whatsapp) state.whatsapp = whatsapp;
    if (!grid) return;
    try {
      const res = await fetch('/api/public/plans');
      if (!res.ok) throw new Error('Falha ao carregar planos.');
      const plans = await res.json();
      state.plans = Array.isArray(plans) ? plans : [];

      if (!state.plans.length) {
        grid.innerHTML = '<p class="l-plans-error">Nenhum plano disponível no momento. Fale com a gente para uma proposta personalizada.</p>';
      } else {
        const highlightId = pickHighlightedPlan(state.plans);
        grid.innerHTML = state.plans.map((p) => planCardHtml(p, highlightId)).join('');
      }

      if (planSelect) {
        const extra = state.plans.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
        planSelect.insertAdjacentHTML('beforeend', extra);
      }
    } catch (err) {
      grid.innerHTML = '<p class="l-plans-error">Não foi possível carregar os planos agora. Tente novamente em instantes ou fale com a gente pelo formulário de contato.</p>';
    }
  }

  /* ---------- Modal de contato ---------- */

  let lastFocusedEl = null;

  function openContactModal(planName) {
    const modal = $('#contactModal');
    if (!modal) return;
    lastFocusedEl = document.activeElement;

    $('#contactFormWrap').hidden = false;
    $('#contactSuccessWrap').hidden = true;
    $('#contactForm').reset();
    clearFormErrors();
    setFormStatus('', '');

    if (planName) {
      const select = $('#cf-plan');
      if (select && [...select.options].some((o) => o.value === planName)) select.value = planName;
    }

    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');

    setTimeout(() => $('#cf-name')?.focus(), 30);
  }

  function closeContactModal() {
    const modal = $('#contactModal');
    if (!modal) return;
    if (typeof modal.close === 'function' && modal.open) modal.close();
    else modal.removeAttribute('open');
    if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') lastFocusedEl.focus();
  }

  function clearFormErrors() {
    $$('.l-field').forEach((f) => f.classList.remove('is-invalid'));
    $$('.l-field-error').forEach((e) => { e.textContent = ''; });
  }

  function setFieldError(fieldId, message) {
    const field = $(`#${fieldId}`)?.closest('.l-field');
    const errorEl = $(`#${fieldId}-error`);
    if (field) field.classList.add('is-invalid');
    if (errorEl) errorEl.textContent = message;
  }

  function setFormStatus(message, kind) {
    const el = $('#contactFormStatus');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('is-error', 'is-loading');
    if (kind) el.classList.add(kind);
  }

  function validateContactForm(data) {
    let valid = true;
    const name = String(data.name || '').trim();
    if (name.length < 2) { setFieldError('cf-name', 'Informe seu nome.'); valid = false; }

    const whatsappDigits = String(data.whatsapp || '').replace(/\D/g, '');
    if (whatsappDigits.length < 10 || whatsappDigits.length > 13) {
      setFieldError('cf-whatsapp', 'Informe um WhatsApp válido, com DDD.');
      valid = false;
    }

    if (data.units_count && (Number(data.units_count) < 1 || !Number.isInteger(Number(data.units_count)))) {
      setFieldError('cf-units', 'Quantidade inválida.');
      valid = false;
    }

    return valid;
  }

  function initContactModal() {
    const modal = $('#contactModal');
    if (!modal) return;

    $$('[data-open-contact]').forEach((btn) => {
      btn.addEventListener('click', () => openContactModal(btn.dataset.plan || ''));
    });

    $('#contactModalClose').addEventListener('click', closeContactModal);
    $('#contactSuccessClose').addEventListener('click', closeContactModal);

    modal.addEventListener('click', (e) => { if (e.target === modal) closeContactModal(); });
    modal.addEventListener('cancel', (e) => { e.preventDefault(); closeContactModal(); });

    const form = $('#contactForm');
    let submitting = false;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;

      clearFormErrors();
      const raw = Object.fromEntries(new FormData(form));

      if (!validateContactForm(raw)) {
        setFormStatus('Corrija os campos destacados antes de enviar.', 'is-error');
        return;
      }

      submitting = true;
      const submitBtn = $('#contactSubmitBtn');
      submitBtn.disabled = true;
      const originalLabel = submitBtn.textContent;
      submitBtn.textContent = 'Enviando…';
      setFormStatus('Enviando sua mensagem…', 'is-loading');

      try {
        const res = await fetch('/api/public/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(raw)
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) throw new Error(payload?.error || 'Não foi possível enviar sua mensagem. Tente novamente.');

        $('#contactFormWrap').hidden = true;
        $('#contactSuccessWrap').hidden = false;
        setFormStatus('', '');
      } catch (err) {
        setFormStatus(err.message, 'is-error');
      } finally {
        submitting = false;
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
    });
  }

  /* ---------- Contato comercial (WhatsApp / e-mail / Instagram) ---------- */

  function buildWhatsAppLink(phone, message) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
    return `https://wa.me/${withCountry}?text=${encodeURIComponent(message)}`;
  }

  function initFooterContact(contact) {
    contact = contact || {};
    const col = $('#footerContact');
    if (!col) return;

    const links = [];
    const waLink = buildWhatsAppLink(contact.whatsapp, DEFAULT_WHATSAPP_MESSAGE);
    if (waLink) links.push(`<a href="${esc(waLink)}" target="_blank" rel="noopener">WhatsApp</a>`);
    if (contact.email) links.push(`<a href="mailto:${esc(contact.email)}">${esc(contact.email)}</a>`);
    if (contact.instagram) {
      const handle = String(contact.instagram).replace(/^@/, '');
      links.push(`<a href="https://instagram.com/${esc(handle)}" target="_blank" rel="noopener">@${esc(handle)}</a>`);
    }

    if (links.length) {
      const fallback = $('#footerContactFallback');
      if (fallback) fallback.remove();
      col.insertAdjacentHTML('beforeend', links.join(''));
    }
  }

  /* ---------- Rodapé: ano dinâmico ---------- */

  function initFooterYear() {
    const el = $('#footerYear');
    if (el) el.textContent = String(new Date().getFullYear());
  }

  /* ---------- Conteúdo do site (vídeo, contato e imagens) ---------- */
  /* Configurado pelo Painel do Desenvolvedor (aba "Site") — nunca fixo em
     código. Se a imagem de um slot não tiver sido enviada pelo painel, o
     <img> mantém o caminho estático padrão do HTML (/images/xxx.webp, com
     fallback elegante em CSS caso o arquivo também não exista ali). */

  const IMAGE_SLOT_TO_ID = {
    hero: 'heroMockupImg',
    demo_agenda: 'demoAgendaImg',
    demo_servicos: 'demoServicosImg',
    demo_unidades: 'demoUnidadesImg',
    demo_financeiro: 'demoFinanceiroImg',
    demo_painel: 'demoPainelImg'
  };

  function applySiteImages(images) {
    if (!images) return;
    Object.entries(IMAGE_SLOT_TO_ID).forEach(([slot, id]) => {
      const info = images[slot];
      const img = document.getElementById(id);
      if (img && info && info.has && info.url) img.src = info.url;
    });
  }

  async function loadSiteContent() {
    const empty = { demo_video_url: '', contact_whatsapp: '', contact_email: '', contact_instagram: '', images: {} };
    try {
      const res = await fetch('/api/public/site-content');
      if (!res.ok) return empty;
      const data = await res.json();
      return { ...empty, ...data };
    } catch {
      return empty;
    }
  }

  /* ---------- Boot ---------- */

  document.addEventListener('DOMContentLoaded', async () => {
    initReveal();
    initMobileNav();
    initFaqAccordion();
    initDemoTabs();
    initContactModal();
    initFooterYear();

    const site = await loadSiteContent();
    initVideo(site.demo_video_url);
    initFooterContact({ whatsapp: site.contact_whatsapp, email: site.contact_email, instagram: site.contact_instagram });
    applySiteImages(site.images);
    loadPlans(site.contact_whatsapp);
  });
})();
