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

// Behind LiteSpeed/Passenger (cPanel), Node sits behind a reverse proxy.
// Trust it so Express reads the real client IP and protocol from X-Forwarded-* headers.
app.set('trust proxy', 1);

// Force HTTPS — only when actually proxied over http (skips local dev, which has no proxy header).
app.use((req, res, next) => {
  const xfp = req.headers['x-forwarded-proto'];
  if (xfp && xfp !== 'https' && !req.secure) {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// Security headers
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// Integration settings that must NEVER be exposed in the public /api/site response.
const PRIVATE_KEYS = new Set([
  'otp_provider', 'otp_ttl_minutes',
  'twilio_account_sid', 'twilio_auth_token', 'twilio_messaging_service_sid', 'twilio_from_number',
  'twofactor_api_key', 'twofactor_template_name',
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'mail_from', 'lead_notify_to',
  'ga_measurement_id', 'head_code', 'body_code',
  'google_place_id', 'google_places_api_key',
]);

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
// Dynamic config: read from DB settings first, fall back to env, then default.
// This lets the admin manage SMS/email credentials from the panel.
// ---------------------------------------------------------------------------
function cfg(key, envName, def = '') {
  const v = getSetting(key, '');
  if (v !== '' && v != null) return v;
  if (envName && process.env[envName]) return process.env[envName];
  return def;
}
const otpProvider = () => String(cfg('otp_provider', 'OTP_PROVIDER', 'mock')).toLowerCase();
const otpTtlMinutes = () => parseInt(cfg('otp_ttl_minutes', 'OTP_TTL_MINUTES', '10'), 10) || 10;
const leadNotifyTo = () => cfg('lead_notify_to', 'LEAD_NOTIFY_TO', 'sachin@mobirapid.com');

// ---------------------------------------------------------------------------
// Mailer (built fresh from current config)
// ---------------------------------------------------------------------------
function buildTransporter() {
  const host = cfg('smtp_host', 'SMTP_HOST');
  const user = cfg('smtp_user', 'SMTP_USER');
  if (!host || !user) return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(cfg('smtp_port', 'SMTP_PORT', '587'), 10),
    secure: String(cfg('smtp_secure', 'SMTP_SECURE', 'false')) === 'true',
    auth: { user, pass: cfg('smtp_pass', 'SMTP_PASS') },
  });
}
async function sendLeadEmail(lead) {
  const t = buildTransporter();
  const to = leadNotifyTo();
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
    console.log('\n[EMAIL MOCK] (SMTP not configured) Would send to', to);
    console.log(body);
    return;
  }
  await t.sendMail({
    from: cfg('mail_from', 'MAIL_FROM') || 'Mobirapid Leads <no-reply@mobirapid.com>',
    to,
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
  const provider = otpProvider();
  const text = `Your Mobirapid verification code is ${code}. It expires in ${otpTtlMinutes()} minutes.`;

  // --- 2Factor.in (India) ---
  if (provider === '2factor') {
    const apiKey = cfg('twofactor_api_key', 'TWOFACTOR_API_KEY');
    if (!apiKey) throw new Error('2Factor API key is not set.');
    const tpl = cfg('twofactor_template_name', 'TWOFACTOR_TEMPLATE');
    const num = phone.replace(/\D/g, ''); // 2Factor accepts digits (with country code)
    let url = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${num}/${code}`;
    if (tpl) url += `/${encodeURIComponent(tpl)}`;
    const resp = await fetch(url);
    let data = {};
    try { data = await resp.json(); } catch (e) {}
    if (!resp.ok || (data.Status && data.Status !== 'Success')) {
      throw new Error('2Factor: ' + (data.Details || ('HTTP ' + resp.status)));
    }
    return;
  }

  // --- Twilio ---
  if (provider === 'twilio') {
    const sid = cfg('twilio_account_sid', 'TWILIO_ACCOUNT_SID');
    const token = cfg('twilio_auth_token', 'TWILIO_AUTH_TOKEN');
    if (!sid || !token) throw new Error('Twilio credentials are not set.');
    const client = require('twilio')(sid, token);
    const opts = { to: phone, body: text };
    const msgSid = cfg('twilio_messaging_service_sid', 'TWILIO_MESSAGING_SERVICE_SID');
    if (msgSid) opts.messagingServiceSid = msgSid;
    else opts.from = cfg('twilio_from_number', 'TWILIO_FROM_NUMBER');
    await client.messages.create(opts);
    return;
  }

  // --- Mock (default) ---
  console.log(`\n[OTP MOCK] Code for ${phone}: ${code}\n`);
}

// ---------------------------------------------------------------------------
// Live Google rating (Google Places API), cached to limit API calls.
// ---------------------------------------------------------------------------
let gCache = { rating: null, count: null, reviews: [], at: 0, error: '' };
const G_TTL = 6 * 60 * 60 * 1000; // 6 hours
async function refreshGoogleRating() {
  const key = getSetting('google_places_api_key', '');
  const pid = getSetting('google_place_id', '');
  if (!key || !pid) { gCache = { rating: null, count: null, reviews: [], at: Date.now(), error: 'API key or Place ID missing' }; return gCache; }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(pid)}&fields=rating,user_ratings_total,reviews&reviews_sort=newest&key=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    const d = await r.json();
    if (d.status === 'OK' && d.result) {
      const reviews = (d.result.reviews || []).map((rv) => ({
        author: rv.author_name || 'Google user', rating: rv.rating || 5,
        text: rv.text || '', date_label: rv.relative_time_description || '',
      }));
      gCache = { rating: d.result.rating ?? null, count: d.result.user_ratings_total ?? null, reviews, at: Date.now(), error: '' };
    } else {
      gCache = { rating: gCache.rating, count: gCache.count, reviews: gCache.reviews, at: Date.now(), error: (d.status || 'ERROR') + (d.error_message ? ': ' + d.error_message : '') };
    }
  } catch (e) {
    gCache = { rating: gCache.rating, count: gCache.count, reviews: gCache.reviews, at: Date.now(), error: e.message };
  }
  return gCache;
}
function googleLiveEnabled() { return getSetting('google_reviews_live', '0') === '1' && getSetting('google_places_api_key', '') && getSetting('google_place_id', ''); }

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const submitLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

// ===========================================================================
// PUBLIC PAGES (SEO meta + analytics injected server-side)
// ===========================================================================
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
let indexTemplate = null;
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return `${proto}://${req.headers.host || 'mobirapid.in'}`;
}
function renderIndex(req) {
  if (indexTemplate == null) indexTemplate = fs.readFileSync(INDEX_PATH, 'utf8');
  const base = baseUrl(req);
  const canonical = base + '/';
  const title = getSetting('meta_title', '') || getSetting('brand_name', 'Mobirapid');
  const desc = getSetting('meta_description', '');
  const kw = getSetting('meta_keywords', '');
  let ogImg = getSetting('og_image', '') || getSetting('banner_image', '');
  if (ogImg && ogImg.startsWith('/')) ogImg = base + ogImg;
  const seo =
    `<title>${esc(title)}</title>\n` +
    `<meta name="description" content="${esc(desc)}">\n` +
    (kw ? `<meta name="keywords" content="${esc(kw)}">\n` : '') +
    `<link rel="canonical" href="${canonical}">\n` +
    `<meta property="og:title" content="${esc(title)}">\n` +
    `<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:type" content="website">\n` +
    `<meta property="og:url" content="${canonical}">\n` +
    (ogImg ? `<meta property="og:image" content="${esc(ogImg)}">\n` : '') +
    `<meta name="twitter:card" content="summary_large_image">`;
  const ga = getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '');
  let head = ga
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga}"></script>\n` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga}');</script>\n`
    : '';
  head += buildJsonLd(base);
  head += getSetting('head_code', ''); // raw admin-provided code (GTM, pixel, verification…)
  const body = getSetting('body_code', '');
  return indexTemplate
    .replace('<!--SEO_META-->', seo)
    .replace('<!--HEAD_CODE-->', head)
    .replace('<!--BODY_CODE-->', body);
}
// Structured data (schema.org) for rich results.
function buildJsonLd(base) {
  const abs = (u) => (u && u.startsWith('/') ? base + u : u);
  const brand = getSetting('brand_name', 'Mobirapid');
  const org = { '@type': 'Organization', '@id': base + '/#org', name: getSetting('legal_name', '') || brand, url: base + '/' };
  const logo = getSetting('logo_path', '');
  if (logo) org.logo = abs(logo);
  const email = getSetting('customer_care_email', '') || getSetting('footer_email', '');
  if (email) org.email = email;
  const phone = getSetting('customer_care_phone', '') || getSetting('social_phone', '');
  if (phone) org.telephone = phone;
  const addr = getSetting('registered_address', '');
  if (addr) org.address = { '@type': 'PostalAddress', streetAddress: addr, addressCountry: 'IN' };
  const same = ['social_instagram', 'social_facebook', 'social_linkedin'].map((k) => getSetting(k, '')).filter(Boolean);
  if (same.length) org.sameAs = same;
  if (getSetting('reviews_enabled', '0') === '1') {
    let rating = parseFloat(getSetting('google_rating', ''));
    let count = parseInt(getSetting('google_review_count', ''), 10);
    if (googleLiveEnabled() && gCache.rating != null) { rating = gCache.rating; count = gCache.count || 0; }
    if (rating > 0 && count > 0) org.aggregateRating = { '@type': 'AggregateRating', ratingValue: rating, reviewCount: count };
  }

  const graph = [org];
  const models = db.prepare('SELECT * FROM macbook_models WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
  for (const m of models) {
    const product = {
      '@type': 'Product', name: m.name, description: m.description || m.specs || m.name,
      brand: { '@type': 'Brand', name: 'Apple' }, category: 'Refurbished Laptop',
      itemCondition: 'https://schema.org/RefurbishedCondition',
    };
    if (m.image) product.image = abs(m.image);
    const priceNum = String(m.price || '').replace(/[^\d.]/g, '');
    if (priceNum) {
      product.offers = {
        '@type': 'Offer', price: priceNum, priceCurrency: 'INR',
        availability: /sold/i.test(m.badge || '') ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
        url: base + '/#lead-form', seller: { '@id': base + '/#org' },
      };
    }
    graph.push(product);
  }
  const json = JSON.stringify(graph).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>\n`;
}
app.get('/', (req, res) => res.type('html').send(renderIndex(req)));

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /manage\nDisallow: /api/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const base = baseUrl(req);
  const pages = db.prepare('SELECT slug FROM content_pages ORDER BY sort_order').all();
  const urls = ['/'].concat(pages.map((p) => '/p/' + p.slug));
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${base}${u}</loc></url>`).join('\n') +
    `\n</urlset>`;
  res.type('application/xml').send(xml);
});

