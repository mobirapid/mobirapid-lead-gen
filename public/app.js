(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
      applySettings(data.settings);
      renderUsps(data.settings);
      renderDeal(data.settings, data.models);
      renderModels(data.models, data.settings);
      renderReviews(data.reviews, data.settings);
      renderQc(data.settings);
      renderFaq(data.settings);
      renderBlog(data.settings, data.posts);
      applyModelParam(data.models);
      renderAbout(data.settings);
      renderContact(data.settings);
      renderSocial(data.settings);
      renderFooter(data.settings, data.pages);
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
    const hidden = $('interested_model');
    if (hidden) hidden.value = m.name;
    const note = $('modelNote');
    if (note) {
      note.innerHTML = 'Enquiring about: <strong>' + esc(m.name) + '</strong>';
      note.hidden = false;
    }
    const form = document.getElementById('lead-form') || document.getElementById('leadForm');
    if (form && form.scrollIntoView) {
      setTimeout(() => form.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
    }
  }

  function renderDeal(s, models) {
    const section = $('dealSection');
    if (!section) return;
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
    if (!reserveAmt && price && num(price) > 0) reserveAmt = '₹' + Math.round(num(price) * 0.1).toLocaleString('en-IN');
    const reserveUrl = (s.offer_reserve_url || '').trim();

    const actions = soldOut
      ? `<span class="deal-soldout">Sold out — <a href="#lead-form" class="deal-notify">notify me of similar deals</a></span>`
      : `<a class="deal-book" href="#lead-form" data-deal-model="${esc(m.name)}" data-video="1">📹 Book a video call</a>
         ${reserveAmt ? `<a class="deal-reserve" ${reserveUrl ? `href="${esc(reserveUrl)}" target="_blank" rel="noopener"` : `href="#lead-form"`} data-deal-model="${esc(m.name)}" data-reserve="${esc(reserveAmt)}">Reserve with ${esc(reserveAmt)}</a>` : ''}
         <a class="deal-view" href="/macbook/${esc(m.slug)}">View full specs</a>`;

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

  function renderModels(models, s) {
    const section = $('modelsSection');
    if (!models || !models.length) { section.hidden = true; return; }
    section.hidden = false;
    if (s.models_title) $('modelsTitle').textContent = s.models_title;
    $('modelsSubtitle').textContent = s.models_subtitle || '';
    $('modelsGrid').innerHTML = models.map((m) => {
      const badge = m.badge ? `<span class="model-badge ${/sold/i.test(m.badge) ? 'soldout' : /hot/i.test(m.badge) ? 'hot' : 'avail'}">${esc(m.badge)}</span>` : '';
      const img = m.image
        ? `<div class="model-img" style="background-image:url('${esc(m.image)}')">${badge}</div>`
        : `<div class="model-img placeholder">${badge}<span></span></div>`;
      return `<article class="model-card">
        ${img}
        <div class="model-body">
          <h3>${esc(m.name)}</h3>
          ${m.specs ? `<p class="model-specs">${esc(m.specs)}</p>` : ''}
          ${m.description ? `<p class="model-desc">${esc(m.description)}</p>` : ''}
          <div class="model-meta">
            ${m.price ? `<span class="model-price">${esc(m.price)}</span>` : ''}
            ${m.price && s.price_note ? `<span class="model-gst">${esc(s.price_note)}</span>` : ''}
            ${m.condition_grade ? `<span class="model-grade">${esc(m.condition_grade)}</span>` : ''}
          </div>
          ${m.warranty ? `<p class="model-warranty">${esc(m.warranty)}</p>` : ''}
          <a class="model-cta" href="${m.slug ? '/macbook/' + esc(m.slug) : '#lead-form'}">View details →</a>
        </div>
      </article>`;
    }).join('');
    const note = $('modelsNote');
    if (note) {
      if (s.price_note) {
        note.hidden = false;
        note.textContent = `All prices are exclusive of GST (${esc(s.price_note).replace(/[^0-9%]/g, '') || '18%'}). A GST invoice with serial number is provided with every purchase.`;
      } else { note.hidden = true; }
    }
    setupCarousel('modelsGrid');
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
    const cards = [
      s.social_phone ? { icon: 'phone', label: 'Call us', value: s.social_phone, href: 'tel:' + s.social_phone.replace(/[^\d+]/g, '') } : null,
      digits(s.social_whatsapp) ? { icon: 'whatsapp', label: 'WhatsApp', value: s.social_whatsapp, href: 'https://wa.me/' + digits(s.social_whatsapp) } : null,
      s.social_email ? { icon: 'email', label: 'Email', value: s.social_email, href: 'mailto:' + s.social_email } : null,
      ((s.contact_address || '').trim() || (s.google_maps_url || '').trim())
        ? { icon: 'mappin', label: 'Visit us', value: s.contact_address || 'View on Google Maps', href: (s.google_maps_url || '').trim() }
        : null,
    ].filter(Boolean);

    // Embedded Google Map (optional)
    const map = $('contactMap');
    const embed = (s.google_maps_embed || '').trim();
    if (embed && /^https:\/\/(www\.)?google\.[^"'<>]*\/maps/.test(embed)) {
      map.hidden = false;
      map.innerHTML = `<iframe src="${esc(embed)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen title="Mobirapid location"></iframe>`;
    } else { map.hidden = true; map.innerHTML = ''; }

    if (!cards.length && map.hidden) { section.hidden = true; return; }
    section.hidden = false;
    if (s.contact_title) $('contactTitle').textContent = s.contact_title;
    $('contactSubtitle').textContent = s.contact_subtitle || '';
    $('contactGrid').innerHTML = cards.map((c) => {
      const inner = `<span class="contact-icon">${I[c.icon] || ''}</span>
        <span class="contact-label">${esc(c.label)}</span>
        <span class="contact-value">${esc(c.value)}</span>`;
      return c.href
        ? `<a class="contact-card" href="${esc(c.href)}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="contact-card">${inner}</div>`;
    }).join('');
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
