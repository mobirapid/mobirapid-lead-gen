(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function gradeClass(grade) {
    const g = String(grade || '').toLowerCase();
    if (/new|sealed/.test(g)) return 'g-new';
    if (/non-activated|non activated/.test(g)) return 'g-mint';
    if (/open box|activated/.test(g)) return 'g-teal';
    if (/excellent/.test(g)) return 'g-excellent';
    if (/very good/.test(g)) return 'g-verygood';
    if (/good/.test(g)) return 'g-good';
    if (/fair/.test(g)) return 'g-fair';
    return 'g-good';
  }

  // ----- Form refs -----
  const phone = $('phone');
  const sendOtpBtn = $('sendOtpBtn');
  const otpField = $('otpField');
  const otpInput = $('otp');
  const verifyOtpBtn = $('verifyOtpBtn');
  const otpHint = $('otpHint');
  const submitBtn = $('submitBtn');
  const status = $('formStatus');
  const form = $('leadForm');
  const clientType = $('client_type');
  const companyFields = $('companyFields');
  const companyName = $('company_name');
  const companyEmail = $('company_email');
  const bestTimeSel = $('best_time_sel');

  let phoneVerified = false;
  let resendTimer = null;
  let ctaText = 'Schedule call now';

  // ========================================================================
  // Load dynamic site content from the backend
  // ========================================================================
  async function loadSite() {
    try {
      const r = await fetch('/api/site');
      const data = await r.json();
      if (!data.ok) return;
      // Each section renders independently: a failure in one must never blank the rest
      // of the page (e.g. an error in Contact used to take the footer down with it).
      const safe = (name, fn) => { try { fn(); } catch (e) { console.error('Section failed:', name, e); } };
      safe('settings', () => applySettings(data.settings));
      safe('shopIcons', () => { if (String(data.settings.shop_enabled) === '1') { const si = $('shopIcons'); if (si) si.hidden = false; } });
      safe('headerNav', () => renderHeaderNav(data.categories));
      safe('categoryStrip', () => renderCategoryStrip(data.categories, data.models));
      safe('bannerSlider', () => renderBannerSlider(data.settings));
      safe('ribbon', () => renderRibbon(data.settings));
      safe('usps', () => renderUsps(data.settings));
      safe('deal', () => renderDeal(data.settings, data.models, data.categories));
      safe('categoryCards', () => renderCategoryCards(data.categories, data.models));
      safe('models', () => renderModels(data.models, data.settings, data.categories));
      safe('reviews', () => renderReviews(data.reviews, data.settings));
      safe('steps', () => renderSteps(data.settings));
      safe('qc', () => renderQc(data.settings));
      safe('faq', () => renderFaq(data.settings));
      safe('blog', () => renderBlog(data.settings, data.posts));
      safe('modelParam', () => applyModelParam(data.models));
      safe('about', () => renderAbout(data.settings));
      safe('contact', () => renderContact(data.settings));
      safe('social', () => renderSocial(data.settings));
      safe('footer', () => renderFooter(data.settings, data.pages));
    } catch (e) {
      console.error('Could not load site content:', e);
    }
  }

  function applySettings(s) {
    const ann = $('announceBar');
    if (ann) {
      if (String(s.announce_enabled) === '1' && (s.announce_text || '').trim()) {
        ann.hidden = false; ann.textContent = s.announce_text;
      } else { ann.hidden = true; }
    }
    if (s.brand_name) { $('brandName').textContent = s.brand_name; document.title = s.brand_name + ' — Book a Free Consultation'; }
    if (s.logo_path) {
      // When a logo is uploaded, show only the logo — most logos already include
      // the brand name, so hide the "M" mark and the separate wordmark to avoid clutter.
      const logo = $('brandLogo');
      logo.src = s.logo_path; logo.alt = s.brand_name || 'Logo'; logo.hidden = false;
      $('brandMark').hidden = true;
      $('brandName').hidden = true;
    }
    if (s.header_cta_text) $('headerCta').textContent = s.header_cta_text;
    if (s.cta_text) { ctaText = s.cta_text; submitBtn.textContent = ctaText; }
    if (s.banner_eyebrow) $('eyebrow').textContent = s.banner_eyebrow;
    if (s.banner_heading) $('heroHeading').textContent = s.banner_heading;
    if (s.banner_subtext) $('heroSub').textContent = s.banner_subtext;
    if (s.banner_image) {
      const hero = $('hero');
      hero.style.backgroundImage = `url("${s.banner_image}")`;
      hero.classList.add('has-image');
    }
    const trust = Array.isArray(s.trust_points) ? s.trust_points : [];
    $('trustList').innerHTML = trust.map((t) => `<li><span>✓</span> ${esc(t)}</li>`).join('');

    fillSelect($('requirement'), s.requirement_options, 'Select use');
    fillSelect($('budget'), s.budget_options, 'Select range');
    // Footer (text/email) is now handled by renderFooter; these legacy elements
    // may not exist, so guard before touching them.
    const ft = $('footerText'); if (ft && s.footer_text) ft.textContent = s.footer_text;
    const fe = $('footerEmail'); if (fe && s.footer_email) { fe.textContent = s.footer_email; fe.href = 'mailto:' + s.footer_email; }
  }

  function fillSelect(sel, options, placeholder) {
    if (!sel || !Array.isArray(options)) return;
    // Placeholder is selectable (not disabled) because these fields are optional.
    sel.innerHTML =
      `<option value="" selected>${esc(placeholder)}</option>` +
      options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  }

  function renderUsps(s) {
    const section = $('uspsSection');
    const items = Array.isArray(s.usps) ? s.usps : [];
    if (!s.usps_enabled || !items.length) { section.hidden = true; return; }
    section.hidden = false;
    if (s.usps_title) $('uspsTitle').textContent = s.usps_title;
    const icons = window.MOBI_ICONS || {};
    $('uspGrid').innerHTML = items.map((u) => {
      const visual = u.image
        ? `<img src="${esc(u.image)}" alt="" />`
        : (icons[u.icon] || icons.star || '');
      return `
      <div class="usp-card">
        <span class="usp-icon">${visual}</span>
        <div class="usp-text">
          <span class="usp-title">${esc(u.title)}</span>
          ${u.note ? `<span class="usp-note">${esc(u.note)}</span>` : ''}
        </div>
      </div>`;
    }).join('');

    const g = $('uspGstin');
    if (g) {
      if ((s.gstin || '').trim()) {
        g.hidden = false;
        g.innerHTML = `Every purchase includes a GST invoice with serial number &nbsp;·&nbsp; <strong>GSTIN: ${esc(s.gstin)}</strong>`;
      } else { g.hidden = true; }
    }
  }

  function applyModelParam(models) {
    const slug = new URLSearchParams(location.search).get('model');
    if (!slug) return;
    const m = (models || []).find((x) => x.slug === slug);
    if (!m) return;
    // Chosen condition (from the product page's condition selector) rides along in ?cond=
    // ?call=video (from the "Schedule video call" button) preselects the video-call option.
    if (new URLSearchParams(location.search).get('call') === 'video') {
      const v = document.querySelector('input[name="call_type"][value="Video call"]');
      if (v) v.checked = true;
    }
    const cond = new URLSearchParams(location.search).get('cond');
    const label = m.name + (cond ? ' — Condition: ' + cond : '');
    const hidden = $('interested_model');
    if (hidden) hidden.value = label;
    const note = $('modelNote');
    if (note) {
      note.innerHTML = 'Enquiring about: <strong>' + esc(label) + '</strong>';
      note.hidden = false;
    }
    const form = document.getElementById('lead-form') || document.getElementById('leadForm');
    if (form && form.scrollIntoView) {
      setTimeout(() => form.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
  }

  // Multi-deal grid: one compact card per deal (e.g. one per category). When the
  // admin's deals list is empty, the classic single-deal banner below is used instead.
  function renderDealsGrid(s, models, categories) {
    let deals = [];
    try { deals = JSON.parse(s.deals_list || '[]') || []; } catch { deals = []; }
    deals = deals.map((d) => ({ ...d, m: (models || []).find((x) => x.slug === d.model_slug) })).filter((d) => d.m);
    if (!deals.length) return false;
    buildCatMap(categories);
    const section = $('dealSection');
    const num = (v) => parseFloat(String(v || '').replace(/[^\d.]/g, '')) || 0;
    const cards = deals.map((d) => {
      const m = d.m;
      const cat = CAT_MAP[m.category];
      const label = (d.label || '').trim() || ((cat ? String(cat.name).replace(/^Refurbished\s+/i, '') : 'Today') + ' deal');
      const price = (d.price || '').trim() || (m.price || '').trim();
      const mrp = (d.mrp || '').trim() || (m.mrp || '').trim();
      const pv = num(price), mv = num(mrp);
      const off = pv && mv > pv ? Math.round(((mv - pv) / mv) * 100) : 0;
      const qty = String(d.qty ?? '').trim();
      const qn = qty === '' ? null : parseInt(qty, 10);
      const stock = qn === 0 ? '<span class="dealg-stock out">Sold out</span>'
        : (qn && qn <= 5 ? `<span class="dealg-stock">Only ${qn} left</span>` : '');
      return `<a class="dealg-card" href="${prodUrl(m)}">
        <span class="dealg-media">${m.image ? `<img src="${esc(m.image)}" alt="${esc(m.name)}" loading="lazy">` : '<span class="dealg-ph"></span>'}${off ? `<span class="dealg-off">${off}% off</span>` : ''}</span>
        <span class="dealg-chip">${esc(label)}</span>
        <span class="dealg-name">${esc(m.name)}</span>
        <span class="dealg-price">${esc(price || 'Price on request')}${mv > pv ? ` <span class="mrp-strike">${esc(mrp)}</span>` : ''}</span>
        ${stock}
        <span class="dealg-cta">View deal →</span>
      </a>`;
    }).join('');
    $('dealInner').innerHTML = `
      <div class="dealg-head">
        <span class="deal-badge"><span class="dot"></span> ${esc(s.offer_label || 'Deals of the Day')}</span>
        <h2 class="dealg-title">One hot deal per category</h2>
      </div>
      <div class="dealg-grid">${cards}</div>`;
    section.hidden = false;
    return true;
  }

  function renderDeal(s, models, categories) {
    const section = $('dealSection');
    if (!section) return;
    if (renderDealsGrid(s, models, categories)) return;
    const on = String(s.offer_enabled) === '1';
    const m = on ? (models || []).find((x) => x.slug === s.offer_model_slug) : null;
    if (!on || !m) { section.hidden = true; return; }

    const price = (s.offer_price || m.price || '').trim();
    const mrp = (s.offer_mrp || '').trim();
    const num = (v) => parseInt(String(v).replace(/[^\d]/g, ''), 10) || 0;
    let badge = (s.offer_badge || '').trim();
    if (!badge && mrp && price && num(mrp) > num(price)) {
      badge = 'Save ₹' + (num(mrp) - num(price)).toLocaleString('en-IN');
    }
    const specs = [m.cpu, m.gpu, m.memory, m.storage].filter(Boolean);
    const chips = (specs.length ? specs : [m.specs].filter(Boolean))
      .map((x) => `<span class="deal-spec">${esc(x)}</span>`).join('');
    const media = m.image
      ? `<img class="deal-photo-img" src="${esc(m.image)}" alt="${esc(m.name)}">`
      : `<div class="deal-photo"><div class="laptop"></div><div class="base"></div></div>`;

    // Stock / scarcity
    const qty = s.offer_qty === '' || s.offer_qty == null ? null : num(s.offer_qty);
    const soldOut = qty === 0;
    let stockLabel = '';
    if (qty === 1) stockLabel = 'Only 1 piece left';
    else if (qty !== null && qty >= 2 && qty <= 5) stockLabel = 'Only ' + qty + ' left';
    else if (soldOut) stockLabel = 'Sold out';

    // Reserve / booking amount: manual field, else auto 10% of price
    let reserveAmt = (s.offer_reserve_amount || '').trim();
    if (!reserveAmt) { const ba = bookingAmt(m, s); if (ba) reserveAmt = '₹' + ba.toLocaleString('en-IN'); }
    // Reserve destination: PayU checkout page > static payment link > lead form fallback
    const payuOn = String(s.payu_enabled) === '1';
    const reserveUrl = payuOn ? ('/reserve?model=' + encodeURIComponent(m.slug)) : (s.offer_reserve_url || '').trim();
    const reserveExternal = !payuOn && reserveUrl;

    const actions = soldOut
      ? `<span class="deal-soldout">Sold out — <a href="/book" class="deal-notify">notify me of similar deals</a></span>`
      : `<a class="deal-book" href="/book?model=${encodeURIComponent(m.slug)}&call=video" data-deal-model="${esc(m.name)}" data-video="1"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg> Book a video call</a>
         ${reserveAmt ? `<a class="deal-reserve" ${reserveUrl ? `href="${esc(reserveUrl)}"${reserveExternal ? ' target="_blank" rel="noopener"' : ''}` : `href="/book?model=${encodeURIComponent(m.slug)}"`} data-deal-model="${esc(m.name)}" data-reserve="${esc(reserveAmt)}">Book with ${esc(reserveAmt)} →</a>` : ''}
         <a class="deal-view" href="${prodUrl(m)}">View full specs</a>`;

    $('dealInner').innerHTML = `
      <div class="deal-copy">
        <span class="deal-badge"><span class="dot"></span> ${esc(s.offer_label || 'Deal of the Day')}</span>
        ${stockLabel ? `<span class="deal-stock${soldOut ? ' out' : ''}">${esc(stockLabel)}</span>` : ''}
        <h2 class="deal-title">${esc(m.name)}</h2>
        ${s.offer_subtitle ? `<p class="deal-sub">${esc(s.offer_subtitle)}</p>` : ''}
        ${chips ? `<div class="deal-specs">${chips}</div>` : ''}
        <div class="deal-price-row">
          <span class="deal-price">${esc(price || 'Price on request')}</span>
          ${mrp ? `<span class="deal-mrp">${esc(mrp)}</span>` : ''}
          ${badge ? `<span class="deal-save">${esc(badge)}</span>` : ''}
        </div>
        ${!soldOut && reserveAmt ? `<p class="deal-reserve-note">Reserve this unit with just ${esc(reserveAmt)} — adjusted in your final invoice.</p>` : ''}
        ${s.offer_gst_note ? `<p class="deal-gst">${esc(s.offer_gst_note)}</p>` : ''}
        <div class="deal-actions">${actions}</div>
      </div>
      <div class="deal-media">${media}</div>`;
    section.hidden = false;

    // Video-call button: prefill model, pick "Video call", show note, scroll to form
    const book = $('dealInner').querySelector('.deal-book');
    if (book) book.addEventListener('click', () => {
      prefillDealForm(book.dataset.dealModel);
      const vid = document.querySelector('input[name="call_type"][value="Video call"]');
      if (vid) vid.checked = true;
    });
    // Reserve button without a payment link falls back to the form (as a reservation enquiry)
    const reserve = $('dealInner').querySelector('.deal-reserve');
    if (reserve && !reserveUrl) reserve.addEventListener('click', () => {
      prefillDealForm(reserve.dataset.dealModel, 'Reservation request (' + reserve.dataset.reserve + ')');
    });
  }

  function prefillDealForm(modelName, prefixNote) {
    const hidden = $('interested_model'); if (hidden) hidden.value = modelName;
    const note = $('modelNote');
    if (note) {
      note.innerHTML = (prefixNote ? esc(prefixNote) + ' — ' : 'Enquiring about: ') + '<strong>' + esc(modelName) + '</strong>';
      note.hidden = false;
    }
  }

  // Map of category slug -> {url_prefix, fields, name, singular}
  let CAT_MAP = {};
  function buildCatMap(categories) {
    CAT_MAP = {};
    (categories || []).forEach((c) => { CAT_MAP[c.slug] = c; });
  }
  function prodUrl(m) {
    const c = CAT_MAP[m.category];
    return m.slug ? '/' + (c ? c.url_prefix : 'macbook') + '/' + esc(m.slug) : '#lead-form';
  }
  // Booking amount = max(percent of price, floor). Matches the server's bookingAmount().
  function bookingAmt(m, s) {
    const pn = (v) => parseFloat(String(v || '').replace(/[^\d.]/g, '')) || 0;
    let price = pn(m.price);
    if (!price) { // fall back to lowest condition variant
      try { const v = JSON.parse(m.condition_prices || '[]') || []; const nums = v.filter((x) => x && x.price).map((x) => pn(x.price)); if (nums.length) price = Math.min(...nums); } catch {}
    }
    if (!price) return 0;
    const pct = parseFloat(s.booking_percent || '10') || 0;
    const floor = parseInt(String(s.booking_min_amount || '3999').replace(/[^\d]/g, ''), 10) || 0;
    return Math.max(Math.round(price * pct / 100), floor);
  }
  function reserveBtn(m, s) {
    if (String(s.reserve_button_enabled) === '0') return '';
    const link = (s.reserve_payment_link || '').trim();
    const payuOn = String(s.payu_enabled) === '1';
    if (!link && !payuOn) return '';
    const amt = bookingAmt(m, s);
    if (!amt) return '';
    const href = link || ('/reserve?model=' + encodeURIComponent(m.slug));
    const ext = link ? ' target="_blank" rel="noopener"' : '';
    return `<a class="model-reserve" href="${esc(href)}"${ext}>Book with ₹${amt.toLocaleString('en-IN')} →</a>`;
  }
  function specLine(m, s) {
    const c = CAT_MAP[m.category];
    if (c && c.fields === 'phone') {
      return [m.cpu, m.storage, m.battery_health ? 'Battery ' + m.battery_health : '', m.colour].filter(Boolean).join(' · ');
    }
    return m.specs || '';
  }

  // Sliding promo banners (admin-uploaded). Swipeable, auto-advancing, dot navigation.
  function renderBannerSlider(s) {
    const section = $('bsliderSection'), track = $('bsliderTrack'), dots = $('bsliderDots');
    if (!section || !track) return;
    let banners = [];
    try { banners = JSON.parse(s.slider_banners || '[]') || []; } catch { banners = []; }
    banners = banners.filter((b) => b && b.image);
    if (!banners.length) return;
    track.innerHTML = banners.map((b, i) => {
      // Optional taller mobile version of the banner (shown ≤640px)
      const img = `<picture>${b.mobile ? `<source media="(max-width: 640px)" srcset="${esc(b.mobile)}">` : ''}<img src="${esc(b.image)}" alt="Banner ${i + 1}" ${i === 0 ? '' : 'loading="lazy"'} /></picture>`;
      return b.link ? `<a class="bslide" href="${esc(b.link)}">${img}</a>` : `<div class="bslide">${img}</div>`;
    }).join('');
    section.hidden = false;
    if (banners.length < 2) { if (dots) dots.hidden = true; return; }
    dots.innerHTML = banners.map((_, i) => `<button class="bdot${i === 0 ? ' on' : ''}" data-b="${i}" aria-label="Banner ${i + 1}"></button>`).join('');
    let cur = 0, timer = null;
    const go = (i) => {
      cur = (i + banners.length) % banners.length;
      track.scrollTo({ left: cur * track.clientWidth, behavior: 'smooth' });
    };
    const syncDots = () => dots.querySelectorAll('.bdot').forEach((d, i) => d.classList.toggle('on', i === cur));
    dots.addEventListener('click', (e) => { const b = e.target.closest('.bdot'); if (!b) return; go(+b.dataset.b); restart(); });
    track.addEventListener('scroll', () => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== cur) { cur = i; syncDots(); }
    }, { passive: true });
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = () => { if (!reduced) timer = setInterval(() => { go(cur + 1); syncDots(); }, 4500); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const restart = () => { stop(); syncDots(); start(); };
    track.addEventListener('pointerdown', stop, { passive: true });
    track.addEventListener('mouseenter', stop);
    track.addEventListener('mouseleave', restart);
    start();
  }

  // Circular category icons under the header (horizontally scrollable on mobile).
  // Icon: admin-uploaded per category, else the first product photo in it, else the initial letter.
  function renderCategoryStrip(categories, models) {
    const wrap = $('catStrip');
    if (!wrap) return;
    const cats = (categories || []);
    if (cats.length < 2) return;
    wrap.innerHTML = cats.map((c) => {
      const short = String(c.name).replace(/^Refurbished\s+/i, '');
      const img = c.icon_image || ((models || []).find((m) => m.category === c.slug && m.image) || {}).image || '';
      return `<a class="cat-chip" href="/c/${esc(c.slug)}">
        <span class="cat-chip-ring">${img ? `<img src="${esc(img)}" alt="${esc(short)}" loading="lazy">` : `<span class="cat-chip-letter">${esc(short.charAt(0))}</span>`}</span>
        <span class="cat-chip-name">${esc(short)}</span>
      </a>`;
    }).join('');
    $('catStripSection').hidden = false;
  }

  // Auto-scrolling trust ribbon (e.g. "6-Month Warranty · Easy Returns"). Items are a
  // comma-separated setting; the track is duplicated for a seamless loop.
  function renderRibbon(s) {
    const bar = $('ribbonBar'), track = $('ribbonTrack');
    if (!bar || !track) return;
    if (String(s.ribbon_enabled ?? '1') === '0') return;
    const items = String(s.ribbon_items || '6-Month Warranty, Easy Returns, GST Invoice, Free Shipping')
      .split(',').map((x) => x.trim()).filter(Boolean);
    if (!items.length) return;
    const seq = items.map((t) => `<span class="ribbon-item">✦ ${esc(t)}</span>`).join('');
    const half = seq.repeat(Math.max(1, Math.ceil(8 / items.length)));
    track.innerHTML = half + half; // two identical halves -> -50% translate loops cleanly
    bar.hidden = false;
  }

  // Header nav: one link per active category (matches the server-rendered pages' header).
  function renderHeaderNav(categories) {
    const nav = $('headerNav');
    if (!nav) return;
    const cats = categories || [];
    const shop = cats.length
      ? `<div class="nav-drop">
          <button type="button" class="nav-drop-btn" aria-expanded="false" aria-haspopup="true">Shop <span class="nav-caret">▾</span></button>
          <div class="nav-menu">
            ${cats.map((c) => `<a href="/c/${esc(c.slug)}">${esc(String(c.name).replace(/^Refurbished\s+/i, ''))}</a>`).join('')}
            <a class="nav-menu-all" href="/#modelsSection">All products</a>
          </div>
        </div>`
      : '';
    nav.innerHTML = shop + '<a href="/compare">Compare</a><a href="/condition">Condition</a><a href="/blog">Blog</a>'
      + '<a class="nav-partner" href="/partner">Partner with us</a>';
    nav.hidden = false;
    initNavDrop(nav);
    initNavToggle(nav);
  }

  // Mobile: hamburger opens the nav as a drawer.
  function initNavToggle(nav) {
    const t = $('navToggle');
    if (!t || t.dataset.on) return;
    t.dataset.on = '1';
    t.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      t.classList.toggle('on', open);
      t.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (!nav.contains(e.target) && !t.contains(e.target)) {
        nav.classList.remove('open'); t.classList.remove('on'); t.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Dropdown behaviour: hover on desktop, click/tap anywhere (works on touch too).
  function initNavDrop(scope) {
    scope.querySelectorAll('.nav-drop').forEach((drop) => {
      const btn = drop.querySelector('.nav-drop-btn');
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const open = drop.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', (e) => {
        if (!drop.contains(e.target)) { drop.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { drop.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      });
    });
  }

  function renderCategoryCards(categories, models) {
    const wrap = $('catCards');
    if (!wrap) return;
    // All active categories get a card here — the "products on homepage" toggle only affects the showcase below.
    const cats = categories || [];
    if (cats.length < 2) { const sec = $('catCardsSection'); if (sec) sec.hidden = true; return; }
    buildCatMap(categories);
    const counts = {};
    (models || []).forEach((m) => { counts[m.category] = (counts[m.category] || 0) + 1; });
    wrap.innerHTML = cats.map((c, i) => `
      <a class="shopcat-card ${i % 2 ? 'alt' : ''}" href="/c/${esc(c.slug)}">
        <span class="shopcat-count">${counts[c.slug] ? counts[c.slug] + (counts[c.slug] === 1 ? ' model' : ' models') : 'Coming soon'}</span>
        <h3>${esc(c.name)}</h3>
        <p>${esc(c.tagline || '')}</p>
        <span class="shopcat-go">Browse →</span>
      </a>`).join('');
    const sec = $('catCardsSection'); if (sec) sec.hidden = false;
  }

  function renderModels(allModels, s, categories) {
    const section = $('modelsSection');
    buildCatMap(categories);
    // Arriving from a product/category page with ?notify=<slug> — prefill the lead form.
    // Uses the full list so it also works for products whose category is hidden from the homepage.
    const notifyPrefill = () => {
      const notifySlug = new URLSearchParams(location.search).get('notify');
      if (!notifySlug) return;
      const nm = (allModels || []).find((x) => x.slug === notifySlug);
      if (!nm) return;
      prefillDealForm(nm.name, 'Future availability enquiry');
      const form = document.getElementById('lead-form');
      if (form) setTimeout(() => form.scrollIntoView({ behavior: 'smooth' }), 150);
    };
    // Homepage shows only categories with "Show on homepage" on; their pages at /c/<slug> stay live.
    const models = (allModels || []).filter((m) => !CAT_MAP[m.category] || CAT_MAP[m.category].show_home !== 0);
    if (!models.length) { section.hidden = true; notifyPrefill(); return; }
    section.hidden = false;
    if (s.models_title) $('modelsTitle').textContent = s.models_title;
    $('modelsSubtitle').textContent = s.models_subtitle || '';
    // Category filter chips (only when 2+ categories have products)
    const present = [...new Set(models.map((m) => m.category))];
    const filter = $('modelsFilter');
    if (filter) {
      if (present.length > 1) {
        const chips = [`<button class="mfilter on" data-cat="">All</button>`].concat(present.map((slug) => {
          const c = CAT_MAP[slug]; return `<button class="mfilter" data-cat="${esc(slug)}">${esc(c ? c.name : slug)}</button>`;
        }));
        filter.innerHTML = chips.join('');
        filter.hidden = false;
        filter.querySelectorAll('.mfilter').forEach((b) => b.addEventListener('click', () => {
          filter.querySelectorAll('.mfilter').forEach((x) => x.classList.toggle('on', x === b));
          const cat = b.dataset.cat;
          $('modelsGrid').querySelectorAll('.model-card').forEach((card) => {
            card.style.display = (!cat || card.dataset.cat === cat) ? '' : 'none';
          });
        }));
      } else { filter.hidden = true; }
    }
    $('modelsGrid').innerHTML = models.map((m) => {
      const so = /sold|out\s*of\s*stock/i.test(m.badge || '');
      const badge = m.badge ? `<span class="model-badge ${so ? 'soldout' : /hot/i.test(m.badge) ? 'hot' : 'avail'}">${esc(m.badge)}</span>` : '';
      const img = m.image
        ? `<div class="model-img" style="background-image:url('${esc(m.image)}')">${badge}</div>`
        : `<div class="model-img placeholder">${badge}<span></span></div>`;
      const sl = specLine(m, s);
      return `<article class="model-card${so ? ' oos' : ''}" data-cat="${esc(m.category || '')}">
        ${img}
        <div class="model-body">
          <h3>${esc(m.name)}</h3>
          ${sl ? `<p class="model-specs">${esc(sl)}</p>` : ''}
          ${m.description ? `<p class="model-desc">${esc(m.description)}</p>` : ''}
          <div class="model-pricerow">
            ${(() => {
              const pn = (v) => parseFloat(String(v || '').replace(/[^\d.]/g, '')) || 0;
              let variants = [];
              try { variants = JSON.parse(m.condition_prices || '[]') || []; } catch { variants = []; }
              variants = variants.filter((v) => v && v.price && (v.grade || v.ram || v.storage));
              if (variants.length) {
                const low = variants.reduce((a, b) => (pn(b.price) < pn(a.price) ? b : a));
                return `<span class="model-price"><span class="from-tag">From</span> ${esc(low.price)}</span>`;
              }
              const mv = pn(m.mrp), pv = pn(m.price);
              return `${m.price ? `<span class="model-price">${esc(m.price)}</span>` : ''}${mv && pv && mv > pv ? `<span class="mrp-strike">₹${Math.round(mv).toLocaleString('en-IN')}</span><span class="off-tag">${Math.round(((mv - pv) / mv) * 100)}% off</span>` : ''}`;
            })()}
          </div>
          ${(() => {
            const tags = String(m.best_for || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3);
            return tags.length ? `<div class="bestfor"><span class="bestfor-label">Best for:</span>${tags.map((t) => `<span class="bestfor-tag">${esc(t)}</span>`).join('')}</div>` : '';
          })()}
          <div class="model-meta">
            ${(() => { const pn = (m.price_note || '').trim() || (CAT_MAP[m.category] && CAT_MAP[m.category].price_note) || s.price_note; return m.price && pn ? `<span class="model-gst">${esc(pn)}</span>` : ''; })()}
            ${m.condition_grade ? `<a class="model-grade cond-pill ${gradeClass(m.condition_grade)}" href="/condition" title="What does this grade mean?">${esc(m.condition_grade)} ⓘ</a>` : ''}
          </div>
          ${m.warranty ? `<p class="model-warranty">${esc(m.warranty)}</p>` : ''}
          <div class="model-foot">
            ${so
              ? `<a class="model-reserve model-avail" href="/book?notify=${encodeURIComponent(m.slug)}" data-notify-model="${esc(m.name)}">Check future availability →</a>`
              : (String(s.shop_enabled) === '1' && bookingAmt(m, s) > 0
                ? `<button class="model-reserve" data-add-cart data-slug="${esc(m.slug)}">Add to cart</button>`
                : reserveBtn(m, s))}
            <a class="model-cta" href="${prodUrl(m)}">View details →</a>
          </div>
        </div>
      </article>`;
    }).join('');
    const note = $('modelsNote');
    if (note) {
      if (s.price_note) {
        note.hidden = false;
        note.textContent = `Tax is shown next to each price. A GST invoice with the device serial number is provided with every purchase.`;
      } else { note.hidden = true; }
    }
    setupCarousel('modelsGrid');
    // "Check future availability" on homepage cards prefills the lead form
    $('modelsGrid').querySelectorAll('.model-avail').forEach((a) => a.addEventListener('click', () => {
      prefillDealForm(a.dataset.notifyModel, 'Future availability enquiry');
    }));
    notifyPrefill();
  }

  function stars(n) {
    n = Math.round(Number(n) || 0);
    return '★★★★★☆☆☆☆☆'.slice(5 - Math.min(5, n), 10 - Math.min(5, n));
  }
  function renderReviews(reviews, s) {
    const section = $('reviewsSection');
    if (!s.reviews_enabled) { section.hidden = true; return; }
    section.hidden = false;
    if (s.reviews_title) $('reviewsTitle').textContent = s.reviews_title;

    const rating = parseFloat(s.google_rating);
    const count = parseInt(s.google_review_count, 10);
    if (!isNaN(rating) && rating > 0) {
      $('googleRating').hidden = false;
      $('gScore').textContent = rating.toFixed(1);
      $('gStars').textContent = stars(rating);
      $('gCount').textContent = !isNaN(count) && count > 0 ? `(${count} Google reviews)` : 'on Google';
    }
    if (s.google_reviews_url) {
      const link = $('googleReviewLink');
      link.hidden = false; link.href = s.google_reviews_url;
    }
    const grid = $('reviewsGrid');
    if (!reviews || !reviews.length) { grid.innerHTML = ''; return; }
    grid.innerHTML = reviews.map((r) => `
      <article class="review-card">
        <div class="review-stars">${stars(r.rating)}</div>
        <p class="review-text">"${esc(r.text)}"</p>
        <div class="review-meta">
          <span class="review-author">${esc(r.author)}</span>
          ${r.date_label ? `<span class="review-date">${esc(r.date_label)}</span>` : ''}
        </div>
      </article>`).join('');
    setupCarousel('reviewsGrid');
  }

  // "How it works" steps — editable in the admin (Homepage tab).
  function renderSteps(s) {
    const section = $('howSection'), grid = $('stepsGrid');
    if (!section || !grid) return;
    let items = [];
    try { items = typeof s.how_steps === 'string' ? JSON.parse(s.how_steps || '[]') : (s.how_steps || []); } catch { items = []; }
    items = (items || []).filter((x) => x && (x.title || '').trim());
    if (String(s.how_enabled ?? '1') === '0' || !items.length) { section.hidden = true; return; }
    section.hidden = false;
    if (s.how_title) $('howTitle').textContent = s.how_title;
    const icons = window.MOBI_ICONS || {};
    grid.innerHTML = items.map((x, i) => {
      const ic = icons[x.icon] || '';
      const inner = `<span class="step-head">${ic ? `<span class="step-ic step-ic-${i % 3}">${ic}</span>` : ''}<span class="step-num">Step ${i + 1}</span></span>
        <h3>${esc(x.title)}</h3>${x.note ? `<p>${esc(x.note)}</p>` : ''}
        ${x.link ? `<span class="step-link">${esc(x.link_text || 'Learn more')} →</span>` : ''}`;
      return x.link
        ? `<a class="step step-clickable" href="${esc(x.link)}">${inner}</a>`
        : `<div class="step">${inner}</div>`;
    }).join('');
  }

  function renderQc(s) {
    const section = $('qcSection');
    const items = Array.isArray(s.qc_items) ? s.qc_items : [];
    if (!s.qc_enabled || (!items.length && !s.qc_video_enabled)) { section.hidden = true; return; }
    section.hidden = false;
    if (s.qc_title) $('qcTitle').textContent = s.qc_title;
    $('qcSubtitle').textContent = s.qc_subtitle || '';
    const icons = window.MOBI_ICONS || {};
    $('qcGrid').innerHTML = items.map((q) => `
      <div class="qc-card">
        <span class="qc-icon">${icons[q.icon] || icons.qc || ''}</span>
        <div class="qc-text"><span class="qc-name">${esc(q.title)}</span>${q.note ? `<span class="qc-note">${esc(q.note)}</span>` : ''}</div>
      </div>`).join('');
    const v = $('qcVideo');
    if (s.qc_video_enabled && (s.qc_video_text || '').trim()) {
      v.hidden = false;
      $('qcVideoIcon').innerHTML = icons.videocall || '';
      $('qcVideoText').textContent = s.qc_video_text;
    } else { v.hidden = true; }
  }

  function renderFaq(s) {
    const section = $('faqSection');
    const items = Array.isArray(s.faq_items) ? s.faq_items : [];
    if (!s.faq_enabled || !items.length) { section.hidden = true; return; }
    section.hidden = false;
    if (s.faq_title) $('faqTitle').textContent = s.faq_title;
    $('faqList').innerHTML = items.map((f) => `
      <details class="faq-item">
        <summary>${esc(f.q)}<span class="faq-plus">+</span></summary>
        <div class="faq-answer">${esc(f.a)}</div>
      </details>`).join('');
  }

  function renderBlog(s, posts) {
    const section = $('blogSection');
    posts = Array.isArray(posts) ? posts : [];
    if (!s.blog_enabled || !posts.length) { section.hidden = true; return; }
    section.hidden = false;
    if (s.blog_title) $('blogHomeTitle').textContent = s.blog_title;
    $('blogHomeSubtitle').textContent = s.blog_subtitle || '';
    const fmt = (d) => { try { return new Date(String(d).replace(' ', 'T') + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; } };
    $('blogHomeGrid').innerHTML = posts.map((p) => `
      <a class="blog-card" href="/blog/${esc(p.slug)}">
        <div class="blog-cover" style="${p.cover_image ? `background-image:url('${esc(p.cover_image)}')` : ''}">${p.cover_image ? '' : '<span></span>'}</div>
        <div class="blog-card-body">
          <h3>${esc(p.title)}</h3>
          <p class="blog-excerpt">${esc(p.excerpt || '')}</p>
          <span class="blog-meta">${esc(p.author || 'Mobirapid')} · ${fmt(p.created_at)}</span>
        </div>
      </a>`).join('');
  }

  function renderAbout(s) {
    const section = $('about');
    if (!s.about_enabled || !(s.about_text || '').trim()) { section.hidden = true; return; }
    section.hidden = false;
    if (s.about_title) $('aboutTitle').textContent = s.about_title;
    $('aboutText').innerHTML = String(s.about_text)
      .split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  }

  function renderContact(s) {
    const section = $('contact');
    if (!s.contact_enabled) { section.hidden = true; return; }
    const I = window.MOBI_ICONS || {};
    const digits = (v) => String(v || '').replace(/[^\d]/g, '');
    // Quick-contact cards (compact row). The address gets its own wide card below.
    const cards = [
      s.social_phone ? { icon: 'phone', tone: 'call', label: 'Call us', value: s.social_phone, href: 'tel:' + s.social_phone.replace(/[^\d+]/g, '') } : null,
      digits(s.social_whatsapp) ? { icon: 'whatsapp', tone: 'wa', label: 'WhatsApp', value: s.social_whatsapp, href: 'https://wa.me/' + digits(s.social_whatsapp) } : null,
      s.social_email ? { icon: 'email', tone: 'mail', label: 'Email', value: s.social_email, href: 'mailto:' + s.social_email } : null,
    ].filter(Boolean);

    // Address block: each office as its own card, with its own map beside it.
    const addr = (s.contact_address || '').trim();
    const mapsUrl = (s.google_maps_url || '').trim();
    // Split "Head Office: … Regional/Branch Office: …" into separate entries.
    const offices = addr
      ? addr.split(/(?=(?:Head|Branch|Regional|Registered|Corporate|Regd\.?)\s+Office\s*:)/i).map((x) => x.trim()).filter(Boolean)
      : [];
    // Map sources. Each field accepts the full <iframe> snippet from Google's
    // "Embed a map", or a plain embed URL. Blank → we build one from the address.
    const mapSrcOf = (raw, place) => {
      let src = String(raw || '').trim();
      const m = src.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);   // pasted iframe HTML
      if (m) src = m[1];
      src = src.replace(/&amp;/g, '&').trim();
      if (/^https:\/\/(www\.)?google\.[^"'<>\s]*\/maps\/embed/i.test(src)) return src;
      if (/^https:\/\/(www\.)?google\.[^"'<>\s]*\/maps\?[^"'<>\s]*output=embed/i.test(src)) return src;
      const p = String(place || '').replace(/\s*—\s*GSTIN:[^,]*/gi, '').trim();
      return p ? 'https://www.google.com/maps?q=' + encodeURIComponent(p.slice(0, 250)) + '&output=embed' : '';
    };

    const map = $('contactMap');
    if (map) { map.hidden = true; map.innerHTML = ''; } // now rendered inside the address card

    if (!cards.length && !addr) { section.hidden = true; return; }
    section.hidden = false;
    if (s.contact_title) $('contactTitle').textContent = s.contact_title;
    $('contactSubtitle').textContent = s.contact_subtitle || '';
    $('contactGrid').innerHTML = cards.map((c) => {
      const inner = `<span class="contact-icon ic-${esc(c.tone || '')}">${I[c.icon] || ''}</span>
        <span class="contact-tx"><span class="contact-label">${esc(c.label)}</span>
        <span class="contact-value">${esc(c.value)}</span></span>`;
      return c.href
        ? `<a class="contact-card" href="${esc(c.href)}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="contact-card">${inner}</div>`;
    }).join('');

    const addrWrap = $('contactAddress');
    if (addrWrap) {
      // Each office gets its own map: the 1st uses the main embed field, the 2nd the second field.
      const embeds = [(s.google_maps_embed || '').trim(), (s.google_maps_embed_2 || '').trim()];
      const entries = (offices.length ? offices : (addr ? [addr] : [])).map((o, i) => {
        const m = o.match(/^((?:Head|Branch|Regional|Registered|Corporate|Regd\.?)\s+Office)\s*:\s*([\s\S]*)$/i);
        const title = m ? m[1] : 'Our office';
        const body = (m ? m[2] : o).replace(/\s*—\s*GSTIN:\s*/i, ' · GSTIN: ').trim();
        return { title, body, src: mapSrcOf(embeds[i] || '', body) };
      });
      if (!entries.length) { addrWrap.hidden = true; addrWrap.innerHTML = ''; }
      else {
        addrWrap.hidden = false;
        addrWrap.innerHTML = entries.map((e) => `
          <div class="addr-card">
            <div class="addr-info">
              <span class="contact-icon ic-map">${I.mappin || ''}</span>
              <span class="contact-label">${esc(e.title)}</span>
              <p class="addr-body">${esc(e.body)}</p>
              ${mapsUrl ? `<a class="addr-link" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Google Maps →</a>` : ''}
            </div>
            ${e.src ? `<div class="addr-map"><iframe src="${esc(e.src)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen title="${esc(e.title)}"></iframe></div>` : ''}
          </div>`).join('');
      }
    }
  }

  function renderSocial(s) {
    const I = window.MOBI_ICONS || {};
    const digits = (v) => String(v || '').replace(/[^\d]/g, '');
    const items = [
      { key: 'instagram', icon: 'instagram', label: 'Instagram', href: s.social_instagram },
      { key: 'facebook', icon: 'facebook', label: 'Facebook', href: s.social_facebook },
      { key: 'linkedin', icon: 'linkedin', label: 'LinkedIn', href: s.social_linkedin },
      { key: 'email', icon: 'email', label: 'Email', href: s.social_email ? 'mailto:' + s.social_email : '' },
      { key: 'phone', icon: 'phone', label: 'Call', href: s.social_phone ? 'tel:' + s.social_phone.replace(/[^\d+]/g, '') : '' },
      { key: 'whatsapp', icon: 'whatsapp', label: 'WhatsApp', href: digits(s.social_whatsapp) ? 'https://wa.me/' + digits(s.social_whatsapp) : '' },
    ].filter((x) => x.href);

    const footer = $('footerSocial');
    if (!items.length) { footer.hidden = true; }
    else {
      footer.hidden = false;
      footer.innerHTML = items.map((x) =>
        `<a class="social-link ${x.key}" href="${esc(x.href)}" target="_blank" rel="noopener" aria-label="${x.label}" title="${x.label}">${I[x.icon] || ''}</a>`
      ).join('');
    }

    // Floating WhatsApp + Call buttons
    const float = $('floatContact');
    const fItems = items.filter((x) => x.key === 'whatsapp' || x.key === 'phone');
    float.innerHTML = fItems.map((x) =>
      `<a class="float-btn ${x.key}" href="${esc(x.href)}" target="_blank" rel="noopener" aria-label="${x.label}" title="${x.label}">${I[x.icon] || ''}</a>`
    ).join('');
  }

  function renderFooter(s, pages) {
    // Brand
    if (s.brand_name) $('footerBrandName').textContent = s.brand_name;
    if (s.logo_path) {
      const l = $('footerLogo'); l.src = s.logo_path; l.alt = s.brand_name || 'Logo'; l.hidden = false;
      $('footerMark').hidden = true; $('footerBrandName').hidden = true;
    }
    if (s.footer_tagline) $('footerTagline').textContent = s.footer_tagline;

    // Policy links
    if (pages && pages.length) {
      $('footerPolicies').innerHTML = pages.map((p) => `<li><a href="/p/${esc(p.slug)}">${esc(p.title)}</a></li>`).join('');
    }

    // Reach us
    const tel = (v) => 'tel:' + String(v).replace(/[^\d+]/g, '');
    const phone = (s.customer_care_phone || s.social_phone || '').trim();
    const email = (s.customer_care_email || s.social_email || '').trim();
    const reach = [];
    if (phone) reach.push(`<li><a href="${tel(phone)}">${esc(phone)}</a></li>`);
    if (email) reach.push(`<li><a href="mailto:${esc(email)}">${esc(email)}</a></li>`);
    if ((s.registered_address || '').trim()) reach.push(`<li>${esc(s.registered_address)}</li>`);
    $('footerContact').innerHTML = reach.join('');

    // Grievance Officer (IT Rules 2021 / Consumer Protection E-Commerce Rules 2020)
    const gName = (s.grievance_officer_name || '').trim();
    const gEmail = (s.grievance_officer_email || '').trim();
    const gPhone = (s.grievance_officer_phone || '').trim();
    const gEl = $('footerGrievance');
    if (gName || gEmail) {
      let g = '<h4>Grievance Officer</h4><p>';
      if (gName) g += esc(gName) + '<br>';
      if (gEmail) g += `<a href="mailto:${esc(gEmail)}">${esc(gEmail)}</a>`;
      if (gPhone) g += `<br><a href="${tel(gPhone)}">${esc(gPhone)}</a>`;
      g += '</p>';
      gEl.hidden = false; gEl.innerHTML = g;
    } else { gEl.hidden = true; gEl.innerHTML = ''; }

    // Trust / recognition logos strip
    const ft = $('footerTrust');
    if (ft) {
      let logos = [];
      try { logos = JSON.parse(s.trust_logos || '[]') || []; } catch { logos = []; }
      logos = logos.filter((l) => l && ((l.label || '').trim() || l.image));
      if (!logos.length) logos = [{ label: 'Startup India' }, { label: 'iStart Rajasthan' }, { label: 'Ingram Micro' }];
      ft.hidden = false;
      ft.innerHTML = `<div class="container footer-trust-inner"><span class="ft-label">Recognised &amp; partnered with</span>${logos.map((l) => l.image
        ? `<span class="ft-logo"><img src="${esc(l.image)}" alt="${esc(l.label || 'Partner logo')}" loading="lazy"></span>`
        : `<span class="ft-badge">${esc(l.label)}</span>`).join('')}</div>`;
    }

    // Bottom legal bar
    const year = new Date().getFullYear();
    const legalName = (s.legal_name || s.brand_name || 'Mobirapid').trim();
    $('footerCopy').textContent = `© ${year} ${legalName}. All rights reserved.`;
    $('footerLegal').textContent = (s.gstin || '').trim() ? 'GSTIN: ' + s.gstin : '';
  }

  // ---- Cookie consent (DPDP Act, 2023) ----
  function initCookie() {
    const b = $('cookieBanner');
    if (!b) return;
    let stored = null;
    try { stored = localStorage.getItem('mobirapid_consent'); } catch (e) {}
    if (stored) return;
    b.hidden = false;
    document.body.classList.add('cookie-open');
    const close = (v) => {
      try { localStorage.setItem('mobirapid_consent', v); } catch (e) {}
      b.hidden = true; document.body.classList.remove('cookie-open');
    };
    $('cookieAccept').addEventListener('click', () => close('accepted'));
    $('cookieDecline').addEventListener('click', () => close('declined'));
  }

  // ========================================================================
  // Conditional company fields
  // ========================================================================
  clientType.addEventListener('change', () => {
    const isCompany = clientType.value === 'Company';
    companyFields.hidden = !isCompany;
    companyName.required = isCompany;
    companyEmail.required = isCompany;
    if (!isCompany) { companyName.value = ''; companyEmail.value = ''; }
  });

  // ========================================================================
  // OTP flow
  // ========================================================================
  function setStatus(msg, type) {
    status.textContent = msg || '';
    status.className = 'form-status' + (type ? ' ' + type : '');
  }
  function lockSubmit() {
    submitBtn.disabled = !phoneVerified;
    submitBtn.textContent = ctaText;
  }
  phone.addEventListener('input', () => {
    if (phoneVerified) { phoneVerified = false; otpField.classList.remove('verified'); lockSubmit(); }
  });
  function startResendCountdown() {
    let s = 30; sendOtpBtn.disabled = true;
    const tick = () => {
      sendOtpBtn.textContent = `Resend (${s}s)`;
      if (s <= 0) { clearInterval(resendTimer); sendOtpBtn.disabled = false; sendOtpBtn.textContent = 'Resend code'; return; }
      s--;
    };
    tick(); resendTimer = setInterval(tick, 1000);
  }
  sendOtpBtn.addEventListener('click', async () => {
    const val = phone.value.trim();
    if (!val) { setStatus('Please enter your phone number first.', 'err'); phone.focus(); return; }
    sendOtpBtn.disabled = true; setStatus('Sending code…', '');
    try {
      const r = await fetch('/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: val }) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Could not send code.');
      otpField.hidden = false; otpInput.focus();
      otpHint.textContent = data.mock ? 'Demo mode: the code is printed in the server console.' : 'Code sent by SMS. It may take a few seconds.';
      setStatus('Verification code sent to ' + val + '.', 'ok');
      startResendCountdown();
    } catch (e) { setStatus(e.message, 'err'); sendOtpBtn.disabled = false; }
  });
  verifyOtpBtn.addEventListener('click', async () => {
    const code = otpInput.value.trim();
    if (!code) { setStatus('Enter the code you received.', 'err'); return; }
    verifyOtpBtn.disabled = true; setStatus('Verifying…', '');
    try {
      const r = await fetch('/api/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone.value.trim(), code }) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Verification failed.');
      phoneVerified = true; otpField.classList.add('verified');
      verifyOtpBtn.textContent = '✓ Verified'; otpInput.disabled = true; sendOtpBtn.disabled = true;
      if (resendTimer) clearInterval(resendTimer); sendOtpBtn.textContent = 'Verified';
      setStatus('Phone verified. You can submit your request now.', 'ok');
      lockSubmit();
    } catch (e) { setStatus(e.message, 'err'); verifyOtpBtn.disabled = false; }
  });

  // ========================================================================
  // Submit
  // ========================================================================
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!phoneVerified) { setStatus('Please verify your phone number first.', 'err'); return; }
    if ($('consent') && !$('consent').checked) { setStatus('Please tick the consent box so we can process your enquiry (required under the DPDP Act).', 'err'); $('consent').focus(); return; }
    if (!form.checkValidity()) { form.reportValidity(); return; }

    const getCookie = (n) => { const m = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)'); return m ? m.pop() : ''; };
    const eventId = 'lead.' + Date.now() + '.' + Math.random().toString(36).slice(2, 10);
    const best_time = bestTimeSel.value;
    const payload = {
      name: $('name').value.trim(),
      phone: phone.value.trim(),
      client_type: clientType.value,
      company_name: companyName.value.trim(),
      company_email: companyEmail.value.trim(),
      requirement: $('requirement').value,
      budget: $('budget').value,
      best_time,
      call_type: (document.querySelector('input[name="call_type"]:checked') || {}).value || '',
      interested_model: ($('interested_model') || {}).value || '',
      message: $('message').value.trim(),
      event_id: eventId,
      fbp: getCookie('_fbp'),
      fbc: getCookie('_fbc'),
      consent: $('consent') ? $('consent').checked : false,
    };

    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; setStatus('', '');
    try {
      const r = await fetch('/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Something went wrong.');
      form.reset(); otpField.hidden = true; companyFields.hidden = true; phoneVerified = false;
      setStatus(data.message, 'ok'); submitBtn.textContent = 'Request received ✓';
      // Fire conversion events (only if the respective tag is installed)
      try { if (window.fbq) window.fbq('track', 'Lead', { content_name: 'Consultation request' }, { eventID: eventId }); } catch (e) {}
      try { if (window.gtag) window.gtag('event', 'generate_lead', { event_category: 'lead' }); } catch (e) {}
      try { (window.dataLayer = window.dataLayer || []).push({ event: 'lead_submitted' }); } catch (e) {}
    } catch (err) {
      setStatus(err.message, 'err'); submitBtn.disabled = false; submitBtn.textContent = ctaText;
    }
  });

  // ---- Auto-scrolling carousel (right → left) with arrows ----
  function setupCarousel(id) {
    const track = document.getElementById(id);
    if (!track || track.dataset.carInit === '1') return;
    const cards = Array.from(track.children);
    if (!cards.length) return;
    if (track.offsetParent === null) return; // section not visible yet
    track.dataset.carInit = '1';

    const viewport = track.parentElement;
    const carousel = viewport.parentElement;
    const GAP = 24;
    const cardW = cards[0].getBoundingClientRect().width + GAP;

    // Duplicate cards for a seamless loop
    cards.forEach((c) => track.appendChild(c.cloneNode(true)));
    let half = track.scrollWidth / 2;
    window.addEventListener('resize', () => { half = track.scrollWidth / 2; });

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let paused = false, resumeT;

    if (!reduce) {
      const step = () => {
        if (!paused) {
          viewport.scrollLeft += 0.9;            // content drifts right → left
          if (viewport.scrollLeft >= half) viewport.scrollLeft -= half;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      viewport.addEventListener('mouseenter', () => { paused = true; });
      viewport.addEventListener('mouseleave', () => { paused = false; });
      viewport.addEventListener('touchstart', () => { paused = true; }, { passive: true });
      viewport.addEventListener('touchend', () => { clearTimeout(resumeT); resumeT = setTimeout(() => { paused = false; }, 2500); });
    }

    function nudge(dir) {
      paused = true;
      if (dir < 0 && viewport.scrollLeft < cardW) viewport.scrollLeft += half; // wrap before going left
      viewport.scrollBy({ left: dir * cardW, behavior: 'smooth' });
      setTimeout(() => { if (viewport.scrollLeft >= half) viewport.scrollLeft -= half; }, 420);
      if (!reduce) { clearTimeout(resumeT); resumeT = setTimeout(() => { paused = false; }, 3000); }
    }
    const prev = carousel.querySelector('.car-prev');
    const next = carousel.querySelector('.car-next');
    if (prev) prev.addEventListener('click', () => nudge(-1));
    if (next) next.addEventListener('click', () => nudge(1));
  }

  // ---- Scroll reveal animations ----
  function initReveal() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const sel = '.usp-card, .step, .reviews-head, .section-sub, .usps h2, .models h2, .how h2, .about-inner, .contact-grid > *, .qc-card, .qc-video, .faq-item, .qc h2, .faq h2';
    const els = Array.from(document.querySelectorAll(sel)).filter((e) => !e.classList.contains('reveal'));
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('reveal', 'in')); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    els.forEach((e, i) => { e.classList.add('reveal'); e.style.transitionDelay = (i % 3) * 90 + 'ms'; io.observe(e); });
  }

  // ---- Engagement tracking (reduces "bounce" by recording real interactions) ----
  function track(name, params) {
    try { if (window.gtag) window.gtag('event', name, params || {}); } catch (e) {}
    try { if (window.fbq) window.fbq('trackCustom', name, params || {}); } catch (e) {}
    try { (window.dataLayer = window.dataLayer || []).push(Object.assign({ event: name }, params || {})); } catch (e) {}
  }
  const _sd = {};
  window.addEventListener('scroll', () => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    if (h <= 0) return;
    const pct = Math.round((window.scrollY / h) * 100);
    [25, 50, 75, 90].forEach((t) => { if (pct >= t && !_sd[t]) { _sd[t] = 1; track('scroll_depth', { percent: t }); } });
  }, { passive: true });
  setTimeout(() => track('engaged_time', { seconds: 15 }), 15000);
  let _firstInteract = false;
  const flagInteract = (what) => { if (_firstInteract) return; _firstInteract = true; track('form_interaction', { field: what }); };
  if (sendOtpBtn) sendOtpBtn.addEventListener('click', () => flagInteract('send_code'));
  if ($('name')) $('name').addEventListener('focus', () => flagInteract('name'), { once: true });

  // Call-type selector icons
  const _ci = window.MOBI_ICONS || {};
  if ($('ctPhoneIc')) $('ctPhoneIc').innerHTML = _ci.phone || '';
  if ($('ctVideoIc')) $('ctVideoIc').innerHTML = _ci.videocall || '';

  lockSubmit();
  loadSite().then(initReveal);
  initReveal();
  initCookie();
})();
