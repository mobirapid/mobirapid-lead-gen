require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OTP_PROVIDER = (process.env.OTP_PROVIDER || 'mock').toLowerCase();
const OTP_TTL_MINUTES = parseInt(process.env.OTP_TTL_MINUTES || '10', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const LEAD_NOTIFY_TO = process.env.LEAD_NOTIFY_TO || 'sachin@mobirapid.com';

// ---------------------------------------------------------------------------
// Uploads (logo, banner, model images)
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
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

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? '' : String(value));
}
function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
function parseJsonSetting(key, fallback) {
  try { return JSON.parse(getSetting(key)); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Twilio (lazy init only if configured)
// ---------------------------------------------------------------------------
let twilioClient = null;
if (OTP_PROVIDER === 'twilio') {
  try {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  } catch (e) {
    console.error('Twilio init failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Mailer
// ---------------------------------------------------------------------------
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}
async function sendLeadEmail(lead) {
  const t = getTransporter();
  const legalName = getSetting('legal_name', '') || getSetting('brand_name', 'Mobirapid');
  const gstin = getSetting('gstin', '');
  const subject = `New Mobirapid lead: ${lead.name} (${lead.requirement || 'N/A'})`;
  const body = `A new lead was submitted on the Mobirapid landing page.

Name:          ${lead.name}
Phone:         ${lead.phone} (verified: ${lead.phone_verified ? 'yes' : 'no'})
Type:          ${lead.client_type || '-'}
Company:       ${lead.company_name || '-'}
Company email: ${lead.company_email || '-'}
Requirement:   ${lead.requirement || '-'}
Budget:        ${lead.budget || '-'}
Best time:     ${lead.best_time || '-'}
Message:       ${lead.message || '-'}
Submitted at:  ${lead.created_at} UTC

—
${legalName}${gstin ? '\nGSTIN: ' + gstin : ''}
`;
  if (!t) {
    console.log('\n[EMAIL MOCK] (SMTP not configured) Would send to', LEAD_NOTIFY_TO);
    console.log(body);
    return;
  }
  await t.sendMail({
    from: process.env.MAIL_FROM || 'Mobirapid Leads <no-reply@mobirapid.com>',
    to: LEAD_NOTIFY_TO,
    subject,
    text: body,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePhone(p) {
  if (!p) return '';
  const trimmed = String(p).trim().replace(/[\s\-()]/g, '');
  if (/^\+?\d{8,15}$/.test(trimmed)) return trimmed.startsWith('+') ? trimmed : '+' + trimmed;
  return '';
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }
function genOtp() { return ('' + crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function sendSms(phone, code) {
  const text = `Your Mobirapid verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`;
  if (OTP_PROVIDER === 'twilio' && twilioClient) {
    const opts = { to: phone, body: text };
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) opts.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    else opts.from = process.env.TWILIO_FROM_NUMBER;
    await twilioClient.messages.create(opts);
    return;
  }
  console.log(`\n[OTP MOCK] Code for ${phone}: ${code}\n`);
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const submitLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// ===========================================================================
// PUBLIC API
// ===========================================================================

// Site content for the landing page
app.get('/api/site', (req, res) => {
  const s = getAllSettings();
  const models = db
    .prepare('SELECT * FROM macbook_models WHERE active = 1 ORDER BY sort_order ASC, id ASC')
    .all();
  const pages = db
    .prepare('SELECT slug, title FROM content_pages ORDER BY sort_order ASC, title ASC')
    .all();
  const reviewsEnabled = getSetting('reviews_enabled', '0') === '1';
  const reviews = reviewsEnabled
    ? db.prepare('SELECT id, author, rating, text, date_label FROM reviews WHERE active = 1 ORDER BY sort_order ASC, id ASC').all()
    : [];
  res.json({
    ok: true,
    settings: {
      ...s,
      reviews_enabled: reviewsEnabled,
      about_enabled: getSetting('about_enabled', '1') === '1',
      contact_enabled: getSetting('contact_enabled', '1') === '1',
      usps_enabled: getSetting('usps_enabled', '1') === '1',
      usps: parseJsonSetting('usps', []),
      trust_points: parseJsonSetting('trust_points', []),
      requirement_options: parseJsonSetting('requirement_options', []),
      budget_options: parseJsonSetting('budget_options', []),
    },
    models,
    pages,
    reviews,
  });
});

// Compliance / content page (server-rendered)
app.get('/p/:slug', (req, res) => {
  const page = db.prepare('SELECT * FROM content_pages WHERE slug = ?').get(req.params.slug);
  if (!page) return res.status(404).send('Page not found');
  const brand = esc(getSetting('brand_name', 'Mobirapid'));
  const logo = getSetting('logo_path', '');
  const footer = esc(getSetting('footer_text', ''));
  const pages = db.prepare('SELECT slug, title FROM content_pages ORDER BY sort_order ASC').all();
  const footerLinks = pages
    .map((p) => `<a href="/p/${esc(p.slug)}">${esc(p.title)}</a>`)
    .join(' · ');
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(page.title)} — ${brand}</title>
<link rel="stylesheet" href="/styles.css">
</head><body>
<header class="site-header"><div class="container header-inner">
  <a class="brand" href="/">${logo ? `<img class="brand-logo" src="${esc(logo)}" alt="${brand}">` : `<span class="brand-mark">${brand.charAt(0)}</span>`}<span class="brand-name">${brand}</span></a>
  <a class="header-cta" href="/#lead-form">${esc(getSetting('header_cta_text', 'Book Consultation'))}</a>
</div></header>
<main class="container page-body">
  <a class="back-link" href="/">← Back to home</a>
  <h1>${esc(page.title)}</h1>
  <div class="page-content">${page.content || ''}</div>
</main>
<footer class="site-footer"><div class="container footer-inner">
  <span>${footer}</span>
  <span class="footer-links">${footerLinks}</span>
</div></footer>
</body></html>`);
});

// Send OTP
app.post('/api/otp/send', otpLimiter, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'Please enter a valid phone number with country code.' });
  const code = genOtp();
  const expires = Date.now() + OTP_TTL_MINUTES * 60 * 1000;
  db.prepare(
    `INSERT INTO otps (phone, code, expires_at, attempts, verified) VALUES (?, ?, ?, 0, 0)
     ON CONFLICT(phone) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, attempts=0, verified=0`
  ).run(phone, code, expires);
  try {
    await sendSms(phone, code);
  } catch (e) {
    console.error('SMS send failed:', e.message);
    return res.status(502).json({ ok: false, error: 'Could not send the code. Please try again.' });
  }
  res.json({ ok: true, message: 'Verification code sent.', mock: OTP_PROVIDER !== 'twilio' });
});

// Verify OTP
app.post('/api/otp/verify', otpLimiter, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (!phone || !code) return res.status(400).json({ ok: false, error: 'Phone and code are required.' });
  const row = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  if (!row) return res.status(400).json({ ok: false, error: 'Please request a code first.' });
  if (Date.now() > row.expires_at) return res.status(400).json({ ok: false, error: 'Code expired. Request a new one.' });
  if (row.attempts >= 5) return res.status(429).json({ ok: false, error: 'Too many attempts. Request a new code.' });
  if (row.code !== code) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return res.status(400).json({ ok: false, error: 'Incorrect code.' });
  }
  db.prepare('UPDATE otps SET verified = 1 WHERE phone = ?').run(phone);
  res.json({ ok: true, message: 'Phone verified.' });
});

// Submit lead
app.post('/api/lead', submitLimiter, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const phone = normalizePhone(b.phone);
  const clientType = String(b.client_type || '').trim();
  const companyName = String(b.company_name || '').trim();
  const companyEmail = String(b.company_email || '').trim();
  const requirement = String(b.requirement || '').trim();
  const budget = String(b.budget || '').trim();
  const bestTime = String(b.best_time || '').trim();
  const message = String(b.message || '').trim().slice(0, 2000);

  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  if (!phone) return res.status(400).json({ ok: false, error: 'A valid phone number is required.' });

  if (clientType === 'Company') {
    if (!companyName) return res.status(400).json({ ok: false, error: 'Company name is required.' });
    if (!isEmail(companyEmail)) return res.status(400).json({ ok: false, error: 'A valid company email is required.' });
  }

  const otp = db.prepare('SELECT verified FROM otps WHERE phone = ?').get(phone);
  if (!otp || otp.verified !== 1) return res.status(400).json({ ok: false, error: 'Please verify your phone number first.' });

  const info = db.prepare(
    `INSERT INTO leads (name, phone, phone_verified, client_type, company_name, company_email, requirement, budget, best_time, message)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, phone, clientType, companyName, companyEmail, requirement, budget, bestTime, message);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(info.lastInsertRowid));
  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  try { await sendLeadEmail(lead); } catch (e) { console.error('Lead email failed (lead still saved):', e.message); }
  res.json({ ok: true, message: 'Thanks! Your consultation request has been received. Our team will reach out shortly.' });
});

// ===========================================================================
// ADMIN AUTH
// ===========================================================================
function signToken(user) {
  const payload = Buffer.from(JSON.stringify({ user, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
}
function requireAdmin(req, res, next) {
  const data = verifyToken(req.cookies.admin_session);
  if (!data) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
    return res.redirect('/admin/login');
  }
  next();
}

app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    res.cookie('admin_session', signToken(username), { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});
app.post('/admin/logout', (req, res) => { res.clearCookie('admin_session'); res.redirect('/admin/login'); });
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

// ===========================================================================
// ADMIN API
// ===========================================================================

// Leads
app.get('/api/admin/leads', requireAdmin, (req, res) => {
  res.json({ ok: true, leads: db.prepare('SELECT * FROM leads ORDER BY id DESC').all() });
});
app.get('/api/admin/leads.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  const cols = ['id', 'name', 'phone', 'phone_verified', 'client_type', 'company_name', 'company_email', 'requirement', 'budget', 'best_time', 'message', 'created_at'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="mobirapid-leads.csv"');
  res.send(csv);
});

// Settings (branding, header/footer, options)
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({ ok: true, settings: getAllSettings() });
});
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  // For array-type settings sent as arrays, store as JSON
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) setSetting(k, JSON.stringify(v.map((x) => String(x).trim()).filter(Boolean)));
    else setSetting(k, v);
  }
  res.json({ ok: true, message: 'Saved.' });
});