// ===========================================================================
// PUBLIC API
// ===========================================================================

// Site content for the landing page
app.get('/api/site', (req, res) => {
  const all = getAllSettings();
  const s = {};
  for (const k of Object.keys(all)) if (!PRIVATE_KEYS.has(k)) s[k] = all[k]; // never expose secrets
  const models = db
    .prepare('SELECT * FROM macbook_models WHERE active = 1 ORDER BY sort_order ASC, id ASC')
    .all();
  const pages = db
    .prepare('SELECT slug, title FROM content_pages ORDER BY sort_order ASC, title ASC')
    .all();
  const reviewsEnabled = getSetting('reviews_enabled', '0') === '1';
  let reviews = reviewsEnabled
    ? db.prepare('SELECT id, author, rating, text, date_label FROM reviews WHERE active = 1 ORDER BY sort_order ASC, id ASC').all()
    : [];
  // Live Google rating (overrides the manual rating/count, and reviews if available)
  if (googleLiveEnabled()) {
    if (Date.now() - gCache.at > G_TTL) refreshGoogleRating(); // async refresh; serve cached meanwhile
    if (gCache.rating != null) { s.google_rating = String(gCache.rating); s.google_review_count = String(gCache.count || 0); }
    if (reviewsEnabled && gCache.reviews && gCache.reviews.length) reviews = gCache.reviews;
  }
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

// security.txt (RFC 9116) — how to report a security issue. Expires auto-renews.
app.get(['/.well-known/security.txt', '/security.txt'], (req, res) => {
  const email = getSetting('customer_care_email', '') || getSetting('footer_email', '') || 'security@mobirapid.com';
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const host = req.headers.host || 'mobirapid.com';
  res.type('text/plain').send(
    `Contact: mailto:${email}\n` +
    `Expires: ${expires}\n` +
    `Preferred-Languages: en\n` +
    `Canonical: https://${host}/.well-known/security.txt\n`
  );
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
  const headCode = getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '')
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '')}"></script>` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '')}');</script>`
    : '';
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(page.title)} — ${brand}</title>
<meta name="description" content="${esc(page.title)} — ${brand}">
<link rel="canonical" href="${baseUrl(req)}/p/${esc(req.params.slug)}">
<link rel="stylesheet" href="/styles.css">
${headCode}${getSetting('head_code', '')}
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
  const expires = Date.now() + otpTtlMinutes() * 60 * 1000;
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
  res.json({ ok: true, message: 'Verification code sent.', mock: otpProvider() === 'mock' });
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
// ADMIN AUTH  (roles: "admin" = full access, "leads" = leads only)
// ===========================================================================
function signToken(user, role) {
  const payload = Buffer.from(JSON.stringify({ user, role, t: Date.now() })).toString('base64url');
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
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [salt, h] = String(stored).split(':');
    const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(test, 'hex'));
  } catch { return false; }
}
// Authenticate the request and return the token payload, or null.
function authOf(req) { return verifyToken(req.cookies.admin_session); }

