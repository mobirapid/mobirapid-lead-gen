(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ARRAY_KEYS = ['trust_points', 'requirement_options', 'budget_options'];
  let userRole = 'admin';
  let userScope = null;
  let cats = [];
  const canEditLeads = () => userRole === 'admin';

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
    if (r.status === 401) { location.href = '/manage/login'; throw new Error('Not authenticated'); }
    return r;
  }
  function flash(el) { el.hidden = false; setTimeout(() => (el.hidden = true), 2000); }

  // ---------- Image upload helper ----------
  async function uploadImage(fileInput) {
    if (!fileInput.files || !fileInput.files[0]) { alert('Choose a file first.'); return null; }
    return uploadOneFile(fileInput.files[0]);
  }
  async function uploadOneFile(file) {
    const fd = new FormData();
    fd.append('image', file);
    const r = await api('/api/admin/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!data.ok) { alert(data.error || 'Upload failed.'); return null; }
    return data.path;
  }

  // ========================================================================
  // LEADS
  // ========================================================================
  let allLeads = [];
  let leadStatusList = ['New', 'Contacted', 'Converted', 'Lost'];
  // Requirement filter = configured options + any value actually present on leads
  // (e.g. "Partner application", which comes from the /partner form, not the options list).
  function fillReqFilter() {
    const sel = $('filterReq'); if (!sel) return;
    let reqs = [];
    try { reqs = JSON.parse(settings.requirement_options || '[]') || []; } catch { reqs = []; }
    const fromLeads = [...new Set(allLeads.map((l) => (l.requirement || '').trim()).filter(Boolean))];
    const all = [...new Set([...reqs, ...fromLeads])];
    const cur = sel.value;
    sel.innerHTML = '<option value="">All requirements</option>' + all.map((o) => `<option>${esc(o)}</option>`).join('');
    if (cur && all.includes(cur)) sel.value = cur;
  }
  // Fill the status filter + lead-dialog dropdowns from the configured status list.
  function fillStatusSelects() {
    const filter = $('filterStatus');
    if (filter) {
      const cur = filter.value;
      filter.innerHTML = '<option value="">All statuses</option>' + leadStatusList.map((s) => `<option>${esc(s)}</option>`).join('');
      filter.value = cur && leadStatusList.includes(cur) ? cur : '';
    }
    if ($('l-status')) $('l-status').innerHTML = leadStatusList.map((s) => `<option>${esc(s)}</option>`).join('');
  }
  function fmtDate(s) { if (!s) return ''; const d = new Date(s.replace(' ', 'T') + 'Z'); return isNaN(d) ? s : d.toLocaleString(); }
  function renderLeads() {
    const q = $('search').value.toLowerCase();
    const fr = $('filterReq').value, ft = $('filterType').value, fs = $('filterStatus').value;
    const rows = allLeads.filter((l) => {
      if (fr && l.requirement !== fr) return false;
      if (ft && l.client_type !== ft) return false;
      if (fs && (l.status || 'New') !== fs) return false;
      if (q && !(`${l.name} ${l.phone} ${l.company_name} ${l.company_email} ${l.message} ${l.budget}`.toLowerCase().includes(q))) return false;
      return true;
    });
    $('emptyState').hidden = rows.length > 0;
    const statuses = leadStatusList;
    const edit = canEditLeads();
    $('rows').innerHTML = rows.map((l) => {
      const st = l.status || 'New';
      // Keep a lead's current status selectable even if it was removed from the configured list.
      const opts = (statuses.includes(st) ? statuses : [st].concat(statuses)).map((s) => `<option ${s === st ? 'selected' : ''}>${esc(s)}</option>`).join('');
      // Status is editable by any logged-in staff (admin or lead-only user); edit/delete stay admin-only.
      const statusCell = `<select class="status-sel st-${esc(st.toLowerCase())}" data-lstatus="${l.id}">${opts}</select>`;
      const actionsCell = edit
        ? `<td style="white-space:nowrap;"><button class="btn small" data-ledit="${l.id}">Edit</button> <button class="btn small danger" data-ldel="${l.id}">Delete</button></td>`
        : '<td>—</td>';
      const checkCell = edit ? `<td><input type="checkbox" class="rowchk" data-id="${l.id}" /></td>` : '<td></td>';
      return `
      <tr>
        ${checkCell}
        <td>${l.id}</td>
        <td><strong>${esc(l.name)}</strong></td>
        <td>${esc(l.phone)} ${l.phone_verified ? '<span class="verified" title="Verified">✓</span>' : ''}</td>
        <td>${l.client_type ? `<span class="pill type">${esc(l.client_type)}</span>` : '—'}</td>
        <td>${l.company_name ? `${esc(l.company_name)}<br><small>${esc(l.company_email || '')}</small>` : '—'}</td>
        <td>${l.requirement ? `<span class="pill ${/partner/i.test(l.requirement) ? 'partner' : 'req'}">${esc(l.requirement)}</span>` : '—'}</td>
        <td>${l.interested_model ? `🖥 ${esc(l.interested_model)}` : '—'}</td>
        <td>${esc(l.budget) || '—'}</td>
        <td>${esc(l.best_time) || '—'}${l.call_type ? `<br><span class="pill ${/video/i.test(l.call_type) ? 'req' : 'type'}">${esc(l.call_type)}</span>` : ''}</td>
        <td>${statusCell}</td>
        <td class="msg"><span class="remark-tx">${esc(l.remark) || '—'}</span> <button class="btn small" data-lremark="${l.id}" title="Edit remark">✎</button></td>
        <td class="msg">${esc(l.message) || '—'}</td>
        <td>${fmtDate(l.created_at)}</td>
        ${actionsCell}
      </tr>`;
    }).join('');
    // Status dropdown and remark work for every staff role.
    $('rows').querySelectorAll('[data-lstatus]').forEach((sel) => sel.addEventListener('change', () => changeStatus(sel.dataset.lstatus, sel.value, sel)));
    $('rows').querySelectorAll('[data-lremark]').forEach((b) => b.addEventListener('click', () => changeRemark(b.dataset.lremark)));
    // Edit / delete / bulk-select are admin-only.
    if (edit) {
      $('rows').querySelectorAll('[data-ledit]').forEach((b) => b.addEventListener('click', () => openLead(b.dataset.ledit)));
      $('rows').querySelectorAll('[data-ldel]').forEach((b) => b.addEventListener('click', () => delLead(b.dataset.ldel)));
      $('rows').querySelectorAll('.rowchk').forEach((c) => c.addEventListener('change', updateSelection));
      if ($('selectAll')) $('selectAll').checked = false;
      updateSelection();
    }
  }

  async function changeRemark(id) {
    const lead = allLeads.find((x) => String(x.id) === String(id));
    if (!lead) return;
    const remark = prompt('Remark for ' + (lead.name || 'this lead') + ':', lead.remark || '');
    if (remark === null) return;
    const r = await api('/api/admin/leads/' + id + '/remark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remark: remark.trim() }) });
    const d = await r.json();
    if (d.ok) { lead.remark = remark.trim(); renderLeads(); }
    else alert(d.error || 'Could not save the remark.');
  }

  async function changeStatus(id, status, sel) {
    if (sel) sel.className = 'status-sel st-' + status.toLowerCase();
    const r = await api('/api/admin/leads/' + id + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    const d = await r.json();
    if (d.ok) { const lead = allLeads.find((x) => String(x.id) === String(id)); if (lead) lead.status = status; }
  }

  function selectedIds() { return Array.from($('rows').querySelectorAll('.rowchk:checked')).map((c) => c.dataset.id); }
  function updateSelection() {
    const n = selectedIds().length;
    const btn = $('bulkDeleteBtn');
    if (btn) { btn.hidden = n === 0; $('selCount').textContent = n; }
  }

  // ---- Lead edit / delete ----
  const leadDlg = $('leadDialog');
  function openLead(id) {
    const l = allLeads.find((x) => String(x.id) === String(id));
    if (!l) return;
    $('l-id').value = l.id;
    ['name', 'phone', 'company_name', 'company_email', 'requirement', 'budget', 'best_time', 'interested_model', 'message', 'remark'].forEach((f) => { if ($('l-' + f)) $('l-' + f).value = l[f] ?? ''; });
    $('l-client_type').value = l.client_type || '';
    $('l-call_type').value = l.call_type || '';
    const st = l.status || 'New';
    if (!leadStatusList.includes(st)) $('l-status').innerHTML = `<option>${esc(st)}</option>` + leadStatusList.map((s) => `<option>${esc(s)}</option>`).join('');
    else fillStatusSelects();
    $('l-status').value = st;
    leadDlg.showModal();
  }
  $('leadCancel').addEventListener('click', () => leadDlg.close());
  $('leadSave').addEventListener('click', async () => {
    const id = $('l-id').value;
    const payload = {};
    ['name', 'phone', 'client_type', 'company_name', 'company_email', 'requirement', 'budget', 'best_time', 'interested_model', 'message', 'remark'].forEach((f) => { if ($('l-' + f)) payload[f] = $('l-' + f).value.trim(); });
    payload.call_type = $('l-call_type').value;
    payload.status = $('l-status').value;
    if (!payload.name) { alert('Name is required.'); return; }
    const r = await api('/api/admin/leads/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!data.ok) { alert(data.error || 'Save failed.'); return; }
    leadDlg.close(); loadLeads();
  });
  async function delLead(id) {
    if (!confirm('Delete this lead permanently?')) return;
    await api('/api/admin/leads/' + id, { method: 'DELETE' });
    loadLeads();
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
    if ($('statVideo')) $('statVideo').textContent = data.video_clicks ?? '—';
    if (Array.isArray(data.statuses) && data.statuses.length) leadStatusList = data.statuses;
    fillStatusSelects();
    fillReqFilter();
    if ($('set-lead_statuses') && !$('set-lead_statuses').value) $('set-lead_statuses').value = leadStatusList.join(', ');
    updateStats(); renderLeads();
  }
  // Safe listener helper — never crashes the script if an element is missing.
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('saveLeadStatuses', 'click', async () => {
    await saveSettings(collectSettings(['lead_statuses']), $('leadStatusesSaved'));
    loadLeads(); // refresh dropdowns with the new list
  });
  on('search', 'input', renderLeads);
  on('filterReq', 'change', renderLeads);
  on('filterType', 'change', renderLeads);
  on('filterStatus', 'change', renderLeads);
  on('refreshLeads', 'click', loadLeads);
  on('selectAll', 'change', () => {
    $('rows').querySelectorAll('.rowchk').forEach((c) => { c.checked = $('selectAll').checked; });
    updateSelection();
  });
  on('bulkDeleteBtn', 'click', async () => {
    const ids = selectedIds();
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected lead(s) permanently?`)) return;
    const r = await api('/api/admin/leads/bulk-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    const d = await r.json();
    if (!d.ok) { alert(d.error || 'Delete failed.'); return; }
    loadLeads();
  });

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
    // Show the effective status list when none has been saved yet.
    if ($('set-lead_statuses') && !$('set-lead_statuses').value) $('set-lead_statuses').value = leadStatusList.join(', ');
    fillReqFilter();
    // image previews
    if (settings.logo_path) showPrev($('logoPrev'), settings.logo_path);
    if (settings.banner_image) showPrev($('bannerPrev'), settings.banner_image);
    // USP rows
    try { uspItems = JSON.parse(settings.usps || '[]'); } catch { uspItems = []; }
    renderUspRows();
    try { qcItems = JSON.parse(settings.qc_items || '[]'); } catch { qcItems = []; }
    renderQcRows();
    try { faqItems = JSON.parse(settings.faq_items || '[]'); } catch { faqItems = []; }
    renderFaqRows();
    try { conditionItems = JSON.parse(settings.condition_grades || '[]'); } catch { conditionItems = []; }
    renderConditionRows();
    try { sliderItems = JSON.parse(settings.slider_banners || '[]'); } catch { sliderItems = []; }
    renderSliderRows();
    try { dealItems = JSON.parse(settings.deals_list || '[]'); } catch { dealItems = []; }
    renderDealRows();
    try { stepItems = JSON.parse(settings.how_steps || '[]'); } catch { stepItems = []; }
    renderStepRows();
  }

  // ---- "How it works" steps editor ----
  let stepItems = [];
  function renderStepRows() {
    const wrap = $('stepRows'); if (!wrap) return;
    const icons = window.MOBI_ICONS || {};
    const list = window.MOBI_ICON_LIST || [];
    wrap.innerHTML = stepItems.length ? stepItems.map((x, i) => `
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin-bottom:10px;">
        <div class="upload-row" style="align-items:center;">
          <span class="cat-tag" style="min-width:26px;text-align:center;">${i + 1}</span>
          <span style="width:26px;height:26px;color:#2563eb;">${icons[x.icon] || ''}</span>
          <select data-sti="${i}" style="width:140px;"><option value="">— icon —</option>${list.map(([k, l]) => `<option value="${k}"${k === x.icon ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <input type="text" data-stt="${i}" placeholder="Step title" value="${esc(x.title || '')}" style="width:190px;" />
          <button class="btn small" type="button" data-stu="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="btn small danger" type="button" data-stx="${i}">✕</button>
        </div>
        <div class="upload-row" style="margin-top:8px;">
          <input type="text" data-stn="${i}" placeholder="Short description" value="${esc(x.note || '')}" style="flex:1;min-width:240px;" />
          <input type="text" data-stl="${i}" placeholder="Link (optional), e.g. /p/open-box-delivery" value="${esc(x.link || '')}" style="width:230px;" />
          <input type="text" data-stlt="${i}" placeholder="Link text" value="${esc(x.link_text || '')}" style="width:120px;" />
        </div>
      </div>`).join('') : '<p class="muted" style="padding:6px 0;">No steps yet.</p>';
    wrap.querySelectorAll('[data-sti]').forEach((el) => el.addEventListener('change', () => { stepItems[+el.dataset.sti].icon = el.value; renderStepRows(); }));
    wrap.querySelectorAll('[data-stl]').forEach((el) => el.addEventListener('input', () => { stepItems[+el.dataset.stl].link = el.value.trim(); }));
    wrap.querySelectorAll('[data-stlt]').forEach((el) => el.addEventListener('input', () => { stepItems[+el.dataset.stlt].link_text = el.value; }));
    wrap.querySelectorAll('[data-stt]').forEach((el) => el.addEventListener('input', () => { stepItems[+el.dataset.stt].title = el.value; }));
    wrap.querySelectorAll('[data-stn]').forEach((el) => el.addEventListener('input', () => { stepItems[+el.dataset.stn].note = el.value; }));
    wrap.querySelectorAll('[data-stu]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.stu; if (i > 0) { [stepItems[i - 1], stepItems[i]] = [stepItems[i], stepItems[i - 1]]; renderStepRows(); }
    }));
    wrap.querySelectorAll('[data-stx]').forEach((el) => el.addEventListener('click', () => { stepItems.splice(+el.dataset.stx, 1); renderStepRows(); }));
  }
  on('addStepBtn', 'click', () => { stepItems.push({ title: '', note: '' }); renderStepRows(); });
  on('saveSteps', 'click', () => {
    const payload = collectSettings(['how_enabled', 'how_title']);
    payload.how_steps = JSON.stringify(stepItems.filter((x) => (x.title || '').trim()).map((x) => ({
      icon: x.icon || '', title: x.title.trim(), note: (x.note || '').trim(),
      link: (x.link || '').trim(), link_text: (x.link_text || '').trim(),
    })));
    saveSettings(payload, $('stepsSaved'));
  });

  // ---- Deals grid editor (one card per deal) ----
  let dealItems = [];
  function dealModelOpts(current) {
    return '<option value="">— Select product —</option>' + (models || []).map((m) => `<option value="${esc(m.slug)}"${m.slug === current ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  }
  function renderDealRows() {
    const wrap = $('dealRows'); if (!wrap) return;
    wrap.innerHTML = dealItems.length ? dealItems.map((d, i) => `
      <div class="upload-row" style="margin-bottom:8px;">
        <select data-dgm="${i}" style="min-width:190px;flex:1;">${dealModelOpts(d.model_slug)}</select>
        <input type="text" data-dgl="${i}" placeholder="Label (e.g. MacBook deal)" value="${esc(d.label || '')}" style="width:150px;" />
        <input type="text" data-dgp="${i}" placeholder="Deal price (opt.)" value="${esc(d.price || '')}" style="width:110px;" />
        <input type="text" data-dgr="${i}" placeholder="MRP (opt.)" value="${esc(d.mrp || '')}" style="width:100px;" />
        <input type="number" data-dgq="${i}" placeholder="Qty" value="${esc(d.qty ?? '')}" min="0" style="width:70px;" title="Units left (shows 'Only X left')" />
        <button class="btn small danger" type="button" data-dgx="${i}">✕</button>
      </div>`).join('') : '<p class="muted" style="padding:6px 0;">No deals in the grid yet.</p>';
    wrap.querySelectorAll('[data-dgm]').forEach((el) => el.addEventListener('change', () => { dealItems[+el.dataset.dgm].model_slug = el.value; }));
    wrap.querySelectorAll('[data-dgl]').forEach((el) => el.addEventListener('input', () => { dealItems[+el.dataset.dgl].label = el.value; }));
    wrap.querySelectorAll('[data-dgp]').forEach((el) => el.addEventListener('input', () => { dealItems[+el.dataset.dgp].price = el.value; }));
    wrap.querySelectorAll('[data-dgr]').forEach((el) => el.addEventListener('input', () => { dealItems[+el.dataset.dgr].mrp = el.value; }));
    wrap.querySelectorAll('[data-dgq]').forEach((el) => el.addEventListener('input', () => { dealItems[+el.dataset.dgq].qty = el.value; }));
    wrap.querySelectorAll('[data-dgx]').forEach((el) => el.addEventListener('click', () => { dealItems.splice(+el.dataset.dgx, 1); renderDealRows(); }));
  }
  on('addDealBtn', 'click', () => { dealItems.push({ model_slug: '', label: '', price: '', mrp: '', qty: '' }); renderDealRows(); });
  on('saveDeals', 'click', () => {
    saveSettings({ deals_list: JSON.stringify(dealItems.filter((d) => d.model_slug)) }, $('dealsSaved'));
  });

  // ---- Sliding banners editor ----
  let sliderItems = [];
  function renderSliderRows() {
    const wrap = $('sliderRows'); if (!wrap) return;
    wrap.innerHTML = sliderItems.length ? sliderItems.map((b, i) => `
      <div class="upload-row" style="margin-bottom:10px;align-items:center;flex-wrap:wrap;">
        <img src="${esc(b.image)}" style="width:120px;height:40px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;" />
        <input type="text" data-slink="${i}" placeholder="Link (optional), e.g. /c/macbooks" value="${esc(b.link || '')}" style="flex:1;min-width:180px;" />
        <label class="btn small" style="cursor:pointer;">${b.mobile ? '📱 ✓ mobile' : '📱 add mobile version'}<input type="file" data-smf="${i}" accept="image/*" hidden /></label>
        ${b.mobile ? `<button class="btn small" type="button" data-smx="${i}" title="Remove mobile version">✕📱</button>` : ''}
        <button class="btn small" type="button" data-sup="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small danger" type="button" data-srem="${i}">✕</button>
      </div>`).join('') : '<p class="muted" style="padding:6px 0;">No banners yet.</p>';
    wrap.querySelectorAll('[data-smf]').forEach((el) => el.addEventListener('change', async () => {
      const p = await uploadOneFile(el.files[0]);
      if (p) { sliderItems[+el.dataset.smf].mobile = p; renderSliderRows(); }
    }));
    wrap.querySelectorAll('[data-smx]').forEach((el) => el.addEventListener('click', () => { delete sliderItems[+el.dataset.smx].mobile; renderSliderRows(); }));
    wrap.querySelectorAll('[data-slink]').forEach((el) => el.addEventListener('input', () => { sliderItems[+el.dataset.slink].link = el.value.trim(); }));
    wrap.querySelectorAll('[data-srem]').forEach((el) => el.addEventListener('click', () => { sliderItems.splice(+el.dataset.srem, 1); renderSliderRows(); }));
    wrap.querySelectorAll('[data-sup]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.sup; if (i > 0) { [sliderItems[i - 1], sliderItems[i]] = [sliderItems[i], sliderItems[i - 1]]; renderSliderRows(); }
    }));
  }
  on('sliderAddBtn', 'click', async () => {
    const p = await uploadImage($('sliderFile'));
    if (p) { sliderItems.push({ image: p, link: '' }); $('sliderFile').value = ''; renderSliderRows(); }
  });
  on('saveSliders', 'click', () => {
    saveSettings({ slider_banners: JSON.stringify(sliderItems.filter((b) => b.image)) }, $('slidersSaved'));
  });

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

  // ---- QC ("How we test") editor ----
  let qcItems = [];
  function renderQcRows() {
    const wrap = $('qcRows'); if (!wrap) return;
    const icons = window.MOBI_ICONS || {};
    const list = window.MOBI_ICON_LIST || [];
    wrap.innerHTML = qcItems.map((u, i) => `
      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line);">
        <span style="flex:0 0 auto;display:inline-grid;place-items:center;width:40px;height:40px;border-radius:10px;background:rgba(37,99,235,0.1);color:var(--brand);">${icons[u.icon] || ''}</span>
        <select data-qcicon="${i}" style="width:150px;">${list.map(([k, l]) => `<option value="${k}" ${k === u.icon ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="text" data-qctitle="${i}" value="${esc(u.title || '')}" placeholder="Check name" style="flex:1;min-width:150px;" />
        <input type="text" data-qcnote="${i}" value="${esc(u.note || '')}" placeholder="short note" style="width:150px;" />
        <button class="btn small danger" data-qcrem="${i}" type="button">Remove</button>
      </div>`).join('');
    wrap.querySelectorAll('[data-qcicon]').forEach((el) => el.addEventListener('change', () => { qcItems[+el.dataset.qcicon].icon = el.value; renderQcRows(); }));
    wrap.querySelectorAll('[data-qctitle]').forEach((el) => el.addEventListener('input', () => { qcItems[+el.dataset.qctitle].title = el.value; }));
    wrap.querySelectorAll('[data-qcnote]').forEach((el) => el.addEventListener('input', () => { qcItems[+el.dataset.qcnote].note = el.value; }));
    wrap.querySelectorAll('[data-qcrem]').forEach((el) => el.addEventListener('click', () => { qcItems.splice(+el.dataset.qcrem, 1); renderQcRows(); }));
  }
  on('addQcBtn', 'click', () => { qcItems.push({ icon: 'qc', title: '', note: '' }); renderQcRows(); });

  // ---- FAQ editor ----
  let faqItems = [];
  function renderFaqRows() {
    const wrap = $('faqRows'); if (!wrap) return;
    wrap.innerHTML = faqItems.map((f, i) => `
      <div style="padding:12px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" data-faqq="${i}" value="${esc(f.q || '')}" placeholder="Question" style="flex:1;" />
          <button class="btn small danger" data-faqrem="${i}" type="button">Remove</button>
        </div>
        <textarea data-faqa="${i}" rows="2" placeholder="Answer" style="margin-top:8px;">${esc(f.a || '')}</textarea>
      </div>`).join('');
    wrap.querySelectorAll('[data-faqq]').forEach((el) => el.addEventListener('input', () => { faqItems[+el.dataset.faqq].q = el.value; }));
    wrap.querySelectorAll('[data-faqa]').forEach((el) => el.addEventListener('input', () => { faqItems[+el.dataset.faqa].a = el.value; }));
    wrap.querySelectorAll('[data-faqrem]').forEach((el) => el.addEventListener('click', () => { faqItems.splice(+el.dataset.faqrem, 1); renderFaqRows(); }));
  }
  on('addFaqBtn', 'click', () => { faqItems.push({ q: '', a: '' }); renderFaqRows(); });

  let conditionItems = [];
  function renderConditionRows() {
    const wrap = $('conditionRows'); if (!wrap) return;
    wrap.innerHTML = conditionItems.map((c, i) => `
      <div style="padding:12px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;gap:8px;align-items:center;">
          <input type="text" data-cg="${i}" value="${esc(c.grade || '')}" placeholder="Grade name (e.g. Excellent)" style="flex:1;font-weight:600;" />
          <button class="btn small danger" data-cgrem="${i}" type="button">Remove</button>
        </div>
        <input type="text" data-cs="${i}" value="${esc(c.summary || '')}" placeholder="Short summary (one line)" style="margin-top:8px;width:100%;" />
        <textarea data-cd="${i}" rows="2" placeholder="Full description" style="margin-top:8px;">${esc(c.detail || '')}</textarea>
      </div>`).join('');
    wrap.querySelectorAll('[data-cg]').forEach((el) => el.addEventListener('input', () => { conditionItems[+el.dataset.cg].grade = el.value; }));
    wrap.querySelectorAll('[data-cs]').forEach((el) => el.addEventListener('input', () => { conditionItems[+el.dataset.cs].summary = el.value; }));
    wrap.querySelectorAll('[data-cd]').forEach((el) => el.addEventListener('input', () => { conditionItems[+el.dataset.cd].detail = el.value; }));
    wrap.querySelectorAll('[data-cgrem]').forEach((el) => el.addEventListener('click', () => { conditionItems.splice(+el.dataset.cgrem, 1); renderConditionRows(); }));
  }
  on('addConditionBtn', 'click', () => { conditionItems.push({ grade: '', summary: '', detail: '' }); renderConditionRows(); });

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
    const keys = ['brand_name', 'header_cta_text', 'cta_text', 'announce_enabled', 'announce_text', 'ribbon_enabled', 'ribbon_items', 'banner_eyebrow', 'banner_heading', 'banner_subtext', 'trust_points', 'models_title', 'models_subtitle', 'price_note', 'usps_enabled', 'usps_title', 'qc_enabled', 'qc_title', 'qc_subtitle', 'qc_video_enabled', 'qc_video_text', 'faq_enabled', 'faq_title', 'condition_enabled', 'condition_title', 'condition_intro', 'about_enabled', 'about_title', 'about_text', 'contact_enabled', 'contact_title', 'contact_subtitle', 'contact_address', 'google_maps_url', 'google_maps_embed', 'google_maps_embed_2', 'footer_tagline', 'legal_name', 'gstin', 'registered_address', 'customer_care_email', 'customer_care_phone', 'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone', 'social_instagram', 'social_facebook', 'social_linkedin', 'social_email', 'social_phone', 'social_whatsapp', 'footer_text', 'footer_email'];
    const payload = collectSettings(keys);
    payload.logo_path = settings.logo_path || '';
    payload.banner_image = settings.banner_image || '';
    // USP items (icon strip) — stored as a JSON string
    payload.usps = JSON.stringify(
      uspItems
        .filter((u) => (u.title || '').trim())
        .map((u) => ({ icon: u.icon || 'star', title: u.title.trim(), note: (u.note || '').trim(), image: u.image || '' }))
    );
    payload.qc_items = JSON.stringify(
      qcItems.filter((u) => (u.title || '').trim()).map((u) => ({ icon: u.icon || 'qc', title: u.title.trim(), note: (u.note || '').trim() }))
    );
    payload.faq_items = JSON.stringify(
      faqItems.filter((f) => (f.q || '').trim()).map((f) => ({ q: f.q.trim(), a: (f.a || '').trim() }))
    );
    payload.condition_grades = JSON.stringify(
      conditionItems.filter((c) => (c.grade || '').trim()).map((c) => ({ grade: c.grade.trim(), summary: (c.summary || '').trim(), detail: (c.detail || '').trim() }))
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
  async function loadCategories() {
    try {
      const r = await api('/api/admin/categories');
      const data = await r.json();
      cats = data.categories || [];
    } catch { cats = []; }
    renderCategoriesList();
  }
  async function loadModels() {
    const r = await api('/api/admin/models');
    const data = await r.json();
    models = data.models || [];
    renderModelFilter();
    renderModelsList();
    fillOfferModels();
    renderDealRows(); // product dropdowns need the models list
  }
  function catName(slug) { const c = cats.find((x) => x.slug === slug); return c ? c.name : slug; }
  let modelFilter = '';
  function renderModelFilter() {
    const wrap = $('modelCatFilter'); if (!wrap) return;
    const present = [...new Set(models.map((m) => m.category))];
    if (present.length < 2 && !modelFilter) { wrap.innerHTML = ''; return; }
    const counts = {}; models.forEach((m) => { counts[m.category] = (counts[m.category] || 0) + 1; });
    const chip = (val, label, n) => `<button class="mfilter${modelFilter === val ? ' on' : ''}" data-mcat="${esc(val)}">${esc(label)}${n != null ? ` (${n})` : ''}</button>`;
    wrap.innerHTML = chip('', 'All', models.length) + cats.filter((c) => present.includes(c.slug)).map((c) => chip(c.slug, c.name, counts[c.slug] || 0)).join('');
    wrap.querySelectorAll('[data-mcat]').forEach((b) => b.addEventListener('click', () => { modelFilter = b.dataset.mcat; renderModelFilter(); renderModelsList(); }));
  }
  function fillOfferModels() {
    const sel = $('set-offer_model_slug');
    if (!sel) return;
    const cur = (settings && settings.offer_model_slug) || sel.value || '';
    sel.innerHTML = '<option value="">— Select a model —</option>' +
      models.map((m) => `<option value="${esc(m.slug)}">${esc(m.name)}</option>`).join('');
    sel.value = cur;
  }
  on('offerSaveBtn', 'click', () => {
    saveSettings(collectSettings(['offer_enabled', 'offer_model_slug', 'offer_label', 'offer_badge', 'offer_price', 'offer_mrp', 'offer_subtitle', 'offer_gst_note', 'offer_qty', 'offer_reserve_amount', 'offer_reserve_url']), $('offerSaved'));
  });
  on('payuSaveBtn', 'click', () => {
    saveSettings(collectSettings(['payu_enabled', 'payu_mode', 'payu_merchant_key', 'payu_salt', 'reserve_thankyou_text', 'reserve_button_enabled', 'reserve_flat_amount', 'reserve_payment_link']), $('payuSaved'));
  });
  function renderModelsList() {
    if (!models.length) { $('modelsList').innerHTML = '<p class="muted" style="padding:14px 0;">No products yet. Click “Add product”.</p>'; return; }
    const shown = modelFilter ? models.filter((m) => m.category === modelFilter) : models;
    if (!shown.length) { $('modelsList').innerHTML = '<p class="muted" style="padding:14px 0;">No products in this category yet.</p>'; return; }
    $('modelsList').innerHTML = shown.map((m) => `
      <div class="model-row">
        <div class="model-thumb" style="${m.image ? `background-image:url('${esc(m.image)}')` : ''}"></div>
        <div class="info">
          <b>${esc(m.name)} <span class="cat-tag">${esc(catName(m.category))}</span> ${m.active ? '' : '<span class="inactive-tag">(hidden)</span>'}</b>
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
  function catFieldsOf(slug) { const c = cats.find((x) => x.slug === slug); return c ? c.fields : 'macbook'; }
  function applyCategoryFields(slug) {
    const isPhone = catFieldsOf(slug) === 'phone';
    if ($('macFields')) $('macFields').hidden = isPhone;
    if ($('phoneFields')) $('phoneFields').hidden = !isPhone;
    if ($('lbl-cpu')) $('lbl-cpu').textContent = isPhone ? 'Processor / Chip' : 'Chip / CPU';
  }
  function fillCategorySelect(sel, current) {
    if (!sel) return;
    sel.innerHTML = cats.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
    sel.value = current || (cats[0] && cats[0].slug) || 'macbooks';
  }
  let gradeList = [];
  async function loadConditionGrades() {
    try {
      const r = await fetch('/api/site');
      const d = await r.json();
      let g = (d.settings && d.settings.condition_grades) || [];
      gradeList = typeof g === 'string' ? JSON.parse(g) : g;
    } catch { gradeList = []; }
  }
  function fillGradeSelect(current) {
    const sel = $('m-condition_grade'); if (!sel) return;
    const opts = ['<option value="">— Select grade —</option>']
      .concat(gradeList.map((g) => `<option value="${esc(g.grade)}">${esc(g.grade)}</option>`));
    if (current && !gradeList.some((g) => g.grade === current)) opts.push(`<option value="${esc(current)}">${esc(current)}</option>`);
    sel.innerHTML = opts.join('');
    sel.value = current || '';
  }
  // ---- Condition-based pricing rows (product dialog) ----
  let condPriceRows = [];
  function condGradeOpts(current) {
    const opts = ['<option value="">— condition —</option>'].concat(gradeList.map((g) => `<option value="${esc(g.grade)}"${g.grade === current ? ' selected' : ''}>${esc(g.grade)}</option>`));
    if (current && !gradeList.some((g) => g.grade === current)) opts.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
    return opts.join('');
  }
  function renderCondPriceRows() {
    const wrap = $('condPriceRows'); if (!wrap) return;
    wrap.innerHTML = condPriceRows.map((r, i) => `
      <div class="upload-row" style="margin-bottom:8px;">
        <select data-cpg="${i}" style="min-width:150px;">${condGradeOpts(r.grade)}</select>
        <input type="text" data-cpp="${i}" placeholder="Price e.g. ₹1,15,000" value="${esc(r.price || '')}" style="width:150px;" />
        <input type="text" data-cpm="${i}" placeholder="MRP (optional)" value="${esc(r.mrp || '')}" style="width:130px;" />
        <button class="btn small danger" type="button" data-cpx="${i}" title="Remove">✕</button>
      </div>`).join('');
    wrap.querySelectorAll('[data-cpg]').forEach((el) => el.addEventListener('change', () => { condPriceRows[+el.dataset.cpg].grade = el.value; }));
    wrap.querySelectorAll('[data-cpp]').forEach((el) => el.addEventListener('input', () => { condPriceRows[+el.dataset.cpp].price = el.value; }));
    wrap.querySelectorAll('[data-cpm]').forEach((el) => el.addEventListener('input', () => { condPriceRows[+el.dataset.cpm].mrp = el.value; }));
    wrap.querySelectorAll('[data-cpx]').forEach((el) => el.addEventListener('click', () => { condPriceRows.splice(+el.dataset.cpx, 1); renderCondPriceRows(); }));
  }
  on('addCondPrice', 'click', () => { condPriceRows.push({ grade: '', price: '', mrp: '' }); renderCondPriceRows(); });

  function openModel(id) {
    const m = id ? models.find((x) => String(x.id) === String(id)) : null;
    $('modelDlgTitle').textContent = m ? 'Edit product' : 'Add product';
    $('m-id').value = m ? m.id : '';
    fillCategorySelect($('m-category'), m ? m.category : (userScope || (cats[0] && cats[0].slug)));
    fillGradeSelect(m ? (m.condition_grade || '') : '');
    try { condPriceRows = m && m.condition_prices ? (JSON.parse(m.condition_prices) || []) : []; } catch { condPriceRows = []; }
    if (!Array.isArray(condPriceRows)) condPriceRows = [];
    renderCondPriceRows();
    ['name', 'slug', 'price', 'mrp', 'best_for', 'specs', 'description', 'badge', 'condition_grade', 'warranty', 'cpu', 'gpu', 'memory', 'storage', 'display', 'software', 'battery_health', 'colour', 'image', 'sort_order'].forEach((f) => { if ($('m-' + f)) $('m-' + f).value = m ? (m[f] ?? '') : (f === 'sort_order' ? models.length + 1 : ''); });
    $('m-active').value = m ? String(m.active) : '1';
    applyCategoryFields($('m-category').value);
    // Gallery images
    modelImages = [];
    if (m) {
      try { modelImages = JSON.parse(m.images || '[]'); } catch { modelImages = []; }
      if (!modelImages.length && m.image) modelImages = [m.image];
    }
    modelImages = modelImages.filter(Boolean);
    renderGallery();
    $('m-imageFile').value = '';
    dlg.showModal();
  }
  let modelImages = [];
  function renderGallery() {
    const wrap = $('m-gallery'); if (!wrap) return;
    $('m-image').value = modelImages[0] || '';
    if (!modelImages.length) { wrap.innerHTML = '<p class="muted" style="padding:8px 0;">No photos yet. Upload one or more above.</p>'; return; }
    wrap.innerHTML = modelImages.map((src, i) => `
      <div class="m-gitem${i === 0 ? ' main' : ''}">
        <img src="${esc(src)}" alt="">
        ${i === 0 ? '<span class="m-gmain">Main</span>' : `<button type="button" class="m-gset" data-gmain="${i}">Make main</button>`}
        <button type="button" class="m-gdel" data-gdel="${i}" title="Remove">✕</button>
      </div>`).join('');
    wrap.querySelectorAll('[data-gdel]').forEach((b) => b.addEventListener('click', () => { modelImages.splice(+b.dataset.gdel, 1); renderGallery(); }));
    wrap.querySelectorAll('[data-gmain]').forEach((b) => b.addEventListener('click', () => { const i = +b.dataset.gmain; const [x] = modelImages.splice(i, 1); modelImages.unshift(x); renderGallery(); }));
  }
  on('m-category', 'change', () => applyCategoryFields($('m-category').value));
  $('addModelBtn').addEventListener('click', () => openModel(null));
  $('modelCancel').addEventListener('click', () => dlg.close());
  $('m-uploadBtn').addEventListener('click', async () => {
    const input = $('m-imageFile');
    const files = Array.from(input.files || []);
    if (!files.length) { alert('Choose one or more image files first.'); return; }
    const btn = $('m-uploadBtn'); btn.disabled = true; btn.textContent = 'Uploading…';
    for (const file of files) {
      const p = await uploadOneFile(file);
      if (p) modelImages.push(p);
    }
    btn.disabled = false; btn.textContent = 'Upload photo(s)';
    input.value = '';
    renderGallery();
  });
  $('modelSave').addEventListener('click', async () => {
    const id = $('m-id').value;
    const payload = {
      category: $('m-category') ? $('m-category').value : 'macbooks',
      name: $('m-name').value.trim(), slug: $('m-slug').value.trim(), price: $('m-price').value.trim(), mrp: $('m-mrp') ? $('m-mrp').value.trim() : '', best_for: $('m-best_for') ? $('m-best_for').value.trim() : '', specs: $('m-specs').value.trim(),
      condition_prices: condPriceRows.filter((r) => (r.grade || '').trim() && (r.price || '').trim()),
      description: $('m-description').value.trim(),
      badge: $('m-badge').value, condition_grade: $('m-condition_grade').value.trim(),
      warranty: $('m-warranty').value.trim(),
      cpu: $('m-cpu').value.trim(), gpu: $('m-gpu').value.trim(),
      memory: $('m-memory').value.trim(), storage: $('m-storage').value.trim(),
      display: $('m-display').value.trim(), software: $('m-software').value.trim(),
      battery_health: $('m-battery_health') ? $('m-battery_health').value.trim() : '',
      colour: $('m-colour') ? $('m-colour').value.trim() : '',
      image: modelImages[0] || '',
      images: modelImages.slice(),
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
    if (!confirm('Delete this product?')) return;
    await api('/api/admin/models/' + id, { method: 'DELETE' });
    loadModels();
  }

  // ---------- Categories ----------
  const catDlg = $('categoryDialog');
  function renderCategoriesList() {
    const wrap = $('categoriesList');
    if (!wrap) return;
    if (!cats.length) { wrap.innerHTML = '<p class="muted" style="padding:12px 0;">No categories yet.</p>'; return; }
    const counts = {};
    models.forEach((m) => { counts[m.category] = (counts[m.category] || 0) + 1; });
    wrap.innerHTML = cats.map((c) => `
      <div class="model-row">
        <div class="info">
          <b>${esc(c.name)} <span class="cat-tag">/${esc(c.url_prefix)}</span> ${c.active ? '' : '<span class="inactive-tag">(hidden)</span>'} ${c.show_home === 0 ? '<span class="inactive-tag">(products off homepage)</span>' : ''}</b>
          <small>${esc(c.fields === 'phone' ? 'Phone specs' : 'Laptop specs')} · ${counts[c.slug] || 0} product(s) · <a href="/c/${esc(c.slug)}" target="_blank">/c/${esc(c.slug)} ↗</a></small>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn small" data-cedit="${c.id}">Edit</button>
          <button class="btn small danger" data-cdel="${c.id}">Delete</button>
        </div>
      </div>`).join('');
    wrap.querySelectorAll('[data-cedit]').forEach((b) => b.addEventListener('click', () => openCategory(b.dataset.cedit)));
    wrap.querySelectorAll('[data-cdel]').forEach((b) => b.addEventListener('click', () => delCategory(b.dataset.cdel)));
  }
  let catIconPath = '';
  function setCatIconPreview() {
    const prev = $('c-iconPrev');
    if (prev) { prev.src = catIconPath || ''; prev.style.display = catIconPath ? '' : 'none'; }
  }
  on('c-iconUpload', 'click', async () => {
    const p = await uploadImage($('c-iconFile'));
    if (p) { catIconPath = p; setCatIconPreview(); }
  });
  on('c-iconRemove', 'click', () => { catIconPath = ''; if ($('c-iconFile')) $('c-iconFile').value = ''; setCatIconPreview(); });
  function openCategory(id) {
    const c = id ? cats.find((x) => String(x.id) === String(id)) : null;
    catIconPath = c ? (c.icon_image || '') : '';
    if ($('c-iconFile')) $('c-iconFile').value = '';
    setCatIconPreview();
    $('catDlgTitle').textContent = c ? 'Edit category' : 'Add category';
    $('c-id').value = c ? c.id : '';
    $('c-name').value = c ? c.name : '';
    if ($('c-slug')) $('c-slug').value = c ? c.slug : '';
    $('c-singular').value = c ? c.singular : '';
    $('c-fields').value = c ? c.fields : 'macbook';
    $('c-tagline').value = c ? (c.tagline || '') : '';
    if ($('c-price_note')) $('c-price_note').value = c ? (c.price_note || '') : '';
    $('c-sort_order').value = c ? c.sort_order : cats.length + 1;
    $('c-active').value = c ? String(c.active) : '1';
    if ($('c-show_home')) $('c-show_home').value = c && c.show_home === 0 ? '0' : '1';
    $('c-urlnote').textContent = c ? `Page: /c/${c.slug} · Product URLs: /${c.url_prefix}/… — changing the slug changes the category page URL (old links stop working).` : 'Leave the slug blank to generate it from the name.';
    catDlg.showModal();
  }
  on('addCatBtn', 'click', () => openCategory(null));
  on('catCancel', 'click', () => catDlg.close());
  on('catSave', 'click', async () => {
    const id = $('c-id').value;
    const payload = { name: $('c-name').value.trim(), slug: $('c-slug') ? $('c-slug').value.trim() : '', singular: $('c-singular').value.trim(), fields: $('c-fields').value, tagline: $('c-tagline').value.trim(), price_note: $('c-price_note') ? $('c-price_note').value.trim() : '', sort_order: parseInt($('c-sort_order').value || '0', 10), active: $('c-active').value, show_home: $('c-show_home') ? $('c-show_home').value : '1', icon_image: catIconPath };
    if (!payload.name) { alert('Category name is required.'); return; }
    const r = await api(id ? '/api/admin/categories/' + id : '/api/admin/categories', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!data.ok) { alert(data.error || 'Save failed.'); return; }
    catDlg.close(); await loadCategories(); loadModels();
  });
  async function delCategory(id) {
    if (!confirm('Delete this category? (Only works if it has no products.)')) return;
    const r = await api('/api/admin/categories/' + id, { method: 'DELETE' });
    const data = await r.json();
    if (!data.ok) { alert(data.error || 'Delete failed.'); return; }
    loadCategories();
  }

  // ========================================================================
  // SEO & ANALYTICS
  // ========================================================================
  on('saveSeo', 'click', () => {
    saveSettings(collectSettings(['site_url', 'meta_title', 'meta_description', 'meta_keywords', 'og_image', 'ga_measurement_id', 'head_code', 'body_code']), $('seoSaved'));
  });
  on('ogUploadBtn', 'click', async () => {
    const p = await uploadImage($('ogFile'));
    if (!p) return;
    $('set-og_image').value = p;
  });
  on('saveCapi', 'click', () => {
    saveSettings(collectSettings(['fb_capi_enabled', 'fb_pixel_id', 'fb_capi_token']), $('capiSaved'));
  });

  // ========================================================================
  // SMS & EMAIL INTEGRATIONS
  // ========================================================================
  $('saveIntegrations').addEventListener('click', () => {
    const keys = ['otp_provider', 'otp_ttl_minutes', 'twofactor_api_key', 'twofactor_template_name',
      'twilio_account_sid', 'twilio_auth_token', 'twilio_messaging_service_sid', 'twilio_from_number',
      'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'mail_from', 'lead_notify_to'];
    saveSettings(collectSettings(keys), $('integrationsSaved'));
  });

  function showTestMsg(el, text, ok) {
    el.textContent = text;
    el.style.display = 'inline';
    el.style.color = ok ? 'var(--ok)' : 'var(--err)';
  }
  $('testSmsBtn').addEventListener('click', async () => {
    const phone = $('testSmsPhone').value.trim();
    if (!phone) { showTestMsg($('testSmsMsg'), 'Enter a phone number.', false); return; }
    showTestMsg($('testSmsMsg'), 'Sending… (save first if you changed keys)', true);
    try {
      const r = await api('/api/admin/test-sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
      const d = await r.json();
      showTestMsg($('testSmsMsg'), d.ok ? d.message : (d.error || 'Failed'), !!d.ok);
    } catch (e) { showTestMsg($('testSmsMsg'), 'Failed', false); }
  });
  $('testEmailBtn').addEventListener('click', async () => {
    const to = $('testEmailTo').value.trim();
    showTestMsg($('testEmailMsg'), 'Sending… (save first if you changed settings)', true);
    try {
      const r = await api('/api/admin/test-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) });
      const d = await r.json();
      showTestMsg($('testEmailMsg'), d.ok ? d.message : (d.error || 'Failed'), !!d.ok);
    } catch (e) { showTestMsg($('testEmailMsg'), 'Failed', false); }
  });

  // ========================================================================
  // GOOGLE REVIEWS
  // ========================================================================
  $('saveReviewSettings').addEventListener('click', () => {
    saveSettings(collectSettings(['reviews_enabled', 'reviews_title', 'google_reviews_url', 'google_rating', 'google_review_count']), $('reviewSettingsSaved'));
  });
  on('saveGoogleLive', 'click', () => {
    saveSettings(collectSettings(['google_reviews_live', 'google_place_id', 'google_places_api_key']), $('googleLiveMsg'));
    const m = $('googleLiveMsg'); m.style.display = 'inline'; m.style.color = 'var(--ok)'; m.textContent = 'Saved ✓';
  });
  on('fetchGoogleBtn', 'click', async () => {
    const m = $('googleLiveMsg'); m.style.display = 'inline'; m.style.color = 'var(--muted)'; m.textContent = 'Fetching… (save your key & Place ID first)';
    try {
      const r = await api('/api/admin/google/refresh', { method: 'POST' });
      const d = await r.json();
      if (d.ok) { m.style.color = 'var(--ok)'; m.textContent = `✓ ${d.rating} ★ · ${d.count} reviews · ${d.reviews} shown`; }
      else { m.style.color = 'var(--err)'; m.textContent = d.error || 'Failed'; }
    } catch (e) { m.style.color = 'var(--err)'; m.textContent = 'Failed'; }
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
  // BLOG
  // ========================================================================
  on('saveBlogSettings', 'click', () => {
    saveSettings(collectSettings(['blog_enabled', 'blog_title', 'blog_subtitle']), $('blogSettingsSaved'));
  });
  let blogPosts = [];
  async function loadBlog() {
    const r = await api('/api/admin/blog');
    const d = await r.json();
    blogPosts = d.posts || [];
    renderBlogList();
  }
  function renderBlogList() {
    if (!blogPosts.length) { $('blogList').innerHTML = '<p class="muted" style="padding:12px 0;">No posts yet. Click “New post”.</p>'; return; }
    $('blogList').innerHTML = blogPosts.map((p) => `
      <div class="model-row">
        <div class="model-thumb" style="${p.cover_image ? `background-image:url('${esc(p.cover_image)}')` : ''}"></div>
        <div class="info"><b>${esc(p.title)} ${p.published ? '' : '<span class="inactive-tag">(draft)</span>'}</b><small>/blog/${esc(p.slug)} · ${(p.created_at || '').slice(0, 10)}</small></div>
        <div style="display:flex;gap:8px;">
          <button class="btn small" data-bedit="${p.id}">Edit</button>
          <button class="btn small danger" data-bdel="${p.id}">Delete</button>
        </div>
      </div>`).join('');
    $('blogList').querySelectorAll('[data-bedit]').forEach((b) => b.addEventListener('click', () => openBlog(b.dataset.bedit)));
    $('blogList').querySelectorAll('[data-bdel]').forEach((b) => b.addEventListener('click', () => delBlog(b.dataset.bdel)));
  }
  const blogDlg = $('blogDialog');
  async function openBlog(id) {
    let post = null;
    if (id) { const r = await api('/api/admin/blog/' + id); const d = await r.json(); post = d.post; }
    $('blogDlgTitle').textContent = post ? 'Edit post' : 'New post';
    $('bl-id').value = post ? post.id : '';
    ['title', 'slug', 'author', 'excerpt', 'cover_image', 'meta_description', 'tags'].forEach((f) => { $('bl-' + f).value = post ? (post[f] ?? '') : ''; });
    $('bl-editor').innerHTML = post ? (post.content || '') : '';
    $('bl-published').value = post ? String(post.published) : '1';
    $('bl-coverFile').value = '';
    const vl = $('bl-viewLink');
    if (post && post.published) { vl.href = '/blog/' + post.slug; vl.style.display = 'inline-block'; } else { vl.style.display = 'none'; }
    blogDlg.showModal();
  }
  on('addBlogBtn', 'click', () => openBlog(null));
  on('blogCancel', 'click', () => blogDlg.close());
  on('bl-coverUpload', 'click', async () => { const p = await uploadImage($('bl-coverFile')); if (!p) return; $('bl-cover_image').value = p; });
  // Rich text editor toolbar
  document.querySelectorAll('.rte-toolbar button').forEach((b) => b.addEventListener('click', () => {
    const cmd = b.dataset.cmd;
    $('bl-editor').focus();
    if (cmd === 'createLink') { const url = prompt('Link URL:', 'https://'); if (url) document.execCommand('createLink', false, url); }
    else document.execCommand(cmd, false, b.dataset.val || null);
  }));
  on('blogSave', 'click', async () => {
    const id = $('bl-id').value;
    const payload = {};
    ['title', 'slug', 'author', 'excerpt', 'cover_image', 'meta_description', 'tags'].forEach((f) => { payload[f] = $('bl-' + f).value; });
    payload.content = $('bl-editor').innerHTML;
    payload.published = $('bl-published').value;
    if (!payload.title.trim()) { alert('Title is required.'); return; }
    const r = await api(id ? '/api/admin/blog/' + id : '/api/admin/blog', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!d.ok) { alert(d.error || 'Save failed.'); return; }
    blogDlg.close(); loadBlog();
  });
  async function delBlog(id) {
    if (!confirm('Delete this post permanently?')) return;
    await api('/api/admin/blog/' + id, { method: 'DELETE' });
    loadBlog();
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

  // ========================================================================
  // USERS (lead-only staff accounts)
  // ========================================================================
  let usersCache = [];
  function userRoles(u) { return String(u.role || '').split(',').map((s) => s.trim()).filter(Boolean); }
  function accessLabel(u) {
    const roles = userRoles(u), bits = [];
    if (roles.includes('leads')) bits.push('Leads');
    if (roles.includes('catalog')) bits.push('Products (' + (u.scope ? (catName(u.scope) || u.scope) : 'all categories') + ')');
    return bits.join(' + ') || 'no access';
  }
  async function loadUsers() {
    const r = await api('/api/admin/users');
    const d = await r.json();
    usersCache = d.users || [];
    $('usersList').innerHTML = usersCache.length
      ? usersCache.map((u) => `
        <div class="model-row">
          <div class="info"><b>${esc(u.username)} ${userRoles(u).map((x) => `<span class="cat-tag">${esc(x === 'catalog' ? 'products' : x)}</span>`).join(' ')}</b><small>${esc(accessLabel(u))} · added ${(u.created_at || '').slice(0, 10)}</small></div>
          <div style="display:flex;gap:8px;">
            <button class="btn small" data-uedit="${u.id}">Edit</button>
            <button class="btn small danger" data-udel="${u.id}">Remove</button>
          </div>
        </div>`).join('')
      : '<p class="muted" style="padding:12px 0;">No additional users yet.</p>';
    $('usersList').querySelectorAll('[data-udel]').forEach((b) => b.addEventListener('click', () => delUser(b.dataset.udel)));
    $('usersList').querySelectorAll('[data-uedit]').forEach((b) => b.addEventListener('click', () => openUser(b.dataset.uedit)));
  }
  function fillUserScope() {
    const opts = '<option value="">All categories</option>' + cats.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('');
    if ($('u-scope')) $('u-scope').innerHTML = opts;
    if ($('eu-scope')) $('eu-scope').innerHTML = opts;
  }
  on('u-role-catalog', 'change', () => { $('u-scopeWrap').style.display = $('u-role-catalog').checked ? '' : 'none'; });
  on('eu-role-catalog', 'change', () => { $('eu-scopeWrap').style.display = $('eu-role-catalog').checked ? '' : 'none'; });
  function collectRoles(prefix) {
    const roles = [];
    if ($(prefix + '-role-leads') && $(prefix + '-role-leads').checked) roles.push('leads');
    if ($(prefix + '-role-catalog') && $(prefix + '-role-catalog').checked) roles.push('catalog');
    return roles;
  }
  on('addUserBtn', 'click', async () => {
    const username = $('u-username').value.trim();
    const password = $('u-password').value;
    const roles = collectRoles('u');
    if (!roles.length) { showTestMsg($('userMsg'), 'Pick at least one access type.', false); return; }
    const scope = roles.includes('catalog') && $('u-scope') ? $('u-scope').value : undefined;
    const r = await api('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, roles, scope }) });
    const d = await r.json();
    if (!d.ok) { showTestMsg($('userMsg'), d.error || 'Failed', false); return; }
    showTestMsg($('userMsg'), 'User created ✓', true);
    $('u-username').value = ''; $('u-password').value = '';
    loadUsers();
  });
  const userDlg = $('userDialog');
  function openUser(id) {
    const u = usersCache.find((x) => String(x.id) === String(id));
    if (!u || !userDlg) return;
    const roles = userRoles(u);
    $('eu-id').value = u.id;
    $('eu-username').value = u.username;
    $('eu-password').value = '';
    $('eu-role-leads').checked = roles.includes('leads');
    $('eu-role-catalog').checked = roles.includes('catalog');
    $('eu-scope').value = u.scope || '';
    $('eu-scopeWrap').style.display = roles.includes('catalog') ? '' : 'none';
    userDlg.showModal();
  }
  on('euCancel', 'click', () => userDlg.close());
  on('euSave', 'click', async () => {
    const id = $('eu-id').value;
    const roles = collectRoles('eu');
    if (!roles.length) { alert('Pick at least one access type.'); return; }
    const payload = { username: $('eu-username').value.trim(), roles, scope: roles.includes('catalog') ? $('eu-scope').value : undefined };
    const pw = $('eu-password').value;
    if (pw) payload.password = pw;
    const r = await api('/api/admin/users/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!d.ok) { alert(d.error || 'Save failed.'); return; }
    userDlg.close();
    loadUsers();
  });
  async function delUser(id) {
    if (!confirm('Remove this user? They will no longer be able to log in.')) return;
    await api('/api/admin/users/' + id, { method: 'DELETE' });
    loadUsers();
  }

  // ========================================================================
  // PARTNERS (City Partner applications from /partner)
  // ========================================================================
  let allPartners = [];
  let partnerStageList = ['New', 'Interview scheduled', 'Interviewed', 'Selected', 'Agreement sent', 'Onboarded', 'Rejected'];
  function fillPartnerFilters() {
    const cs = $('ptFilterCity'), st = $('ptFilterStage');
    if (cs) {
      const cur = cs.value;
      const cities = [...new Set(allPartners.map((p) => (p.city || '').trim()).filter(Boolean))].sort();
      cs.innerHTML = '<option value="">All cities</option>' + cities.map((c) => `<option>${esc(c)}</option>`).join('');
      if (cur && cities.includes(cur)) cs.value = cur;
    }
    if (st) {
      const cur = st.value;
      st.innerHTML = '<option value="">All stages</option>' + partnerStageList.map((s) => `<option>${esc(s)}</option>`).join('');
      if (cur && partnerStageList.includes(cur)) st.value = cur;
    }
  }
  function renderPartners() {
    const wrap = $('ptRows'); if (!wrap) return;
    const q = ($('ptSearch').value || '').toLowerCase();
    const fc = $('ptFilterCity').value, fs = $('ptFilterStage').value;
    const rows = allPartners.filter((p) => {
      if (fc && (p.city || '') !== fc) return false;
      if (fs && (p.stage || 'New') !== fs) return false;
      if (q && !`${p.name} ${p.phone} ${p.city} ${p.message} ${p.remark}`.toLowerCase().includes(q)) return false;
      return true;
    });
    $('ptEmpty').hidden = rows.length > 0;
    wrap.innerHTML = rows.map((p) => {
      const st = p.stage || 'New';
      const opts = (partnerStageList.includes(st) ? partnerStageList : [st].concat(partnerStageList))
        .map((s) => `<option ${s === st ? 'selected' : ''}>${esc(s)}</option>`).join('');
      return `<tr>
        <td>${p.id}</td>
        <td><strong>${esc(p.name)}</strong></td>
        <td>${esc(p.phone)} <span class="verified" title="Verified">✓</span></td>
        <td><span class="pill type">${esc(p.city || '—')}</span></td>
        <td class="msg">${esc(p.message) || '—'}</td>
        <td><select class="status-sel st-${esc(st.toLowerCase().replace(/\s+/g, '-'))}" data-ptstage="${p.id}">${opts}</select></td>
        <td class="msg"><span class="remark-tx">${esc(p.remark) || '—'}</span> <button class="btn small" data-ptremark="${p.id}" title="Edit remark">✎</button></td>
        <td>${fmtDate(p.created_at)}</td>
        <td>${canEditLeads() ? `<button class="btn small danger" data-ptdel="${p.id}">Delete</button>` : '—'}</td>
      </tr>`;
    }).join('');
    wrap.querySelectorAll('[data-ptstage]').forEach((sel) => sel.addEventListener('change', async () => {
      const r = await api('/api/admin/partners/' + sel.dataset.ptstage + '/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: sel.value }) });
      const d = await r.json();
      if (d.ok) { const p = allPartners.find((x) => String(x.id) === String(sel.dataset.ptstage)); if (p) p.stage = sel.value; renderPartners(); }
      else alert(d.error || 'Could not update the stage.');
    }));
    wrap.querySelectorAll('[data-ptremark]').forEach((b) => b.addEventListener('click', async () => {
      const p = allPartners.find((x) => String(x.id) === String(b.dataset.ptremark));
      if (!p) return;
      const remark = prompt('Remark for ' + (p.name || 'this applicant') + ':', p.remark || '');
      if (remark === null) return;
      const r = await api('/api/admin/partners/' + p.id + '/remark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remark: remark.trim() }) });
      if ((await r.json()).ok) { p.remark = remark.trim(); renderPartners(); }
    }));
    wrap.querySelectorAll('[data-ptdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this partner application permanently?')) return;
      await api('/api/admin/partners/' + b.dataset.ptdel, { method: 'DELETE' });
      loadPartners();
    }));
  }
  function updatePartnerStats() {
    const today = new Date().toISOString().slice(0, 10);
    if ($('ptTotal')) $('ptTotal').textContent = allPartners.length;
    if ($('ptToday')) $('ptToday').textContent = allPartners.filter((p) => (p.created_at || '').slice(0, 10) === today).length;
    if ($('ptCities')) $('ptCities').textContent = new Set(allPartners.map((p) => (p.city || '').trim()).filter(Boolean)).size;
    if ($('ptSelected')) $('ptSelected').textContent = allPartners.filter((p) => /selected|onboarded/i.test(p.stage || '')).length;
  }
  async function loadPartners() {
    const r = await api('/api/admin/partners');
    const d = await r.json();
    allPartners = d.partners || [];
    if (Array.isArray(d.stages) && d.stages.length) partnerStageList = d.stages;
    if ($('set-partner_stages') && !$('set-partner_stages').value) $('set-partner_stages').value = partnerStageList.join(', ');
    fillPartnerFilters(); updatePartnerStats(); renderPartners();
  }
  on('ptSearch', 'input', renderPartners);
  on('ptFilterCity', 'change', renderPartners);
  on('ptFilterStage', 'change', renderPartners);
  on('ptRefresh', 'click', loadPartners);
  on('savePartnerPage', 'click', () => {
    saveSettings(collectSettings(['partner_eyebrow', 'partner_heading', 'partner_subheading', 'partner_cta_text', 'partner_form_title', 'partner_form_sub', 'partner_form_note']), $('partnerPageSaved'));
  });
  on('savePtStages', 'click', async () => {
    await saveSettings(collectSettings(['partner_stages']), $('ptStagesSaved'));
    loadPartners();
  });

  function showOnlyTabs(tabs) {
    document.querySelectorAll('.tab').forEach((t) => { if (!tabs.includes(t.dataset.tab)) t.style.display = 'none'; });
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    const t = document.querySelector(`.tab[data-tab="${tabs[0]}"]`); if (t) t.classList.add('active');
    const p = $('panel-' + tabs[0]); if (p) p.classList.add('active');
  }

  // ---------- Init (role-aware; staff users can hold multiple roles) ----------
  async function init() {
    let role = 'admin';
    try { const r = await api('/api/admin/me'); const d = await r.json(); role = d.role || 'admin'; userScope = d.scope || null; } catch (e) {}
    userRole = role;

    if (role !== 'admin') {
      const roles = String(role).split(',').map((s) => s.trim()).filter(Boolean);
      const tabs = [];
      if (roles.includes('leads')) tabs.push('leads');
      if (roles.includes('catalog')) tabs.push('models');
      showOnlyTabs(tabs.length ? tabs : ['leads']);
      if (roles.includes('leads')) {
        // Lead access: status editable; no edit/delete/bulk.
        ['selectAll', 'bulkDeleteBtn', 'statusConfigCard'].forEach((id) => { const el = $(id); if (el) el.style.display = 'none'; });
        loadLeads();
      }
      if (roles.includes('catalog')) {
        // Product access: their category (or all), but can't manage categories.
        const cc = $('categoriesCard'); if (cc) cc.style.display = 'none';
        await loadCategories();
        await loadConditionGrades();
        loadModels();
      }
      return;
    }
    // Full admin — each loads independently so one failure can't blank the others.
    await loadCategories();
    await loadConditionGrades();
    fillUserScope();
    loadLeads();
    loadSettings();
    loadModels();
    loadReviews();
    loadPages();
    loadBlog();
    loadUsers();
    loadPartners();
  }
  init();
})();