// Image upload — returns the public path
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    res.json({ ok: true, path: '/uploads/' + req.file.filename });
  });
});

// Delete an uploaded image file from disk
app.post('/api/admin/upload/delete', requireAdmin, (req, res) => {
  const p = String((req.body && req.body.path) || '');
  // Only allow simple filenames inside /uploads/ (no path traversal)
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(p)) {
    return res.status(400).json({ ok: false, error: 'Invalid path.' });
  }
  const fp = path.join(UPLOAD_DIR, path.basename(p));
  fs.unlink(fp, () => {}); // ignore "file not found" etc.
  res.json({ ok: true });
});

// MacBook models CRUD
app.get('/api/admin/models', requireAdmin, (req, res) => {
  res.json({ ok: true, models: db.prepare('SELECT * FROM macbook_models ORDER BY sort_order ASC, id ASC').all() });
});
function modelFromBody(b) {
  return {
    name: String(b.name || '').trim(),
    price: String(b.price || '').trim(),
    image: String(b.image || '').trim(),
    specs: String(b.specs || '').trim(),
    badge: String(b.badge || '').trim(),
    condition_grade: String(b.condition_grade || '').trim(),
    warranty: String(b.warranty || '').trim(),
    sort_order: parseInt(b.sort_order || '0', 10) || 0,
    active: b.active === false || b.active === 'false' || b.active === 0 ? 0 : 1,
  };
}
app.post('/api/admin/models', requireAdmin, (req, res) => {
  const m = modelFromBody(req.body);
  if (!m.name) return res.status(400).json({ ok: false, error: 'Model name is required.' });
  const info = db.prepare(
    `INSERT INTO macbook_models (name, price, image, specs, badge, condition_grade, warranty, sort_order, active)
     VALUES (@name, @price, @image, @specs, @badge, @condition_grade, @warranty, @sort_order, @active)`
  ).run(m);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.put('/api/admin/models/:id', requireAdmin, (req, res) => {
  const m = modelFromBody(req.body);
  if (!m.name) return res.status(400).json({ ok: false, error: 'Model name is required.' });
  db.prepare(
    `UPDATE macbook_models SET name=@name, price=@price, image=@image, specs=@specs, badge=@badge,
     condition_grade=@condition_grade, warranty=@warranty, sort_order=@sort_order, active=@active WHERE id=@id`
  ).run({ ...m, id: parseInt(req.params.id, 10) });
  res.json({ ok: true });
});
app.delete('/api/admin/models/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM macbook_models WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Reviews CRUD (Google Reviews integration — curated entries)
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
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
app.post('/api/admin/reviews', requireAdmin, (req, res) => {
  const r = reviewFromBody(req.body);
  if (!r.author) return res.status(400).json({ ok: false, error: 'Reviewer name is required.' });
  const info = db.prepare(
    'INSERT INTO reviews (author, rating, text, date_label, sort_order, active) VALUES (@author, @rating, @text, @date_label, @sort_order, @active)'
  ).run(r);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.put('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const r = reviewFromBody(req.body);
  if (!r.author) return res.status(400).json({ ok: false, error: 'Reviewer name is required.' });
  db.prepare(
    'UPDATE reviews SET author=@author, rating=@rating, text=@text, date_label=@date_label, sort_order=@sort_order, active=@active WHERE id=@id'
  ).run({ ...r, id: parseInt(req.params.id, 10) });
  res.json({ ok: true });
});
app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Content / compliance pages
app.get('/api/admin/pages', requireAdmin, (req, res) => {
  res.json({ ok: true, pages: db.prepare('SELECT * FROM content_pages ORDER BY sort_order ASC').all() });
});
app.put('/api/admin/pages/:slug', requireAdmin, (req, res) => {
  const slug = req.params.slug;
  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '');
  const exists = db.prepare('SELECT slug FROM content_pages WHERE slug = ?').get(slug);
  if (!exists) return res.status(404).json({ ok: false, error: 'Page not found.' });
  db.prepare("UPDATE content_pages SET title=?, content=?, updated_at=datetime('now') WHERE slug=?")
    .run(title || exists.title, content, slug);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\nMobirapid lead-gen running:  http://localhost:${PORT}`);
  console.log(`Admin panel:                 http://localhost:${PORT}/admin`);
  console.log(`OTP provider: ${OTP_PROVIDER}${OTP_PROVIDER !== 'twilio' ? '  (codes printed to this console)' : ''}`);
  console.log(`Lead emails -> ${LEAD_NOTIFY_TO}${getTransporter() ? '' : '  (SMTP not set: emails printed to console)'}\n`);
});