function requireAdmin(req, res, next) {
  const data = authOf(req);
  if (!data) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
    return res.redirect('/manage/login');
  }
  req.authUser = data;
  next();
}

// Gate for all /api/admin/* routes: any logged-in user may use the leads (and /me)
// endpoints; everything else requires the full "admin" role.
app.use('/api/admin', (req, res, next) => {
  const data = authOf(req);
  if (!data) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  req.authUser = data;
  // Tokens issued before roles existed have no role — treat them as full admin
  // (only the .env admin could have logged in back then).
  const role = data.role || 'admin';
  const leadsOk = req.path === '/me' || req.path.startsWith('/leads');
  if (leadsOk || role === 'admin') return next();
  return res.status(403).json({ ok: false, error: 'You do not have access to this section.' });
});

// Admin UI lives at /manage (not /admin) to avoid clashing with a /admin path
// that some hosts/other apps occupy. The /api/admin/* API paths are unaffected.
app.get(['/manage/login', '/admin/login'], (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post(['/manage/login', '/admin/login'], (req, res) => {
  const { username, password } = req.body;
  let role = null;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    role = 'admin';
  } else {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    if (u && verifyPassword(password, u.pass_hash)) role = u.role || 'leads';
  }
  if (role) {
    res.cookie('admin_session', signToken(username, role), { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
    return res.redirect('/manage');
  }
  res.redirect('/manage/login?error=1');
});
app.post(['/manage/logout', '/admin/logout'], (req, res) => { res.clearCookie('admin_session'); res.redirect('/manage/login'); });
app.get(['/manage', '/admin'], requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

// ===========================================================================
// ADMIN API
// ===========================================================================

// Who am I (used by the admin UI to show/hide tabs by role)
app.get('/api/admin/me', (req, res) => res.json({ ok: true, user: req.authUser.user, role: req.authUser.role || 'admin' }));

// User management (full admin only — enforced by the gate above)
app.get('/api/admin/users', (req, res) => {
  res.json({ ok: true, users: db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id DESC').all() });
});
app.post('/api/admin/users', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ ok: false, error: 'Username must be 3-40 chars (letters, numbers, . _ -).' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  if (username === ADMIN_USER) return res.status(400).json({ ok: false, error: 'That username is reserved.' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ ok: false, error: 'That username already exists.' });
  db.prepare('INSERT INTO users (username, pass_hash, role) VALUES (?, ?, ?)').run(username, hashPassword(password), 'leads');
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Leads
app.get('/api/admin/leads', requireAdmin, (req, res) => {
  res.json({ ok: true, leads: db.prepare('SELECT * FROM leads ORDER BY id DESC').all() });
});
const LEAD_STATUSES = ['New', 'Contacted', 'Converted', 'Lost'];
app.put('/api/admin/leads/:id', requireAdmin, (req, res) => {
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
    message: String(b.message || '').trim().slice(0, 2000),
    status: LEAD_STATUSES.includes(b.status) ? b.status : 'New',
  };
  if (!lead.name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  db.prepare(
    `UPDATE leads SET name=@name, phone=@phone, client_type=@client_type, company_name=@company_name,
     company_email=@company_email, requirement=@requirement, budget=@budget, best_time=@best_time,
     message=@message, status=@status WHERE id=@id`
  ).run(lead);
  res.json({ ok: true });
});
// Quick status change (inline dropdown)
app.post('/api/admin/leads/:id/status', requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!LEAD_STATUSES.includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status.' });
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, parseInt(req.params.id, 10));
  res.json({ ok: true });
});
app.delete('/api/admin/leads/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
// Bulk delete
app.post('/api/admin/leads/bulk-delete', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'No leads selected.' });
  const del = db.prepare('DELETE FROM leads WHERE id = ?');
  db.exec('BEGIN');
  try { for (const id of ids) del.run(id); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ ok: false, error: 'Delete failed.' }); }
  res.json({ ok: true, deleted: ids.length });
});
app.get('/api/admin/leads.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  const cols = ['id', 'name', 'phone', 'phone_verified', 'client_type', 'company_name', 'company_email', 'requirement', 'budget', 'best_time', 'status', 'message', 'created_at'];
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

// Test the configured SMS provider
app.post('/api/admin/test-sms', requireAdmin, async (req, res) => {
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
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
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
    description: String(b.description || '').trim().slice(0, 600),
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
    `INSERT INTO macbook_models (name, price, image, specs, description, badge, condition_grade, warranty, sort_order, active)
     VALUES (@name, @price, @image, @specs, @description, @badge, @condition_grade, @warranty, @sort_order, @active)`
  ).run(m);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.put('/api/admin/models/:id', requireAdmin, (req, res) => {
  const m = modelFromBody(req.body);
  if (!m.name) return res.status(400).json({ ok: false, error: 'Model name is required.' });
  db.prepare(
    `UPDATE macbook_models SET name=@name, price=@price, image=@image, specs=@specs, description=@description, badge=@badge,
     condition_grade=@condition_grade, warranty=@warranty, sort_order=@sort_order, active=@active WHERE id=@id`
  ).run({ ...m, id: parseInt(req.params.id, 10) });
  res.json({ ok: true });
});
app.delete('/api/admin/models/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM macbook_models WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Fetch the live Google rating now (admin "Fetch now" button)
app.post('/api/admin/google/refresh', requireAdmin, async (req, res) => {
  const c = await refreshGoogleRating();
  if (c.error) return res.status(502).json({ ok: false, error: c.error });
  res.json({ ok: true, rating: c.rating, count: c.count, reviews: c.reviews.length });
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
  console.log(`Admin panel:                 http://localhost:${PORT}/manage`);
  const prov = otpProvider();
  console.log(`OTP provider: ${prov}${prov === 'mock' ? '  (codes printed to this console)' : ''}`);
  console.log(`Lead emails -> ${leadNotifyTo()}${buildTransporter() ? '' : '  (SMTP not set: emails printed to console)'}`);
  console.log(`Configure SMS/email from the admin → "SMS & Email" tab.\n`);
});
