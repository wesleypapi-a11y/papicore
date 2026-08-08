(() => {
  'use strict';

  const $ = (s, ctx) => (ctx || document).querySelector(s);
  const $$ = (s, ctx) => Array.from((ctx || document).querySelectorAll(s));

  const WHATSAPP_NUMBER = '5512996838041';

  function waLink(message) {
    return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  }

  /* ---------- Rolagem suave / animação de entrada das seções ---------- */

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function initReveal() {
    if (prefersReducedMotion) return;
    const targets = $$('.reveal');
    if (!('IntersectionObserver' in window) || !targets.length) return;

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
    const toggle = $('#arcoNavToggle');
    const nav = $('#arcoNav');
    const backdrop = $('#arcoNavBackdrop');
    if (!toggle || !nav) return;

    function closeNav() {
      toggle.setAttribute('aria-expanded', 'false');
      nav.classList.remove('is-open');
      if (backdrop) backdrop.hidden = true;
    }
    function openNav() {
      toggle.setAttribute('aria-expanded', 'true');
      nav.classList.add('is-open');
      if (backdrop) backdrop.hidden = false;
    }

    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      if (isOpen) closeNav(); else openNav();
    });
    if (backdrop) backdrop.addEventListener('click', closeNav);
    nav.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeNav));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') closeNav();
    });
  }

  /* ---------- Vídeo demonstrativo: carrega o iframe só ao clicar ---------- */

  function initDemoVideo() {
    const frame = $('#arcoDemoFrame');
    const playBtn = $('#arcoDemoPlay');
    if (!frame || !playBtn) return;

    playBtn.addEventListener('click', () => {
      const videoId = frame.dataset.videoId;
      if (!videoId) return;
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
      iframe.title = 'ARCO em ação';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      frame.innerHTML = '';
      frame.appendChild(iframe);
    });
  }

  /* ---------- Carrossel de screenshots ---------- */

  function initCarousel() {
    const root = $('#arcoCarousel');
    if (!root) return;
    const track = $('.arco-carousel-track', root);
    const slides = $$('.arco-carousel-slide', root);
    const dotsWrap = $('#arcoCarouselDots');
    const prevBtn = $('.arco-carousel-prev', root);
    const nextBtn = $('.arco-carousel-next', root);
    if (!track || !slides.length) return;

    let index = 0;
    let timer = null;

    slides.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('aria-label', `Ver screenshot ${i + 1}`);
      dot.addEventListener('click', () => goTo(i, true));
      dotsWrap.appendChild(dot);
    });
    const dots = $$('button', dotsWrap);

    function render() {
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((d, i) => d.classList.toggle('is-active', i === index));
    }

    function goTo(i, userTriggered) {
      index = (i + slides.length) % slides.length;
      render();
      if (userTriggered) restartAutoplay();
    }

    function next() { goTo(index + 1); }
    function prev() { goTo(index - 1, true); }

    if (nextBtn) nextBtn.addEventListener('click', () => goTo(index + 1, true));
    if (prevBtn) prevBtn.addEventListener('click', prev);

    function startAutoplay() {
      if (prefersReducedMotion) return;
      timer = setInterval(next, 4500);
    }
    function restartAutoplay() {
      if (timer) clearInterval(timer);
      startAutoplay();
    }

    root.addEventListener('mouseenter', () => timer && clearInterval(timer));
    root.addEventListener('mouseleave', startAutoplay);

    render();
    startAutoplay();
  }

  /* ---------- Links de WhatsApp por plano ---------- */

  function initWhatsappLinks() {
    $$('[data-wa-message]').forEach((el) => {
      el.setAttribute('href', waLink(el.dataset.waMessage));
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener');
    });
  }

  /* ---------- Ano do rodapé ---------- */

  function initFooterYear() {
    const el = $('#arcoFooterYear');
    if (el) el.textContent = String(new Date().getFullYear());
  }

  document.addEventListener('DOMContentLoaded', () => {
    initReveal();
    initMobileNav();
    initDemoVideo();
    initCarousel();
    initWhatsappLinks();
    initFooterYear();
  });
})();
