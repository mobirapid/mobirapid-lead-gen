// Admin panel pages (/manage) and the full /api/admin/* API.
// All code moved verbatim from server.js.
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const {
  setSetting, getAllSettings, cfg, otpProvider, leadNotifyTo, refreshGoogleRating,
} = require('../lib/settings');
const { ver, esc, slugify, normalizePhone, isEmail, genOtp } = require('../lib/util');
const { buildTransporter, sendSms } = require('../lib/notify');
const {
  ADMIN_USER, ADMIN_PASSWORD, signToken, hashPassword, verifyPassword,
  requireAdmin, requireFullRole, adminApiGate, userScope,
} = require('../lib/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Uploads (logo, banner, model images)
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 10);
    cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

// Gate for all /api/admin/* routes (implementation lives in lib/auth.js).
router.use('/api/admin', adminApiGate);

// Admin UI lives at /manage (not /admin) to avoid clashing with a /admin path
// that some hosts/other apps occupy. The /api/admin/* API paths are unaffected.
router.get(['/manage/login', '/admin/login'], (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'login.html')));
router.post(['/manage/login', '/admin/login'], (req, res) => {
  const { username, password } = req.body;
  let role = null, scope = null;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    role = 'admin';
  } else {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (u && verifyPassword(password, u.pass_hash)) { role = u.role || 'leads'; scope = u.scope || null; }
  }
  if (role) {
    res.cookie('admin_session', signToken(username, role, scope), { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
    return res.redirect('/manage');
  }
  res.redirect('/manage/login?error=1');
});
router.post(['/manage/logout', '/admin/logout'], (req, res) => { res.clearCookie('admin_session'); res.redirect('/manage/login'); });
// Serve the admin with cache-busted asset URLs so admins always get the latest admin.js/styles after a deploy.
router.get(['/manage', '/admin'], requireAdmin, (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin.html'), 'utf8')
    .replace('href="/styles.css"', `href="${ver('/styles.css')}"`)
    .replace('src="/admin.js"', `src="${ver('/admin.js')}"`);
  res.type('html').send(html);
});

// ===========================================================================
// ADMIN API
// ===========================================================================

// Who am I (used by the admin UI to show/hide tabs by role)
router.get('/api/admin/me', (req, res) => res.json({ ok: true, user: req.authUser.user, role: req.authUser.role || 'admin', scope: req.authUser.scope || null }));

// User management (full admin only — enforced by the gate above)
router.get('/api/admin/users', (req, res) => {
  res.json({ ok: true, users: db.prepare('SELECT id, username, role, scope, created_at FROM users ORDER BY id DESC').all() });
});
// Parse the requested access: roles may be an array (multi-role) or a legacy single `role` string.
// Returns { role: 'leads,catalog', scope } or { error }. Blank catalog scope = all categories.
function parseUserRoles(b) {
  let roles = Array.isArray(b.roles) ? b.roles : [b.role];
  roles = [...new Set(roles.map((r) => String(r || '').trim()).filter((r) => r === 'leads' || r === 'catalog'))];
  if (!roles.length) return { error: 'Pick at least one access type.' };
  let scope = null;
  if (roles.includes('catalog')) {
    scope = String(b.scope || '').trim() || null;
    if (scope && !db.prepare('SELECT id FROM categories WHERE slug = ?').get(scope)) return { error: 'Pick a valid category for the uploader.' };
  }
  return { role: roles.join(','), scope };
}
router.post('/api/admin/users', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(username)) return res.status(400).json({ ok: false, error: 'Username must be 3-60 chars (letters, numbers, . _ - @).' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  if (username === ADMIN_USER) return res.status(400).json({ ok: false, error: 'That username is reserved.' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(400).json({ ok: false, error: 'That username already exists.' });
  const parsed = parseUserRoles(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  db.prepare('INSERT INTO users (username, pass_hash, role, scope) VALUES (?, ?, ?, ?)').run(username, hashPassword(password), parsed.role, parsed.scope);
  res.json({ ok: true });
});
router.put('/api/admin/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ ok: false, error: 'Not found.' });
  const username = String(req.body.username || u.username).trim();
  if (!/^[a-zA-Z0-9._@-]{3,60}$/.test(username)) return res.status(400).json({ ok: false, error: 'Username must be 3-60 chars (letters, numbers, . _ - @).' });
  if (username === ADMIN_USER) return res.status(400).json({ ok: false, error: 'That username is reserved.' });
  if (db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id)) return res.status(400).json({ ok: false, error: 'That username already exists.' });
  const parsed = parseUserRoles(req.body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  const password = String(req.body.password || '');
  if (password && password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  if (password) db.prepare('UPDATE users SET username=?, role=?, scope=?, pass_hash=? WHERE id=?').run(username, parsed.role, parsed.scope, hashPassword(password), id);
  else db.prepare('UPDATE users SET username=?, role=?, scope=? WHERE id=?').run(username, parsed.role, parsed.scope, id);
  res.json({ ok: true });
});
router.delete('/api/admin/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Leads
router.get('/api/admin/leads', requireAdmin, (req, res) => {
  res.json({ ok: true, leads: db.prepare('SELECT * FROM leads ORDER BY id DESC').all() });
});

const LEAD_STATUSES = ['New', 'Contacted', 'Converted', 'Lost'];
router.put('/api/admin/leads/:id', requireAdmin, requireFullRole, (req, res) => {
  const b = req.body || {};
  const lead = {
    id: parseInt(req.params.id, 10),
    name: String(b.name || '').trim(),
    phone: String(b.phone || '').trim(),
    client_type: String(b.client_type || '').trim(),
    company_name: String(b.company_name || '').trim(),
    company_email: String(b.company_email || '').trim(),
    requirement: String(b.requirement || '').trim(),
    budget: String(b.budget || '').trim(),
    best_time: String(b.best_time || '').trim(),
    call_type: String(b.call_type || '').trim(),
    interested_model: String(b.interested_model || '').trim().slice(0, 200),
    message: String(b.message || '').trim().slice(0, 2000),
    status: LEAD_STATUSES.includes(b.status) ? b.status : 'New',
  };
  if (!lead.name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  db.prepare(
    `UPDATE leads SET name=@name, phone=@phone, client_type=@client_type, company_name=@company_name,
     company_email=@company_email, requirement=@requirement, budget=@budget, best_time=@best_time,
     call_type=@call_type, interested_model=@interested_model, message=@message, status=@status WHERE id=@id`
  ).run(lead);
  res.json({ ok: true });
});
// Quick status change (inline dropdown)
// Both admin and lead-only staff may change a lead's status (but not edit/delete the lead).
router.post('/api/admin/leads/:id/status', requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status.' });
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, parseInt(req.params.id, 10));
  res.json({ ok: true });
});
router.delete('/api/admin/leads/:id', requireAdmin, requireFullRole, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
// Bulk delete
router.post('/api/admin/leads/bulk-delete', requireAdmin, requireFullRole, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'No leads selected.' });
  const del = db.prepare('DELETE FROM leads WHERE id = ?');
  db.exec('BEGIN');
  try { for (const id of ids) del.run(id); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ ok: false, error: 'Delete failed.' }); }
  res.json({ ok: true, deleted: ids.length });
});
router.get('/api/admin/leads.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  const cols = ['id', 'name', 'phone', 'phone_verified', 'client_type', 'company_name', 'company_email', 'requirement', 'interested_model', 'budget', 'call_type', 'best_time', 'status', 'message', 'created_at'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="mobirapid-leads.csv"');
  res.send(csv);
});

