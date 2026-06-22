(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ARRAY_KEYS = ['trust_points', 'requirement_options', 'budget_options'];

  // ---------- Tabs ----------
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('panel-' + t.dataset.tab).classList.add('active');
    });
  });

  async function api(url, opts) {
    const r = await fetch(url, opts);
    if (r.status === 401) { location.href = '/admin/login'; throw new Error('Not authenticated'); }
    return r;
  }
  function flash(el) { el.hidden = false; setTimeout(() => (el.hidden = true), 2000); }

  // ---------- Image upload helper ----------
  async function uploadImage(fileInput) {
    if (!fileInput.files || !fileInput.files[0]) { alert('Choose a file first.'); return null; }
    const fd = new FormData();
    fd.append('image', fileInput.files[0]);
    const r = await api('/api/admin/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!data.ok) { alert(data.error || 'Upload failed.'); return null; }
    return data.path;
  }

  // ========================================================================
  // LEADS
  // ========================================================================
  let allLeads = [];
  function fmtDate(s) { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString(); }
  function renderLeads() {
    const q = $('search').value.toLowerCase();
    const fr = $('filterReq').value, ft = $('filterType').value;
    const rows = allLeads.filter((l) => {
      if (fr && l.requirement !== fr) return false;
      if (ft && l.client_type !== ft) return false;
      if (q && !(`${l.name} ${l.phone} ${l.company_name} ${l.company_email} ${l.message} ${l.budget}`.toLowerCase().includes(q))) return false;
      return true;
    });
    $('emptyState').hidden = rows.length > 0;
    $('rows').innerHTML = rows.map((l) => `
      <tr>
        <td>${l.id}</td>
        <td><strong>${esc(l.name)}</strong></td>
        <td>${esc(l.phone)} ${l.phone_verified ? '<span class="verified" title="Verified">✓</span>' : ''}</td>
        <td>${l.client_type ? `<span class="pill type">${esc(l.client_type)}</span>` : '—'}</td>
        <td>${l.company_name ? `${esc(l.company_name)}<br><small>${esc(l.company_email || '')}</small>` : '—'}</td>
        <td>${l.requirement ? `<span class="pill req">${esc(l.requirement)}</span>` : '—'}</td>
        <td>${esc(l.budget) || '—'}</td>
        <td>${esc(l.best_time) || '—'}</td>
        <td class="msg">${esc(l.message) || '—'}</td>
        <td>${fmtDate(l.created_at)}</td>
      </tr>`).join('');
  }
  function updateStats() {
    const today = new Date().toISOString().slice(0, 10);
    $('statTotal').textContent = allLeads.length;
    $('statToday').textContent = allLeads.filter((l) => (l.created_at || '').slice(0, 10) === today).length;
    $('statCompany').textContent = allLeads.filter((l) => l.client_type === 'Company').length;
    $('statIndividual').textContent = allLeads.filter((l) => l.client_type === 'Individual').length;
  }
  async function loadLeads() {
    const r = await api('/api/admin/leads');
    const data = await r.json();
    allLeads = data.leads || [];
    updateStats(); renderLeads();
  }
  $('search').addEventListener('input', renderLeads);
  $('filterReq').addEventListener('change', renderLeads);
  $('filterType').addEventListener('change', renderLeads);
  $('refreshLeads').addEventListener('click', loadLeads);

  // ========================================================================
  // SETTINGS (branding + options)
  // ========================================================================
  let settings = {};
  function fillSettingsForm() {
    document.querySelectorAll('[id^="set-"]').forEach((el) => {
      const key = el.id.slice(4);
      let val = settings[key] ?? '';
      if (ARRAY_KEYS.includes(key)) {
        try { val = (JSON.parse(val) || []).join('\n'); } catch { val = ''; }
      }
      el.value = val;
    });
    // populate leads requirement filter from options
    let reqs = [];
    try { reqs = JSON.parse(settings.requirement_options || '[]'); } catch {}
    $('filterReq').innerHTML = '<option value="">All requirements</option>' + reqs.map((o) => `<option>${esc(o)}</option>`).join('');
    // image previews
    if (settings.logo_path) showPrev($('logoPrev'), settings.logo_path);
    if (settings.banner_image) showPrev($('bannerPrev'), settings.banner_image);
    // USP rows
    try { uspItems = JSON.parse(settings.usps || '[]'); } catch { uspItems = []; }
    renderUspRows();
  }

  // ---- USP strip editor ----
  let uspItems = [];
  function renderUspRows() {
    const wrap = $('uspRows'); if (!wrap) return;
    const icons = window.MOBI_ICONS || {};
    const list = window.MOBI_ICON_LIST || [];
    wrap.innerHTML = uspItems.map((u, i) => {
      const prev = u.image
        ? `<img src="${esc(u.image)}" alt="" style="width:26px;height:26px;object-fit:contain;" />`
        : (icons[u.icon] || '');
      return `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);">
        <span style="flex:0 0 auto;display:inline-grid;place-items:center;width:40px;height:40px;border-radius:10px;background:rgba(37,99,235,0.1);color:var(--brand);overflow:hidden;">${prev}</span>
        <select data-uicon="${i}" style="width:150px;" ${u.image ? 'disabled title="Using uploaded image"' : ''}>${list.map(([k, l]) => `<option value="${k}" ${k === u.icon ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="text" data-utitle="${i}" value="${esc(u.title || '')}" placeholder="USP text" style="flex:1;min-width:150px;" />
        <input type="text" data-unote="${i}" value="${esc(u.note || '')}" placeholder="note (optional)" style="width:130px;" />
        <input type="file" data-ufile="${i}" accept="image/*" style="width:150px;" />
        <button class="btn small" data-uupload="${i}" type="button">Upload icon</button>
        ${u.image ? `<button class="btn small" data-uclear="${i}" type="button" title="Use built-in icon instead">Use icon</button>` : ''}
        <button class="btn small danger" data-urem="${i}" type="button">Remove</button>
      </div>`;
    }).join('');
    wrap.querySelectorAll('[data-uicon]').forEach((el) => el.addEventListener('change', () => { uspItems[+el.dataset.uicon].icon = el.value; renderUspRows(); }));
    wrap.querySelectorAll('[data-utitle]').forEach((el) => el.addEventListener('input', () => { uspItems[+el.dataset.utitle].title = el.value; }));
    wrap.querySelectorAll('[data-unote]').forEach((el) => el.addEventListener('input', () => { uspItems[+el.dataset.unote].note = el.value; }));
    wrap.querySelectorAll('[data-uupload]').forEach((el) => el.addEventListener('click', async () => {
      const i = +el.dataset.uupload;
      const p = await uploadImage(wrap.querySelector(`[data-ufile="${i}"]`));
      if (!p) return;
      uspItems[i].image = p; renderUspRows();
    }));
    wrap.querySelectorAll('[data-uclear]').forEach((el) => el.addEventListener('click', () => { uspItems[+el.dataset.uclear].image = ''; renderUspRows(); }));
    wrap.querySelectorAll('[data-urem]').forEach((el) => el.addEventListener('click', () => { uspItems.splice(+el.dataset.urem, 1); renderUspRows(); }));
  }
  $('addUspBtn').addEventListener('click', () => { uspItems.push({ icon: 'star', title: '', note: '', image: '' }); renderUspRows(); });
  function showPrev(img, src) { img.src = src; img.style.display = 'block'; }

  function collectSettings(keys) {
    const out = {};
    keys.forEach((key) => {
      const el = $('set-' + key);
      if (!el) return;
      if (ARRAY_KEYS.includes(key)) out[key] = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
      else out[key] = el.value;
    });
    return out;
  }
  async function saveSettings(payload, savedEl) {
    const r = await api('/api/admin/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (data.ok) { Object.assign(settings, normalize(payload)); flash(savedEl); }
    else alert(data.error || 'Save failed.');
  }
  function normalize(payload) {
    const out = {};
    for (const [k, v] of Object.entries(payload)) out[k] = Array.isArray(v) ? JSON.stringify(v) : v;
    return out;
  }
  async function loadSettings() {
    const r = await api('/api/admin/settings');
    const data = await r.json();
    settings = data.settings || {};
    fillSettingsForm();
  }

  // Branding save (all branding keys + uploaded image paths)
  $('saveBranding').addEventListener('click', () => {
    const keys = ['brand_name', 'header_cta_text', 'banner_eyebrow', 'banner_heading', 'banner_subtext', 'trust_points', 'models_title', 'models_subtitle', 'usps_enabled', 'usps_title', 'about_enabled', 'about_title', 'about_text', 'contact_enabled', 'contact_title', 'contact_subtitle', 'contact_address', 'google_maps_url', 'google_maps_embed', 'footer_tagline', 'legal_name', 'gstin', 'registered_address', 'customer_care_email', 'customer_care_phone', 'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone', 'social_instagram', 'social_facebook', 'social_linkedin', 'social_email', 'social_phone', 'social_whatsapp', 'footer_text', 'footer_email'];
    const payload = collectSettings(keys);
    payload.logo_path = settings.logo_path || '';
    payload.banner_image = settings.banner_image || '';
    // USP items (icon strip) — stored as a JSON string
    payload.usps = JSON.stringify(
      uspItems
        .filter((u) => (u.title || '').trim())
        .map((u) => ({ icon: u.icon || 'star', title: u.title.trim(), note: (u.note || '').trim(), image: u.image || '' }))
    );
    saveSettings(payload, $('brandingSaved'));
  });
  $('logoUploadBtn').addEventListener('click', async () => {
    const p = await uploadImage($('logoFile')); if (!p) return;
    settings.logo_path = p; showPrev($('logoPrev'), p);
    await saveSettings({ logo_path: p }, $('brandingSaved'));
  });
  $('bannerUploadBtn').addEventListener('click', async () => {
    const p = await uploadImage($('bannerFile')); if (!p) return;
    settings.banner_image = p; showPrev($('bannerPrev'), p);
    await saveSettings({ banner_image: p }, $('brandingSaved'));
  });

  // Remove (delete) current logo / banner image
  async function removeImage(key, prevEl, fileEl) {
    if (!confirm('Remove this image?')) return;
    const old = settings[key];
    if (old && old.indexOf('/uploads/') === 0) {
      try {
        await api('/api/admin/upload/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: old }) });
      } catch (e) { /* ignore */ }
    }
    settings[key] = '';
    if (prevEl) prevEl.style.display = 'none';
    if (fileEl) fileEl.value = '';
    await saveSettings({ [key]: '' }, $('brandingSaved'));
  }
  $('logoRemoveBtn').addEventListener('click', () => removeImage('logo_path', $('logoPrev'), $('logoFile')));
  $('bannerRemoveBtn').addEventListener('click', () => removeImage('banner_image', $('bannerPrev'), $('bannerFile')));

  // Options save
  $('saveOptions').addEventListener('click', () => {
    saveSettings(collectSettings(['requirement_options', 'budget_options']), $('optionsSaved'));
    // refresh leads filter after save
    setTimeout(loadSettings, 300);
  });

  // ========================================================================
  // MODELS
  // ========================================================================
  let models = [];
  async function loadModels() {
    const r = await api('/api/admin/models');
    const data = await r.json();
    models = data.models || [];
    renderModelsList();
  }
  function renderModelsList() {
    if (!models.length) { $('modelsList').innerHTML = '<p class="muted" style="padding:14px 0;">No models yet. Click “Add model”.</p>'; return; }
    $('modelsList').innerHTML = models.map((m) => `
      <div class="model-row">
        <div class="model-thumb" style="${m.image ? `background-image:url('${esc(m.image)}')` : ''}"></div>
        <div class="info">
          <b>${esc(m.name)} ${m.active ? '' : '<span class="inactive-tag">(hidden)</span>'}</b>
          <small>${[m.specs, m.price, m.badge, m.condition_grade].filter(Boolean).map(esc).join(' · ')}</small>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn small" data-edit="${m.id}">Edit</button>
          <button class="btn small danger" data-del="${m.id}">Delete</button>
        </div>
      </div>`).join('');
    $('modelsList').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openModel(b.dataset.edit)));
    $('modelsList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delModel(b.dataset.del)));
  }
  const dlg = $('modelDialog');
  function openModel(id) {
    const m = id ? models.find((x) => String(x.id) === String(id)) : null;
    $('modelDlgTitle').textContent = m ? 'Edit model' : 'Add model';
    $('m-id').value = m ? m.id : '';
    ['name', 'price', 'specs', 'badge', 'condition_grade', 'warranty', 'image', 'sort_order'].forEach((f) => { $('m-' + f).value = m ? (m[f] ?? '') : (f === 'sort_order' ? models.length + 1 : ''); });
    $('m-active').value = m ? String(m.active) : '1';
    const prev = $('m-imagePrev');
    if (m && m.image) showPrev(prev, m.image); else prev.style.display = 'none';
    $('m-imageFile').value = '';
    dlg.showModal();
  }
  $('addModelBtn').addEventListener('click', () => openModel(null));
  $('modelCancel').addEventListener('click', () => dlg.close());
  $('m-uploadBtn').addEventListener('click', async () => {
    const p = await uploadImage($('m-imageFile')); if (!p) return;
    $('m-image').value = p; showPrev($('m-imagePrev'), p);
  });
  $('modelSave').addEventListener('click', async () => {
    const id = $('m-id').value;
    const payload = {
      name: $('m-name').value.trim(), price: $('m-price').value.trim(), specs: $('m-specs').value.trim(),
      badge: $('m-badge').value, condition_grade: $('m-condition_grade').value.trim(),
      warranty: $('m-warranty').value.trim(), image: $('m-image').value.trim(),
      sort_order: parseInt($('m-sort_order').value || '0', 10), active: $('m-active').value,
    };
    if (!payload.name) { alert('Model name is required.'); return; }
    const r = await api(id ? '/api/admin/models/' + id : '/api/admin/models', {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) { alert(data.error || 'Save failed.'); return; }
    dlg.close(); loadModels();
  });
  async function delModel(id) {
    if (!confirm('Delete this model?')) return;
    await api('/api/admin/models/' + id, { method: 'DELETE' });
    loadModels();
  }

  // ========================================================================
  // GOOGLE REVIEWS
  // ========================================================================
  $('saveReviewSettings').addEventListener('click', () => {
    saveSettings(collectSettings(['reviews_enabled', 'reviews_title', 'google_reviews_url', 'google_rating', 'google_review_count']), $('reviewSettingsSaved'));
  });

  let reviews = [];
  async function loadReviews() {
    const r = await api('/api/admin/reviews');
    const data = await r.json();
    reviews = data.reviews || [];
    renderReviewsList();
  }
  function renderReviewsList() {
    if (!reviews.length) { $('reviewsList').innerHTML = '<p class="muted" style="padding:14px 0;">No reviews yet. Click “Add review”.</p>'; return; }
    $('reviewsList').innerHTML = reviews.map((r) => `
      <div class="model-row">
        <div style="font-size:0.95rem;color:#fbbc04;letter-spacing:1px;">${'★'.repeat(r.rating)}</div>
        <div class="info">
          <b>${esc(r.author)} ${r.active ? '' : '<span class="inactive-tag">(hidden)</span>'}</b>
          <small>${esc((r.text || '').slice(0, 90))}${(r.text || '').length > 90 ? '…' : ''}</small>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn small" data-redit="${r.id}">Edit</button>
          <button class="btn small danger" data-rdel="${r.id}">Delete</button>
        </div>
      </div>`).join('');
    $('reviewsList').querySelectorAll('[data-redit]').forEach((b) => b.addEventListener('click', () => openReview(b.dataset.redit)));
    $('reviewsList').querySelectorAll('[data-rdel]').forEach((b) => b.addEventListener('click', () => delReview(b.dataset.rdel)));
  }
  const rdlg = $('reviewDialog');
  function openReview(id) {
    const r = id ? reviews.find((x) => String(x.id) === String(id)) : null;
    $('reviewDlgTitle').textContent = r ? 'Edit review' : 'Add review';
    $('r-id').value = r ? r.id : '';
    ['author', 'text', 'date_label', 'sort_order'].forEach((f) => { $('r-' + f).value = r ? (r[f] ?? '') : (f === 'sort_order' ? reviews.length + 1 : ''); });
    $('r-rating').value = r ? String(r.rating) : '5';
    $('r-active').value = r ? String(r.active) : '1';
    rdlg.showModal();
  }
  $('addReviewBtn').addEventListener('click', () => openReview(null));
  $('reviewCancel').addEventListener('click', () => rdlg.close());
  $('reviewSave').addEventListener('click', async () => {
    const id = $('r-id').value;
    const payload = {
      author: $('r-author').value.trim(), rating: $('r-rating').value, text: $('r-text').value.trim(),
      date_label: $('r-date_label').value.trim(), sort_order: parseInt($('r-sort_order').value || '0', 10), active: $('r-active').value,
    };
    if (!payload.author) { alert('Reviewer name is required.'); return; }
    const r = await api(id ? '/api/admin/reviews/' + id : '/api/admin/reviews', {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) { alert(data.error || 'Save failed.'); return; }
    rdlg.close(); loadReviews();
  });
  async function delReview(id) {
    if (!confirm('Delete this review?')) return;
    await api('/api/admin/reviews/' + id, { method: 'DELETE' });
    loadReviews();
  }

  // ========================================================================
  // PAGES
  // ========================================================================
  let pages = [];
  async function loadPages() {
    const r = await api('/api/admin/pages');
    const data = await r.json();
    pages = data.pages || [];
    $('pageSelect').innerHTML = pages.map((p) => `<option value="${esc(p.slug)}">${esc(p.title)}</option>`).join('');
    if (pages.length) selectPage(pages[0].slug);
  }
  function selectPage(slug) {
    const p = pages.find((x) => x.slug === slug); if (!p) return;
    $('pageSelect').value = slug;
    $('pageTitle').value = p.title;
    $('pageContent').value = p.content || '';
    $('viewPageLink').href = '/p/' + slug;
  }
  $('pageSelect').addEventListener('change', (e) => selectPage(e.target.value));
  $('savePage').addEventListener('click', async () => {
    const slug = $('pageSelect').value;
    const r = await api('/api/admin/pages/' + slug, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: $('pageTitle').value.trim(), content: $('pageContent').value }),
    });
    const data = await r.json();
    if (data.ok) {
      const p = pages.find((x) => x.slug === slug);
      if (p) { p.title = $('pageTitle').value.trim(); p.content = $('pageContent').value; }
      flash($('pageSaved'));
    } else alert(data.error || 'Save failed.');
  });

  // ---------- Init ----------
  loadSettings().then(loadLeads);
  loadModels();
  loadReviews();
  loadPages();
})();