// Settings (branding, header/footer, options)
router.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ ok: true, settings: getAllSettings() });
});
router.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  // For array-type settings sent as arrays, store as JSON
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) setSetting(k, JSON.stringify(v.map((x) => String(x).trim()).filter(Boolean)));
    else setSetting(k, v);
  }
  res.json({ ok: true, message: 'Saved.' });
});

// Image upload — returns the public path
router.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    res.json({ ok: true, path: '/uploads/' + req.file.filename });
  });
});

// Test the configured SMS provider
router.post('/api/admin/test-sms', requireAdmin, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Enter a valid phone number with country code.' });
  const provider = otpProvider();
  if (provider === 'mock') {
    return res.json({ ok: true, message: 'Provider is "mock" — no real SMS sent. The code prints to the server console. Switch to 2factor or twilio for real SMS.' });
  }
  try {
    await sendSms(phone, genOtp());
    res.json({ ok: true, message: `Test SMS sent via ${provider} to ${phone}.` });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Test the configured email (SMTP)
router.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const to = (req.body.to || '').trim() || leadNotifyTo();
  if (!isEmail(to)) return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  const t = buildTransporter();
  if (!t) return res.status(400).json({ ok: false, error: 'SMTP is not configured. Fill in the SMTP fields and save first.' });
  try {
    await t.sendMail({
      from: cfg('mail_from', 'MAIL_FROM') || 'Mobirapid Leads <no-reply@mobirapid.com>',
      to,
      subject: 'Mobirapid test email',
      text: 'This is a test email confirming your SMTP settings work. — Mobirapid admin',
    });
    res.json({ ok: true, message: 'Test email sent to ' + to + '.' });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// Delete an uploaded image file from disk
router.post('/api/admin/upload/delete', requireAdmin, (req, res) => {
  const p = String((req.body && req.body.path) || '');
  // Only allow simple filenames inside /uploads/ (no path traversal)
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(p)) {
    return res.status(400).json({ ok: false, error: 'Invalid path.' });
  }
  const fp = path.join(UPLOAD_DIR, path.basename(p));
  fs.unlink(fp, () => {}); // ignore "file not found" etc.
  res.json({ ok: true });
});

// Products (MacBooks + phones + any category) CRUD

router.get('/api/admin/models', requireAdmin, (req, res) => {
  const scope = userScope(req);
  const rows = scope
    ? db.prepare('SELECT * FROM macbook_models WHERE category = ? ORDER BY sort_order ASC, id ASC').all(scope)
    : db.prepare('SELECT * FROM macbook_models ORDER BY sort_order ASC, id ASC').all();
  res.json({ ok: true, models: rows });
});
function modelFromBody(b) {
  const name = String(b.name || '').trim();
  const catSlug = String(b.category || 'macbooks').trim();
  const cat = db.prepare('SELECT slug FROM categories WHERE slug = ?').get(catSlug);
  // Gallery images (JSON array). Primary image = first in the list (or the legacy `image`).
  let gallery = Array.isArray(b.images) ? b.images.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
  const primary = String(b.image || '').trim() || gallery[0] || '';
  if (primary && !gallery.length) gallery = [primary];
  return {
    name,
    category: cat ? cat.slug : 'macbooks',
    slug: b.slug ? slugify(b.slug) : slugify(name),
    price: String(b.price || '').trim(),
    mrp: String(b.mrp || '').trim(),
    image: primary,
    images: JSON.stringify(gallery),
    specs: String(b.specs || '').trim(),
    description: String(b.description || '').trim().slice(0, 600),
    badge: String(b.badge || '').trim(),
    condition_grade: String(b.condition_grade || '').trim(),
    warranty: String(b.warranty || '').trim(),
    cpu: String(b.cpu || '').trim().slice(0, 120),
    gpu: String(b.gpu || '').trim().slice(0, 120),
    memory: String(b.memory || '').trim().slice(0, 120),
    storage: String(b.storage || '').trim().slice(0, 120),
    display: String(b.display || '').trim().slice(0, 200),
    software: String(b.software || '').trim().slice(0, 600),
    battery_health: String(b.battery_health || '').trim().slice(0, 40),
    colour: String(b.colour || '').trim().slice(0, 60),
    sort_order: parseInt(b.sort_order || '0', 10) || 0,
    active: b.active === false || b.active === 'false' || b.active === 0 ? 0 : 1,
  };
}
router.post('/api/admin/models', requireAdmin, (req, res) => {
  const m = modelFromBody(req.body);
  if (!m.name) return res.status(400).json({ ok: false, error: 'Model name is required.' });
  const scope = userScope(req);
  if (scope) m.category = scope; // uploaders can only create in their own category
  let slug = m.slug, n = 2;
  while (db.prepare('SELECT id FROM macbook_models WHERE slug = ?').get(slug)) slug = m.slug + '-' + n++;
  const info = db.prepare(
    `INSERT INTO macbook_models (name, category, slug, price, mrp, image, images, specs, description, badge, condition_grade, warranty, cpu, gpu, memory, storage, display, software, battery_health, colour, sort_order, active)
     VALUES (@name, @category, @slug, @price, @mrp, @image, @images, @specs, @description, @badge, @condition_grade, @warranty, @cpu, @gpu, @memory, @storage, @display, @software, @battery_health, @colour, @sort_order, @active)`
  ).run({ ...m, slug });
  res.json({ ok: true, id: Number(info.lastInsertRowid), slug });
});
router.put('/api/admin/models/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT category FROM macbook_models WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Not found.' });
  const scope = userScope(req);
  if (scope && existing.category !== scope) return res.status(403).json({ ok: false, error: 'You can only edit your own category.' });
  const m = modelFromBody(req.body);
  if (!m.name) return res.status(400).json({ ok: false, error: 'Model name is required.' });
  if (scope) m.category = scope;
  let slug = m.slug, n = 2;
  while (db.prepare('SELECT id FROM macbook_models WHERE slug = ? AND id != ?').get(slug, id)) slug = m.slug + '-' + n++;
  db.prepare(
    `UPDATE macbook_models SET name=@name, category=@category, slug=@slug, price=@price, mrp=@mrp, image=@image, images=@images, specs=@specs, description=@description, badge=@badge,
     condition_grade=@condition_grade, warranty=@warranty, cpu=@cpu, gpu=@gpu, memory=@memory, storage=@storage, display=@display, software=@software,
     battery_health=@battery_health, colour=@colour, sort_order=@sort_order, active=@active WHERE id=@id`
  ).run({ ...m, slug, id });
  res.json({ ok: true, slug });
});
router.delete('/api/admin/models/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const scope = userScope(req);
  if (scope) {
    const ex = db.prepare('SELECT category FROM macbook_models WHERE id = ?').get(id);
    if (ex && ex.category !== scope) return res.status(403).json({ ok: false, error: 'You can only delete your own category.' });
  }
  db.prepare('DELETE FROM macbook_models WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Categories CRUD (read allowed for catalog uploaders; writes are admin-only)
router.get('/api/admin/categories', requireAdmin, (req, res) => {
  res.json({ ok: true, categories: db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all() });
});
router.post('/api/admin/categories', requireAdmin, requireFullRole, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Category name is required.' });
  const slug = slugify(b.slug || name);
  const prefix = slugify(b.url_prefix || b.singular || name).replace(/s$/, '');
  if (db.prepare('SELECT id FROM categories WHERE slug = ? OR url_prefix = ?').get(slug, prefix)) return res.status(400).json({ ok: false, error: 'A category with that slug/prefix already exists.' });
  const info = db.prepare('INSERT INTO categories (slug, name, singular, url_prefix, tagline, fields, sort_order, active, price_note, show_home) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(slug, name, String(b.singular || name).trim(), prefix, String(b.tagline || '').trim(), b.fields === 'phone' ? 'phone' : 'macbook', parseInt(b.sort_order || '0', 10) || 0, b.active === '0' || b.active === 0 ? 0 : 1, String(b.price_note || '').trim(), b.show_home === '0' || b.show_home === 0 ? 0 : 1);
  res.json({ ok: true, id: Number(info.lastInsertRowid), slug });
});
router.put('/api/admin/categories/:id', requireAdmin, requireFullRole, (req, res) => {
  const b = req.body || {};
  const id = parseInt(req.params.id, 10);
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Category name is required.' });
  const cur = db.prepare('SELECT slug FROM categories WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'Not found.' });
  // Optional slug change — cascades to the products and uploader accounts that reference it.
  let slug = cur.slug;
  if (b.slug !== undefined && String(b.slug).trim()) {
    const next = slugify(String(b.slug));
    if (!next) return res.status(400).json({ ok: false, error: 'Slug cannot be empty.' });
    if (next !== cur.slug) {
      if (db.prepare('SELECT id FROM categories WHERE slug = ? AND id != ?').get(next, id)) return res.status(400).json({ ok: false, error: 'A category with that slug already exists.' });
      db.prepare('UPDATE macbook_models SET category = ? WHERE category = ?').run(next, cur.slug);
      db.prepare('UPDATE users SET scope = ? WHERE scope = ?').run(next, cur.slug);
      slug = next;
    }
  }
  db.prepare('UPDATE categories SET slug=?, name=?, singular=?, tagline=?, fields=?, sort_order=?, active=?, price_note=?, show_home=? WHERE id=?')
    .run(slug, name, String(b.singular || name).trim(), String(b.tagline || '').trim(), b.fields === 'phone' ? 'phone' : 'macbook', parseInt(b.sort_order || '0', 10) || 0, b.active === '0' || b.active === 0 ? 0 : 1, String(b.price_note || '').trim(), b.show_home === '0' || b.show_home === 0 ? 0 : 1, id);
  res.json({ ok: true, slug });
});
router.delete('/api/admin/categories/:id', requireAdmin, requireFullRole, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cat = db.prepare('SELECT slug FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ ok: false, error: 'Not found.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM macbook_models WHERE category = ?').get(cat.slug).n;
  if (count > 0) return res.status(400).json({ ok: false, error: `Move or delete the ${count} product(s) in this category first.` });
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ ok: true });
});

// Fetch the live Google rating now (admin "Fetch now" button)
router.post('/api/admin/google/refresh', requireAdmin, async (req, res) => {
  const c = await refreshGoogleRating();
  if (c.error) return res.status(502).json({ ok: false, error: c.error });
  res.json({ ok: true, rating: c.rating, count: c.count, reviews: c.reviews.length });
});

// Reviews CRUD (Google Reviews integration — curated entries)
router.get('/api/admin/reviews', requireAdmin, (req, res) => {
  res.json({ ok: true, reviews: db.prepare('SELECT * FROM reviews ORDER BY sort_order ASC, id ASC').all() });
});
function reviewFromBody(b) {
  let rating = parseInt(b.rating, 10);
  if (isNaN(rating) || rating < 1) rating = 5;
  if (rating > 5) rating = 5;
  return {
    author: String(b.author || '').trim(),
    rating,
    text: String(b.text || '').trim().slice(0, 1000),
    date_label: String(b.date_label || '').trim(),
    sort_order: parseInt(b.sort_order || '0', 10) || 0,
    active: b.active === false || b.active === 'false' || b.active === 0 ? 0 : 1,
  };
}
router.post('/api/admin/reviews', requireAdmin, (req, res) => {
  const r = reviewFromBody(req.body);
  if (!r.author) return res.status(400).json({ ok: false, error: 'Reviewer name is required.' });
  const info = db.prepare(
    'INSERT INTO reviews (author, rating, text, date_label, sort_order, active) VALUES (@author, @rating, @text, @date_label, @sort_order, @active)'
  ).run(r);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
router.put('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const r = reviewFromBody(req.body);
  if (!r.author) return res.status(400).json({ ok: false, error: 'Reviewer name is required.' });
  db.prepare(
    'UPDATE reviews SET author=@author, rating=@rating, text=@text, date_label=@date_label, sort_order=@sort_order, active=@active WHERE id=@id'
  ).run({ ...r, id: parseInt(req.params.id, 10) });
  res.json({ ok: true });
});
router.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Blog posts CRUD

router.get('/api/admin/blog', requireAdmin, (req, res) => {
  res.json({ ok: true, posts: db.prepare('SELECT id, slug, title, excerpt, cover_image, author, published, created_at FROM blog_posts ORDER BY id DESC').all() });
});
router.get('/api/admin/blog/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!p) return res.status(404).json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, post: p });
});
function blogFromBody(b) {
  return {
    title: String(b.title || '').trim(),
    slug: (String(b.slug || '').trim() ? slugify(b.slug) : slugify(b.title)),
    excerpt: String(b.excerpt || '').trim().slice(0, 400),
    content: String(b.content || ''),
    cover_image: String(b.cover_image || '').trim(),
    author: String(b.author || '').trim(),
    meta_description: String(b.meta_description || '').trim().slice(0, 300),
    tags: String(b.tags || '').split(',').map((t) => t.trim()).filter(Boolean).join(', ').slice(0, 200),
    published: b.published === false || b.published === 'false' || b.published === 0 ? 0 : 1,
  };
}
router.post('/api/admin/blog', requireAdmin, (req, res) => {
  const p = blogFromBody(req.body);
  if (!p.title) return res.status(400).json({ ok: false, error: 'Title is required.' });
  // ensure unique slug
  let slug = p.slug, n = 2;
  while (db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(slug)) slug = p.slug + '-' + n++;
  const info = db.prepare(
    `INSERT INTO blog_posts (slug, title, excerpt, content, cover_image, author, meta_description, tags, published)
     VALUES (@slug, @title, @excerpt, @content, @cover_image, @author, @meta_description, @tags, @published)`
  ).run({ ...p, slug });
  res.json({ ok: true, id: Number(info.lastInsertRowid), slug });
});
router.put('/api/admin/blog/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = blogFromBody(req.body);
  if (!p.title) return res.status(400).json({ ok: false, error: 'Title is required.' });
  let slug = p.slug, n = 2;
  while (db.prepare('SELECT id FROM blog_posts WHERE slug = ? AND id != ?').get(slug, id)) slug = p.slug + '-' + n++;
  db.prepare(
    `UPDATE blog_posts SET slug=@slug, title=@title, excerpt=@excerpt, content=@content, cover_image=@cover_image,
     author=@author, meta_description=@meta_description, tags=@tags, published=@published, updated_at=datetime('now') WHERE id=@id`
  ).run({ ...p, slug, id });
  res.json({ ok: true, slug });
});
router.delete('/api/admin/blog/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Content / compliance pages
router.get('/api/admin/pages', requireAdmin, (req, res) => {
  res.json({ ok: true, pages: db.prepare('SELECT * FROM content_pages ORDER BY sort_order ASC').all() });
});
router.put('/api/admin/pages/:slug', requireAdmin, (req, res) => {
  const slug = req.params.slug;
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '');
  const exists = db.prepare('SELECT slug FROM content_pages WHERE slug = ?').get(slug);
  if (!exists) return res.status(404).json({ ok: false, error: 'Page not found.' });
  db.prepare("UPDATE content_pages SET title=?, content=?, updated_at=datetime('now') WHERE slug=?")
    .run(title || exists.title, content, slug);
  res.json({ ok: true });
});

module.exports = router;
