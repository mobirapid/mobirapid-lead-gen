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
// Long-lived caching for static assets. Uploaded images have unique filenames and
// CSS/JS are cache-busted with ?v=ASSET_VER, so everything is safe to cache for a year.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(?:jpg|jpeg|png|webp|gif|svg|ico|woff2?|ttf)$/i.test(filePath) || /[\\/]uploads[\\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(?:css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
// Cache-busting version for CSS/JS (changes whenever those files change on deploy).
const ASSET_VER = (() => {
  try {
    const parts = ['styles.css', 'app.js', 'icons.js', 'admin.js'].map((f) => {
      try { return fs.statSync(path.join(__dirname, 'public', f)).mtimeMs; } catch { return 0; }
    });
    return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 8);
  } catch { return String(Date.now()); }
})();
function ver(p) { return p + (p.includes('?') ? '&' : '?') + 'v=' + ASSET_VER; }

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
  'fb_capi_enabled', 'fb_pixel_id', 'fb_capi_token',
  'payu_merchant_key', 'payu_salt', 'payu_mode',
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
Interested in: ${lead.interested_model || '-'}
Budget:        ${lead.budget || '-'}
Call type:     ${lead.call_type || '-'}
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
// Meta (Facebook) Conversions API — server-side "Lead" event.
// ---------------------------------------------------------------------------
function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
async function sendMetaCapiLead(lead, req, meta) {
  if (getSetting('fb_capi_enabled', '0') !== '1') return;
  const pixel = getSetting('fb_pixel_id', '').trim();
  const token = getSetting('fb_capi_token', '').trim();
  if (!pixel || !token) return;
  try {
    const phoneDigits = String(lead.phone || '').replace(/[^\d]/g, '');
    const email = String(lead.company_email || '').trim().toLowerCase();
    const user_data = {
      client_ip_address: req.ip,
      client_user_agent: req.headers['user-agent'] || '',
    };
    if (phoneDigits) user_data.ph = [sha256(phoneDigits)];
    if (email) user_data.em = [sha256(email)];
    if (lead.name) user_data.fn = [sha256(String(lead.name).trim().toLowerCase())];
    if (meta.fbp) user_data.fbp = meta.fbp;
    if (meta.fbc) user_data.fbc = meta.fbc;
    const event = {
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_source_url: meta.sourceUrl || (baseUrl(req) + '/'),
      event_id: meta.eventId || undefined,
      user_data,
      custom_data: { content_name: 'Consultation request' },
    };
    const r = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(pixel)}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event], access_token: token }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); console.error('Meta CAPI error:', (d.error && d.error.message) || r.status); }
  } catch (e) {
    console.error('Meta CAPI failed:', e.message);
  }
}

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
  // Prefer the configured canonical site URL so canonical/OG/sitemap are consistent
  // across domains (e.g. .in and .com) — avoids duplicate-content issues.
  const configured = getSetting('site_url', '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return `${proto}://${req.headers.host || 'mobirapid.in'}`;
}
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap';
const HEAD_COMMON =
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
  // Load fonts without blocking render (was a render-blocking @import in the CSS).
  `<link rel="preload" as="style" href="${FONT_HREF}" onload="this.onload=null;this.rel='stylesheet'">` +
  `<noscript><link rel="stylesheet" href="${FONT_HREF}"></noscript>` +
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' +
  '<link rel="icon" href="/favicon.ico" sizes="any">' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';
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
    HEAD_COMMON + '\n' +
    `<meta property="og:site_name" content="${esc(getSetting('brand_name', 'Mobirapid'))}">\n` +
    `<meta property="og:title" content="${esc(title)}">\n` +
    `<meta property="og:description" content="${esc(desc)}">\n` +
    `<meta property="og:type" content="website">\n` +
    `<meta property="og:url" content="${canonical}">\n` +
    (ogImg ? `<meta property="og:image" content="${esc(ogImg)}">\n` : '') +
    `<meta name="twitter:card" content="summary_large_image">\n` +
    `<meta name="twitter:title" content="${esc(title)}">\n` +
    `<meta name="twitter:description" content="${esc(desc)}">\n` +
    (ogImg ? `<meta name="twitter:image" content="${esc(ogImg)}">` : '');
  const ga = getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '');
  let head = ga
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga}"></script>\n` +
      `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga}');</script>\n`
    : '';
  head += buildJsonLd(base);
  // Preload the hero (LCP) image so it starts downloading immediately.
  const bannerImg = getSetting('banner_image', '');
  if (bannerImg) head = `<link rel="preload" as="image" href="${esc(bannerImg)}" fetchpriority="high">\n` + head;
  head += getSetting('head_code', ''); // raw admin-provided code (GTM, pixel, verification…)
  const body = getSetting('body_code', '');
  let html = indexTemplate
    .replace('<!--SEO_META-->', seo)
    .replace('<!--HEAD_CODE-->', head)
    .replace('<!--BODY_CODE-->', body)
    .replace('href="/styles.css"', `href="${ver('/styles.css')}"`)
    .replace('src="/icons.js"', `src="${ver('/icons.js')}"`)
    .replace('src="/app.js"', `src="${ver('/app.js')}"`);
  // Server-render the hero background so LCP paints without waiting for JS.
  if (bannerImg) html = html.replace('<section class="hero" id="hero">', `<section class="hero has-image" id="hero" style="background-image:url('${esc(bannerImg)}')">`);
  // Server-render the above-the-fold hero text so crawlers see it without running JS.
  const eyebrow = getSetting('banner_eyebrow', '');
  const heading = getSetting('banner_heading', '');
  const sub = getSetting('banner_subtext', '');
  if (eyebrow) html = html.replace(/(<p class="eyebrow" id="eyebrow">)[\s\S]*?(<\/p>)/, `$1${esc(eyebrow)}$2`);
  if (heading) html = html.replace(/(<h1 id="heroHeading">)[\s\S]*?(<\/h1>)/, `$1${esc(heading)}$2`);
  if (sub) html = html.replace(/(<p class="lead" id="heroSub">)[\s\S]*?(<\/p>)/, `$1${esc(sub)}$2`);
  return html;
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
        availability: isSoldOut(m) ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
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
  const today = new Date().toISOString().slice(0, 10);
  const pages = db.prepare('SELECT slug FROM content_pages ORDER BY sort_order').all();
  const posts = db.prepare('SELECT slug, updated_at, created_at FROM blog_posts WHERE published = 1 ORDER BY id DESC').all();
  const cats = db.prepare('SELECT slug, url_prefix FROM categories WHERE active = 1').all();
  const prefixOf = {}; for (const c of cats) prefixOf[c.slug] = c.url_prefix;
  const prods = db.prepare(`SELECT m.slug, m.category FROM macbook_models m
    LEFT JOIN categories c ON c.slug = m.category
    WHERE m.active = 1 AND m.slug IS NOT NULL AND (c.active = 1 OR c.slug IS NULL) ORDER BY m.sort_order`).all();
  const entries = [
    { loc: '/', lastmod: today, priority: '1.0' },
    { loc: '/compare', lastmod: today, priority: '0.7' },
    { loc: '/condition', lastmod: today, priority: '0.5' },
    { loc: '/blog', lastmod: today, priority: '0.8' },
    ...cats.map((c) => ({ loc: '/c/' + c.slug, lastmod: today, priority: '0.8' })),
    ...prods.map((p) => ({ loc: '/' + (prefixOf[p.category] || 'macbook') + '/' + p.slug, lastmod: today, priority: '0.7' })),
    ...pages.map((p) => ({ loc: '/p/' + p.slug, lastmod: today, priority: '0.4' })),
    ...posts.map((p) => ({ loc: '/blog/' + p.slug, lastmod: String(p.updated_at || p.created_at || today).slice(0, 10), priority: '0.6' })),
  ];
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.map((e) => `  <url><loc>${base}${e.loc}</loc><lastmod>${e.lastmod}</lastmod><priority>${e.priority}</priority></url>`).join('\n') +
    `\n</urlset>`;
  res.type('application/xml').send(xml);
});

// ---------------------------------------------------------------------------
// Blog (server-rendered for SEO)
// ---------------------------------------------------------------------------
function siteHeaderHtml() {
  const brand = esc(getSetting('brand_name', 'Mobirapid'));
  const logo = getSetting('logo_path', '');
  return `<header class="site-header"><div class="container header-inner">
  <a class="brand" href="/">${logo ? `<img class="brand-logo" src="${esc(logo)}" alt="${brand}">` : `<span class="brand-mark">${brand.charAt(0)}</span>`}<span class="brand-name">${brand}</span></a>
  <nav class="header-nav">${db.prepare('SELECT slug, name FROM categories WHERE active = 1 ORDER BY sort_order ASC, id ASC').all().map((c) => `<a href="/c/${esc(c.slug)}">${esc(String(c.name).replace(/^Refurbished\s+/i, ''))}</a>`).join('')}<a href="/compare">Compare</a><a href="/condition">Condition</a><a href="/blog">Blog</a></nav>
  <a class="header-cta" href="/#lead-form">${esc(getSetting('header_cta_text', 'Book Consultation'))}</a>
</div></header>`;
}
function siteFooterHtml() {
  const legal = esc(getSetting('legal_name', '') || getSetting('brand_name', 'Mobirapid'));
  const pages = db.prepare('SELECT slug, title FROM content_pages ORDER BY sort_order ASC').all();
  const links = ['<a href="/blog">Blog</a>', '<a href="/condition">Condition grades</a>'].concat(pages.map((p) => `<a href="/p/${esc(p.slug)}">${esc(p.title)}</a>`)).join(' · ');
  return `<footer class="site-footer"><div class="footer-bottom"><div class="container footer-bottom-inner">
  <span>© ${new Date().getFullYear()} ${legal}. All rights reserved.</span>
  <span class="footer-links">${links}</span>
</div></div></footer>`;
}
function pageHead(req, title, desc, canonical, extra) {
  const ga = getSetting('ga_measurement_id', '').replace(/[^A-Za-z0-9-]/g, '');
  const gaTag = ga
    ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${ga}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga}');</script>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
${HEAD_COMMON}
<meta property="og:site_name" content="${esc(getSetting('brand_name', 'Mobirapid'))}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<link rel="stylesheet" href="${ver('/styles.css')}">
${gaTag}${getSetting('head_code', '')}${extra || ''}
</head><body>`;
}
function pageTail() { return `${siteFooterHtml()}${getSetting('body_code', '')}</body></html>`; }
function fmtBlogDate(s) {
  try { return new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; }
}

function postTags(p) { return String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean); }
function blogCardHtml(p, brand) {
  return `
    <a class="blog-card" href="/blog/${esc(p.slug)}">
      <div class="blog-cover" style="${p.cover_image ? `background-image:url('${esc(p.cover_image)}')` : ''}">${p.cover_image ? '' : '<span></span>'}</div>
      <div class="blog-card-body">
        <h3>${esc(p.title)}</h3>
        <p class="blog-excerpt">${esc(p.excerpt || '')}</p>
        <span class="blog-meta">${esc(p.author || brand)} · ${fmtBlogDate(p.created_at)}</span>
      </div>
    </a>`;
}
app.get('/blog', (req, res) => {
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const q = String(req.query.q || '').trim().toLowerCase();
  const tag = String(req.query.tag || '').trim().toLowerCase();
  let posts = db.prepare('SELECT slug, title, excerpt, cover_image, author, created_at, tags FROM blog_posts WHERE published = 1 ORDER BY id DESC').all();
  if (tag) posts = posts.filter((p) => postTags(p).map((t) => t.toLowerCase()).includes(tag));
  if (q) posts = posts.filter((p) => `${p.title} ${p.excerpt || ''} ${p.tags || ''}`.toLowerCase().includes(q));

  // Tag cloud from all published posts
  const allTags = {};
  for (const p of db.prepare('SELECT tags FROM blog_posts WHERE published = 1').all()) for (const t of postTags(p)) allTags[t] = (allTags[t] || 0) + 1;
  const tagChips = Object.keys(allTags).sort().map((t) =>
    `<a class="blog-tag${t.toLowerCase() === tag ? ' active' : ''}" href="/blog?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('');

  const PER_PAGE = 9;
  const totalPages = Math.max(1, Math.ceil(posts.length / PER_PAGE));
  let page = parseInt(req.query.page, 10) || 1;
  if (page < 1) page = 1; if (page > totalPages) page = totalPages;
  const pagePosts = posts.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const qs = (pg) => { const p = new URLSearchParams(); if (req.query.q) p.set('q', req.query.q); if (req.query.tag) p.set('tag', req.query.tag); if (pg > 1) p.set('page', pg); const s = p.toString(); return '/blog' + (s ? '?' + s : ''); };
  const pager = totalPages > 1
    ? `<div class="blog-pager">${page > 1 ? `<a href="${qs(page - 1)}">← Newer</a>` : '<span></span>'}<span class="blog-pager-info">Page ${page} of ${totalPages}</span>${page < totalPages ? `<a href="${qs(page + 1)}">Older →</a>` : '<span></span>'}</div>` : '';
  const cards = pagePosts.map((p) => blogCardHtml(p, brand)).join('');
  const heading = tag ? `Articles tagged "${esc(req.query.tag)}"` : q ? `Search: "${esc(req.query.q)}"` : esc(getSetting('blog_title', 'Blog'));
  const title = getSetting('blog_title', 'Blog') + ' — ' + brand;
  const desc = getSetting('blog_subtitle', '') || `${brand} blog — MacBook guides and Apple ecosystem tips.`;
  res.send(
    pageHead(req, title, desc, base + '/blog') +
    siteHeaderHtml() +
    `<main class="container page-body blog-index">
      <a class="back-link" href="/">← Back to home</a>
      <h1>${heading}</h1>
      <form class="blog-search" method="get" action="/blog"><input type="search" name="q" value="${esc(req.query.q || '')}" placeholder="Search articles…"><button type="submit">Search</button></form>
      ${tagChips ? `<div class="blog-tags-bar">${(tag || q) ? '<a class="blog-tag" href="/blog">All</a>' : ''}${tagChips}</div>` : ''}
      <div class="blog-grid">${cards || '<p class="muted">No articles found.</p>'}</div>
      ${pager}
    </main>` +
    pageTail()
  );
});

app.get('/blog/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM blog_posts WHERE slug = ? AND published = 1').get(req.params.slug);
  if (!post) return res.status(404).send('Post not found');
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const url = base + '/blog/' + esc(post.slug);
  const desc = post.meta_description || post.excerpt || post.title;
  const ld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title,
    description: post.excerpt || post.meta_description || post.title,
    datePublished: post.created_at, dateModified: post.updated_at || post.created_at,
    author: { '@type': 'Organization', name: post.author || brand },
    publisher: { '@type': 'Organization', name: getSetting('legal_name', '') || brand },
    mainEntityOfPage: url,
  };
  if (post.cover_image) ld.image = post.cover_image.startsWith('/') ? base + post.cover_image : post.cover_image;
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;

  const tags = postTags(post);
  const tagsHtml = tags.length
    ? `<div class="blog-tags-bar">${tags.map((t) => `<a class="blog-tag" href="/blog?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : '';

  // Related: prefer posts sharing a tag, then fill with latest.
  const others = db.prepare('SELECT slug, title, excerpt, cover_image, author, created_at, tags FROM blog_posts WHERE published = 1 AND id != ? ORDER BY id DESC').all(post.id);
  const lower = tags.map((t) => t.toLowerCase());
  let related = others.filter((o) => postTags(o).some((t) => lower.includes(t.toLowerCase())));
  for (const o of others) { if (related.length >= 3) break; if (!related.includes(o)) related.push(o); }
  related = related.slice(0, 3);
  const relatedHtml = related.length
    ? `<section class="blog-related"><h2>Related articles</h2><div class="blog-grid">${related.map((p) => blogCardHtml(p, brand)).join('')}</div></section>` : '';

  res.send(
    pageHead(req, post.title + ' — ' + brand, desc, url, ldTag) +
    siteHeaderHtml() +
    `<main class="container page-body blog-post"><a class="back-link" href="/blog">← All articles</a>
    <h1>${esc(post.title)}</h1>
    <p class="blog-meta">${esc(post.author || brand)} · ${fmtBlogDate(post.created_at)}</p>
    ${post.cover_image ? `<img class="blog-hero-img" src="${esc(post.cover_image)}" alt="${esc(post.title)}">` : ''}
    <div class="page-content blog-content">${post.content || ''}</div>
    ${tagsHtml}
    <div class="blog-cta"><a class="hero-button" href="/#lead-form">Book a free consultation →</a></div>
    ${relatedHtml}
    </main>` +
    pageTail()
  );
});

// ===========================================================================
// PUBLIC API
// ===========================================================================

// Site content for the landing page
app.get('/api/site', (req, res) => {
  const all = getAllSettings();
  const s = {};
  for (const k of Object.keys(all)) if (!PRIVATE_KEYS.has(k)) s[k] = all[k]; // never expose secrets
  // Only products in active categories (a hidden category hides all its products site-wide).
  const models = db
    .prepare(`SELECT m.* FROM macbook_models m
              LEFT JOIN categories c ON c.slug = m.category
              WHERE m.active = 1 AND (c.active = 1 OR c.slug IS NULL)
              ORDER BY m.sort_order ASC, m.id ASC`)
    .all();
  const pages = db
    .prepare('SELECT slug, title FROM content_pages ORDER BY sort_order ASC, title ASC')
    .all();
  const posts = getSetting('blog_enabled', '1') === '1'
    ? db.prepare('SELECT slug, title, excerpt, cover_image, author, created_at FROM blog_posts WHERE published = 1 ORDER BY id DESC LIMIT 3').all()
    : [];
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
      blog_enabled: getSetting('blog_enabled', '1') === '1',
      qc_enabled: getSetting('qc_enabled', '1') === '1',
      qc_video_enabled: getSetting('qc_video_enabled', '1') === '1',
      qc_items: parseJsonSetting('qc_items', []),
      faq_enabled: getSetting('faq_enabled', '1') === '1',
      faq_items: parseJsonSetting('faq_items', []),
      usps_enabled: getSetting('usps_enabled', '1') === '1',
      usps: parseJsonSetting('usps', []),
      trust_points: parseJsonSetting('trust_points', []),
      requirement_options: parseJsonSetting('requirement_options', []),
      budget_options: parseJsonSetting('budget_options', []),
    },
    models,
    categories: db.prepare('SELECT slug, name, singular, url_prefix, tagline, fields, price_note, sort_order, CASE WHEN show_home = 0 THEN 0 ELSE 1 END AS show_home FROM categories WHERE active = 1 ORDER BY sort_order ASC, id ASC').all(),
    pages,
    reviews,
    posts,
  });
});

// security.txt (RFC 9116) — how to report a security issue. Expires auto-renews.
app.get(['/.well-known/security.txt', '/security.txt'], (req, res) => {
  const email = getSetting('customer_care_email', '') || getSetting('footer_email', '') || 'security@mobirapid.com';
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const host = req.headers.host || 'mobirapid.in';
  res.type('text/plain').send(
    `Contact: mailto:${email}\n` +
    `Expires: ${expires}\n` +
    `Preferred-Languages: en\n` +
    `Canonical: https://${host}/.well-known/security.txt\n`
  );
});

// Compare page (server-rendered fallback + interactive picker)
app.get('/compare', (req, res) => {
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const priceNote = getSetting('price_note', '');
  const models = db.prepare('SELECT * FROM macbook_models WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
  const ROWS = [
    ['price', 'Price'], ['cpu', 'Chip / CPU'], ['gpu', 'GPU'], ['memory', 'Memory'],
    ['storage', 'Storage'], ['display', 'Display'], ['condition_grade', 'Condition'], ['warranty', 'Warranty'],
  ];
  // Server-rendered fallback: full spec table for all models (SEO + no-JS)
  const fallbackCols = models.map((m) =>
    `<th scope="col"><a href="/macbook/${esc(m.slug)}">${esc(m.name)}</a></th>`).join('');
  const fallbackRows = ROWS.map(([k, label]) =>
    `<tr><th scope="row">${esc(label)}</th>${models.map((m) => `<td>${esc(m[k] || '—')}</td>`).join('')}</tr>`).join('');
  const fallback = `<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th></th>${fallbackCols}</tr></thead>
    <tbody>${fallbackRows}</tbody></table></div>`;

  const data = models.map((m) => ({
    slug: m.slug, name: m.name, image: m.image || '', price: m.price || '', mrp: m.mrp || '', condition_prices: m.condition_prices || '', best_for: m.best_for || '', badge: m.badge || '',
    cpu: m.cpu || '', gpu: m.gpu || '', memory: m.memory || '', storage: m.storage || '',
    display: m.display || '', condition_grade: m.condition_grade || '', warranty: m.warranty || '',
  }));
  const jsonData = JSON.stringify(data).replace(/</g, '\\u003c');
  const jsonRows = JSON.stringify(ROWS);
  const preIds = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);

  const ld = {
    '@context': 'https://schema.org', '@type': 'ItemList', name: 'Compare refurbished MacBooks',
    itemListElement: models.map((m, i) => ({ '@type': 'ListItem', position: i + 1, url: base + '/macbook/' + esc(m.slug), name: m.name })),
  };
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;

  res.send(
    pageHead(req, 'Compare Refurbished MacBooks — ' + brand,
      'Compare refurbished MacBook models side by side — chip, CPU & GPU cores, memory, storage, display and price. Pick the right Mac for your work.',
      base + '/compare', ldTag) +
    siteHeaderHtml() +
    `<main class="container page-body cmp">
      <a class="back-link" href="/#modelsSection">← All MacBooks</a>
      <h1>Compare refurbished MacBooks</h1>
      <p class="cmp-intro">Select up to four models to compare specs side by side.${priceNote ? ' ' + esc(priceNote) + '.' : ''}</p>
      <div class="cmp-picker" id="cmpPicker">${models.map((m) =>
        `<label class="cmp-chip"><input type="checkbox" value="${esc(m.slug)}"> ${esc(m.name)}</label>`).join('')}</div>
      <div id="cmpApp" hidden></div>
      <noscript>${fallback}</noscript>
      <div id="cmpFallback">${fallback}</div>
    </main>
    <script>
    (function(){
      var DATA = ${jsonData}, ROWS = ${jsonRows}, PRE = ${JSON.stringify(preIds)};
      var picker = document.getElementById('cmpPicker');
      var app = document.getElementById('cmpApp');
      var fallback = document.getElementById('cmpFallback');
      var boxes = Array.prototype.slice.call(picker.querySelectorAll('input'));
      function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
      function selected(){return boxes.filter(function(b){return b.checked;}).map(function(b){return b.value;});}
      function bySlug(s){for(var i=0;i<DATA.length;i++){if(DATA[i].slug===s)return DATA[i];}return null;}
      function build(){
        var sel = selected();
        if(!sel.length){app.innerHTML='<p class="cmp-empty">Pick at least two models above to compare.</p>';return;}
        var models = sel.map(bySlug).filter(Boolean);
        var head='<tr><th></th>'+models.map(function(m){
          return '<th scope="col"><div class="cmp-card">'+
            (m.image?'<img src="'+esc(m.image)+'" alt="'+esc(m.name)+'">':'<div class="cmp-ph"></div>')+
            (m.badge?'<span class="cmp-badge">'+esc(m.badge)+'</span>':'')+
            '<a href="/macbook/'+esc(m.slug)+'">'+esc(m.name)+'</a></div></th>';
        }).join('')+'</tr>';
        var body=ROWS.map(function(r){
          return '<tr><th scope="row">'+esc(r[1])+'</th>'+models.map(function(m){
            return '<td'+(r[0]==='price'?' class="cmp-price"':'')+'>'+esc(m[r[0]]||'—')+'</td>';
          }).join('')+'</tr>';
        }).join('');
        var cta='<tr><th scope="row"></th>'+models.map(function(m){
          return '<td><a class="cmp-book" href="/?model='+encodeURIComponent(m.slug)+'#lead-form">Book Now →</a></td>';
        }).join('')+'</tr>';
        app.innerHTML='<div class="cmp-scroll"><table class="cmp-table cmp-live"><thead>'+head+'</thead><tbody>'+body+cta+'</tbody></table></div>';
      }
      function limit(){
        var sel=selected();
        boxes.forEach(function(b){var over=sel.length>=4&&!b.checked;b.disabled=over;b.parentNode.classList.toggle('disabled',over);});
      }
      function syncUrl(){
        var sel=selected();var u=new URL(location.href);
        if(sel.length)u.searchParams.set('ids',sel.join(','));else u.searchParams.delete('ids');
        history.replaceState(null,'',u);
      }
      boxes.forEach(function(b){b.addEventListener('change',function(){limit();build();syncUrl();});});
      // initial selection: from ?ids or first three
      var init = PRE.filter(function(s){return bySlug(s);});
      if(!init.length) init = DATA.slice(0,3).map(function(m){return m.slug;});
      boxes.forEach(function(b){b.checked = init.indexOf(b.value)>-1;});
      fallback.hidden=true; app.hidden=false; limit(); build();
    })();
    </script>` +
    pageTail()
  );
});

// --- Category helpers ---
function catByPrefix(prefix) { return db.prepare('SELECT * FROM categories WHERE url_prefix = ? AND active = 1').get(prefix); }
function catBySlug(slug) { return db.prepare('SELECT * FROM categories WHERE slug = ? AND active = 1').get(slug); }
function catForProduct(m) { return db.prepare('SELECT * FROM categories WHERE slug = ?').get(m.category) || { slug: m.category, name: 'Products', singular: 'Product', url_prefix: 'macbook', fields: 'macbook' }; }
function productUrl(m, cat) { return '/' + (cat || catForProduct(m)).url_prefix + '/' + m.slug; }
// Flat "Reserve with ₹X" button. Uses a fixed PayU payment link if set, else the dynamic flow.
function reserveButton(slug, cls) {
  if (getSetting('reserve_button_enabled', '1') !== '1') return '';
  const link = getSetting('reserve_payment_link', '').trim();
  const payuOn = getSetting('payu_enabled', '0') === '1';
  if (!link && !payuOn) return '';
  const amt = parseInt(String(getSetting('reserve_flat_amount', '1999')).replace(/[^\d]/g, ''), 10) || 0;
  if (!amt) return '';
  const href = link || ('/reserve?model=' + encodeURIComponent(slug));
  const ext = link ? ' target="_blank" rel="noopener"' : '';
  return `<a class="${cls || 'pdp-reserve'}" href="${esc(href)}"${ext}>Reserve now — ₹${amt.toLocaleString('en-IN')}</a>`;
}

// A product is out of stock when its badge says "Sold out" / "Out of stock".
function isSoldOut(m) { return /sold|out\s*of\s*stock/i.test(m.badge || ''); }
// Bare numbers entered as prices get the ₹ symbol and Indian grouping automatically
// ("14000" -> "₹14,000"). Values that already have ₹ or contain text pass through unchanged.
function normalizePrice(s) {
  const t = String(s || '').trim();
  if (!t || t.includes('₹')) return t;
  const numeric = t.replace(/(?:rs\.?|inr)/i, '').replace(/[,\s]/g, '');
  if (/^\d+(\.\d+)?$/.test(numeric)) return '₹' + Number(numeric).toLocaleString('en-IN');
  return t;
}
// "Best for" use-case tags shown under the price (comma-separated on the model row).
function bestForHtml(m, max) {
  const tags = String(m.best_for || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, max || 6);
  if (!tags.length) return '';
  return `<div class="bestfor"><span class="bestfor-label">Best for:</span>${tags.map((t) => `<span class="bestfor-tag">${esc(t)}</span>`).join('')}</div>`;
}
// Per-condition price variations: JSON [{grade, price, mrp}] on the model row (empty = single price).
function condPrices(m) {
  try { const v = JSON.parse(m.condition_prices || '[]'); return Array.isArray(v) ? v.filter((r) => r && r.grade && r.price) : []; } catch { return []; }
}
const priceNum2 = (s) => parseFloat(String(s || '').replace(/[^\d.]/g, '')) || 0;
// Lowest-priced variant (for "From ₹X" on cards); null when the product has no variations.
function lowestVariant(m) {
  const v = condPrices(m);
  if (!v.length) return null;
  return v.reduce((a, b) => (priceNum2(b.price) < priceNum2(a.price) ? b : a));
}
// Strike-through MRP + auto "% off" tag when the MRP is higher than the selling price.
function discountInfo(m) {
  const num = (s) => parseFloat(String(s || '').replace(/[^\d.]/g, '')) || 0;
  const mrp = num(m.mrp), price = num(m.price);
  if (!mrp || !price || mrp <= price) return null;
  const pct = Math.round(((mrp - price) / mrp) * 100);
  return { mrp: '₹' + Math.round(mrp).toLocaleString('en-IN'), pct };
}
function discountHtml(m) {
  const d = discountInfo(m);
  return d ? ` <span class="mrp-strike">${esc(d.mrp)}</span> <span class="off-tag">${d.pct}% off</span>` : '';
}
// CTA shown on out-of-stock products — takes the visitor to the lead form with the model pre-noted.
function availabilityButton(m, cls) {
  return `<a class="${cls || 'pdp-avail'}" href="/?notify=${encodeURIComponent(m.slug)}#lead-form">Check future availability →</a>`;
}

// Product detail page (server-rendered, Product schema) — category-aware.
// Generic route: /:prefix/:slug where :prefix matches a category url_prefix (else next()).
app.get('/:prefix/:slug', (req, res, next) => {
  const cat = catByPrefix(req.params.prefix);
  if (!cat) return next(); // not a product prefix — let /p/:slug, /blog/:slug, etc. handle it
  const m = db.prepare('SELECT * FROM macbook_models WHERE slug = ? AND category = ? AND active = 1').get(req.params.slug, cat.slug);
  if (!m) return res.status(404).send('Product not found');
  renderProductPage(req, res, m, cat);
});

function renderProductPage(req, res, m, cat) {
  const isPhone = cat.fields === 'phone';
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const priceNote = (cat.price_note || '').trim() || getSetting('price_note', '');
  const bookUrl = `/?model=${encodeURIComponent(m.slug)}#lead-form`;
  const priceNum = String(m.price || '').replace(/[^\d.]/g, '');
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: m.name,
    description: m.description || m.specs || m.name,
    category: isPhone ? 'Refurbished Mobile Phone' : 'Refurbished Laptop',
    itemCondition: 'https://schema.org/RefurbishedCondition',
  };
  if (!isPhone) ld.brand = { '@type': 'Brand', name: 'Apple' };
  if (m.image) ld.image = m.image.startsWith('/') ? base + m.image : m.image;
  const specRows = isPhone
    ? [['Processor', m.cpu], ['Storage', m.storage], ['Battery health', m.battery_health], ['Colour', m.colour], ['Condition', m.condition_grade ? m.condition_grade + ' (refurbished)' : ''], ['Warranty', m.warranty]]
    : [['Chip / CPU', m.cpu], ['GPU', m.gpu], ['Memory (RAM)', m.memory], ['Storage', m.storage], ['Display', m.display], ['Condition', m.condition_grade ? m.condition_grade + ' (refurbished)' : ''], ['Warranty', m.warranty]];
  const rows = specRows.filter((r) => r[1]);
  const props = rows.filter((r) => !/Condition|Warranty/.test(r[0]));
  if (props.length) ld.additionalProperty = props.map((p) => ({ '@type': 'PropertyValue', name: p[0], value: p[1] }));
  const soldOut = isSoldOut(m);
  // Condition-based price variations (if configured) — buyer picks the condition on the page.
  const variants = condPrices(m);
  const defVariant = variants.length ? (variants.find((v) => v.grade === m.condition_grade) || variants[0]) : null;
  const availLd = soldOut ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock';
  if (variants.length) {
    const nums = variants.map((v) => priceNum2(v.price)).filter(Boolean);
    ld.offers = { '@type': 'AggregateOffer', lowPrice: Math.min(...nums), highPrice: Math.max(...nums), priceCurrency: 'INR', offerCount: variants.length, availability: availLd, url: base + productUrl(m, cat) };
  } else if (priceNum) ld.offers = { '@type': 'Offer', price: priceNum, priceCurrency: 'INR', availability: availLd, url: base + productUrl(m, cat) };
  const ldTag = `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
  const desc = (m.description || m.specs || m.name).slice(0, 180);
  const badge = m.badge ? `<span class="pdp-badge ${soldOut ? 'soldout' : /hot/i.test(m.badge) ? 'hot' : 'avail'}">${esc(m.badge)}</span>` : '';
  const metaBits = isPhone
    ? [m.condition_grade ? `<a class="pdp-tag cond-pill ${gradeBadgeClass(m.condition_grade)}" href="/condition" title="What does this grade mean?">${esc(m.condition_grade)} ⓘ</a>` : '', m.battery_health ? `<span class="pdp-tag">Battery ${esc(m.battery_health)}</span>` : '', m.warranty ? `<span class="pdp-tag">${esc(m.warranty)}</span>` : '']
    : [m.condition_grade ? `<a class="pdp-tag cond-pill ${gradeBadgeClass(m.condition_grade)}" href="/condition" title="What does this grade mean?">${esc(m.condition_grade)} ⓘ</a>` : '', m.warranty ? `<span class="pdp-tag">${esc(m.warranty)}</span>` : ''];
  res.send(
    pageHead(req, m.name + ' — ' + brand, desc, base + productUrl(m, cat), ldTag) +
    siteHeaderHtml() +
    `<main class="container page-body pdp">
      <a class="back-link" href="/c/${esc(cat.slug)}">← All ${esc(cat.name)}</a>
      <div class="pdp-grid">
        ${(() => {
          let gallery = [];
          try { gallery = JSON.parse(m.images || '[]'); } catch { gallery = []; }
          if (!gallery.length && m.image) gallery = [m.image];
          gallery = gallery.filter(Boolean);
          if (!gallery.length) return `<div class="pdp-media"><div class="pdp-media-ph"><span></span></div>${badge}</div>`;
          const main = `<div class="pdp-media" id="pdpMain">${badge}<img id="pdpMainImg" src="${esc(gallery[0])}" alt="${esc(m.name)}"></div>`;
          const thumbs = gallery.length > 1
            ? `<div class="pdp-thumbs" id="pdpThumbs">${gallery.map((g, i) => `<button type="button" class="pdp-thumb${i === 0 ? ' on' : ''}" data-img="${esc(g)}"><img src="${esc(g)}" alt="${esc(m.name)} photo ${i + 1}" loading="lazy"></button>`).join('')}</div>`
            : '';
          return `<div class="pdp-gallery">${main}${thumbs}</div>`;
        })()}
        <div class="pdp-info">
          <h1>${esc(m.name)}</h1>
          ${m.specs ? `<p class="pdp-specs">${esc(m.specs)}</p>` : ''}
          ${(() => {
            if (!defVariant) return m.price ? `<div class="pdp-price">${esc(m.price)}${discountHtml(m)} ${priceNote ? `<span class="pdp-gst">${esc(priceNote)}</span>` : ''}</div>` : '<div class="pdp-price-req">Price on request</div>';
            const dm = priceNum2(defVariant.mrp), dp = priceNum2(defVariant.price), hasD = dm > dp;
            return `<div class="pdp-price"><span id="pdpPriceVal">${esc(defVariant.price)}</span> <span class="mrp-strike" id="pdpStrike"${hasD ? '' : ' hidden'}>${hasD ? '₹' + Math.round(dm).toLocaleString('en-IN') : ''}</span> <span class="off-tag" id="pdpOff"${hasD ? '' : ' hidden'}>${hasD ? Math.round(((dm - dp) / dm) * 100) + '% off' : ''}</span> ${priceNote ? `<span class="pdp-gst">${esc(priceNote)}</span>` : ''}</div>
            <div class="pdp-cond-label">Condition <a href="/condition" title="What do these grades mean?">ⓘ</a></div>
            <div class="pdp-cond-opts" id="condOpts">
              ${variants.map((v) => `<button type="button" class="pdp-cond-opt${v === defVariant ? ' on' : ''}" data-grade="${esc(v.grade)}" data-price="${esc(v.price)}" data-mrp="${esc(v.mrp || '')}"><b>${esc(v.grade)}</b><small>${esc(v.price)}</small></button>`).join('')}
            </div>`;
          })()}
          ${bestForHtml(m)}
          <div class="pdp-meta">${metaBits.filter(Boolean).join('')}</div>
          ${m.description ? `<p class="pdp-desc">${esc(m.description)}</p>` : ''}
          ${soldOut ? '<p class="pdp-oos-note">This product is currently <strong>out of stock</strong>. Leave your details and we\'ll tell you when it\'s available again.</p>' : ''}
          <div class="pdp-actions">
            ${soldOut
              ? `${availabilityButton(m, 'pdp-book pdp-avail')}
            ${!isPhone ? `<a class="pdp-compare" href="/compare?ids=${encodeURIComponent(m.slug)}">Compare with other models</a>` : ''}`
              : `<a class="pdp-book" id="pdpBookBtn" data-base="/?model=${encodeURIComponent(m.slug)}" href="${defVariant ? `/?model=${encodeURIComponent(m.slug)}&cond=${encodeURIComponent(defVariant.grade)}#lead-form` : bookUrl}">Book Now →</a>
            <a class="pdp-book pdp-video" href="/track/video-call?model=${encodeURIComponent(m.slug)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg> Schedule video call</a>
            ${reserveButton(m.slug, 'pdp-reserve')}
            ${!isPhone ? `<a class="pdp-compare" href="/compare?ids=${encodeURIComponent(m.slug)}">Compare with other models</a>` : ''}`}
          </div>
          <ul class="pdp-trust">
            <li>✓ 35-point quality check</li>
            <li>✓ GST invoice with serial number</li>
            <li>✓ Free video-call verification before you pay</li>
          </ul>
        </div>
      </div>
      ${(() => {
        const openBox = /new|sealed|open box/i.test(m.condition_grade || '');
        const wMain = openBox ? 'Brand warranty' : '6 months warranty';
        const wSub = openBox ? 'Manufacturer warranty' : 'Mobirapid warranty';
        return `<div class="pdp-trustbar">
          <a class="pdp-tb" href="/p/refund-policy">
            <span class="pdp-tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg></span><span class="pdp-tb-tx"><b>Easy returns</b><small>Read return policy</small></span>
          </a>
          <div class="pdp-tb">
            <span class="pdp-tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg></span><span class="pdp-tb-tx"><b>${wMain}</b><small>${wSub}</small></span>
          </div>
          <div class="pdp-tb">
            <span class="pdp-tb-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18h-5"/><path d="M20 18h2v-7l-3-5h-5v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg></span><span class="pdp-tb-tx"><b>Free shipping</b><small>Across India</small></span>
          </div>
        </div>`;
      })()}
      ${rows.length ? `<section class="pdp-section">
          <h2>Full configuration</h2>
          <table class="pdp-spec-table"><tbody>
            ${rows.map((r) => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('')}
          </tbody></table>
        </section>` : ''}
      ${(!isPhone && m.software) ? `<section class="pdp-section">
        <h2>What can this MacBook run?</h2>
        <p class="pdp-software">${esc(m.software)}</p>
      </section>` : ''}
    </main>
    <script>(function(){var t=document.getElementById('pdpThumbs');if(!t)return;var main=document.getElementById('pdpMainImg');t.addEventListener('click',function(e){var b=e.target.closest('.pdp-thumb');if(!b)return;main.src=b.getAttribute('data-img');t.querySelectorAll('.pdp-thumb').forEach(function(x){x.classList.toggle('on',x===b);});});})();</script>
    <script>(function(){var w=document.getElementById('condOpts');if(!w)return;
      var pv=document.getElementById('pdpPriceVal'),st=document.getElementById('pdpStrike'),off=document.getElementById('pdpOff'),book=document.getElementById('pdpBookBtn');
      var num=function(s){return parseFloat(String(s||'').replace(/[^\\d.]/g,''))||0;};
      w.addEventListener('click',function(e){var b=e.target.closest('.pdp-cond-opt');if(!b)return;
        w.querySelectorAll('.pdp-cond-opt').forEach(function(x){x.classList.toggle('on',x===b);});
        if(pv)pv.textContent=b.dataset.price;
        var mv=num(b.dataset.mrp),p=num(b.dataset.price),has=mv>p;
        if(st){st.hidden=!has;if(has)st.textContent='₹'+Math.round(mv).toLocaleString('en-IN');}
        if(off){off.hidden=!has;if(has)off.textContent=Math.round(((mv-p)/mv)*100)+'% off';}
        if(book&&book.dataset.base)book.href=book.dataset.base+'&cond='+encodeURIComponent(b.dataset.grade)+'#lead-form';
      });})();</script>` +
    pageTail()
  );
}

// Category landing page (server-rendered) — lists all products in a category.
app.get('/c/:slug', (req, res) => {
  const cat = catBySlug(req.params.slug);
  if (!cat) return res.status(404).send('Category not found');
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const priceNote = (cat.price_note || '').trim() || getSetting('price_note', '');
  const items = db.prepare('SELECT * FROM macbook_models WHERE category = ? AND active = 1 ORDER BY sort_order ASC, id ASC').all(cat.slug);
  const ld = { '@context': 'https://schema.org', '@type': 'ItemList', name: cat.name,
    itemListElement: items.map((m, i) => ({ '@type': 'ListItem', position: i + 1, url: base + productUrl(m, cat), name: m.name })) };
  const card = (m) => {
    const sub = cat.fields === 'phone'
      ? [m.cpu, m.storage, m.battery_health ? 'Battery ' + m.battery_health : '', m.condition_grade].filter(Boolean).join(' · ')
      : [m.specs || [m.cpu, m.memory, m.storage].filter(Boolean).join(' · '), m.condition_grade].filter(Boolean).join(' · ');
    const so = isSoldOut(m);
    const bd = m.badge ? `<span class="model-badge ${so ? 'soldout' : /hot/i.test(m.badge) ? 'hot' : 'avail'}">${esc(m.badge)}</span>` : '';
    return `<article class="model-card${so ? ' oos' : ''}">
      <div class="model-media">${m.image ? `<img src="${esc(m.image)}" alt="${esc(m.name)}">` : '<div class="model-ph"></div>'}${bd}</div>
      <div class="model-body">
        <h3>${esc(m.name)}</h3>
        ${sub ? `<p class="model-specs">${esc(sub)}</p>` : ''}
        ${(() => {
          const lv = lowestVariant(m);
          if (lv) return `<div class="model-price"><span class="from-tag">From</span> ${esc(lv.price)}${priceNote ? ` <span class="model-gst">${esc(priceNote)}</span>` : ''}</div>`;
          return m.price ? `<div class="model-price">${esc(m.price)}${discountHtml(m)}${priceNote ? ` <span class="model-gst">${esc(priceNote)}</span>` : ''}</div>` : '';
        })()}
        ${bestForHtml(m, 3)}
        <div class="model-foot">
          ${so ? availabilityButton(m, 'model-reserve model-avail') : reserveButton(m.slug, 'model-reserve')}
          <a class="model-cta" href="${productUrl(m, cat)}">View details →</a>
        </div>
      </div>
    </article>`;
  };
  res.send(
    pageHead(req, cat.name + ' — ' + brand, cat.tagline || cat.name, base + '/c/' + esc(cat.slug), `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`) +
    siteHeaderHtml() +
    `<main class="container page-body">
      <a class="back-link" href="/">← Home</a>
      <h1>${esc(cat.name)}</h1>
      ${cat.tagline ? `<p class="cat-tagline">${esc(cat.tagline)}</p>` : ''}
      ${items.length ? `<div class="models-grid cat-grid-page">${items.map(card).join('')}</div>` : '<p class="muted">New stock coming soon. Please check back or book a consultation.</p>'}
      <p style="margin-top:26px;"><a class="pdp-book" href="/#lead-form">Book a free consultation →</a></p>
    </main>` +
    pageTail()
  );
});

// Condition-grade badge colour (best → most worn)
function gradeBadgeClass(grade) {
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
// Condition grades page (server-rendered) — definitions with coloured badges.
app.get('/condition', (req, res) => {
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  let grades = [];
  try { grades = JSON.parse(getSetting('condition_grades', '[]')) || []; } catch { grades = []; }
  const title = getSetting('condition_title', 'Condition grades explained');
  const intro = getSetting('condition_intro', '');
  const cards = grades.map((g) => `
    <div class="cond-card">
      <span class="cond-badge ${gradeBadgeClass(g.grade)}">${esc(g.grade)}</span>
      ${g.summary ? `<p class="cond-summary">${esc(g.summary)}</p>` : ''}
      ${g.detail ? `<p class="cond-detail">${esc(g.detail)}</p>` : ''}
    </div>`).join('');
  res.send(
    pageHead(req, title + ' — ' + brand, intro.slice(0, 180) || title, base + '/condition', '') +
    siteHeaderHtml() +
    `<main class="container page-body cond-page">
      <a class="back-link" href="/">← Home</a>
      <h1>${esc(title)}</h1>
      ${intro ? `<p class="cond-intro">${esc(intro)}</p>` : ''}
      <div class="cond-grid">${cards}</div>
      <p style="margin-top:26px;color:var(--muted);font-size:.9rem;">Every device — regardless of grade — passes our 35-point quality check and comes with a GST invoice and warranty. You can verify your exact unit on a free video call before you pay.</p>
    </main>` +
    pageTail()
  );
});

// ---------------------------------------------------------------------------
// Reserve / booking payment via PayU (hosted checkout)
// ---------------------------------------------------------------------------
function digits(v) { return parseInt(String(v || '').replace(/[^\d]/g, ''), 10) || 0; }
function reserveContext(slug) {
  const model = db.prepare('SELECT * FROM macbook_models WHERE slug = ? AND active = 1').get(slug);
  if (!model) return null;
  const isDeal = getSetting('offer_model_slug', '') === slug;
  const price = digits((isDeal && getSetting('offer_price', '')) || model.price);
  let amount = digits(isDeal ? getSetting('offer_reserve_amount', '') : '');
  if (!amount && price) amount = Math.round(price * 0.1);
  return { model, amount };
}
function payuUrl() { return getSetting('payu_mode', 'test') === 'live' ? 'https://secure.payu.in/_payment' : 'https://test.payu.in/_payment'; }

app.get('/reserve', (req, res) => {
  const base = baseUrl(req);
  const brand = getSetting('brand_name', 'Mobirapid');
  const ctx = reserveContext(String(req.query.model || ''));
  if (getSetting('payu_enabled', '0') !== '1' || !ctx || !ctx.amount) return res.redirect('/');
  const m = ctx.model;
  const amtStr = '₹' + ctx.amount.toLocaleString('en-IN');
  res.send(
    pageHead(req, 'Reserve ' + m.name + ' — ' + brand, 'Reserve your MacBook with a small booking amount.', base + '/reserve', '<meta name="robots" content="noindex">') +
    siteHeaderHtml() +
    `<main class="container page-body reserve-page">
      <a class="back-link" href="/">← Back</a>
      <h1>Reserve your MacBook</h1>
      <div class="reserve-card">
        <div class="reserve-item">
          ${m.image ? `<img src="${esc(m.image)}" alt="${esc(m.name)}">` : ''}
          <div><strong>${esc(m.name)}</strong>${m.specs ? `<br><small>${esc(m.specs)}</small>` : ''}</div>
        </div>
        <p class="reserve-amt">Booking amount: <strong>${esc(amtStr)}</strong> <span>(adjusted in your final invoice)</span></p>
        <form method="POST" action="/api/reserve/initiate" class="reserve-form">
          <input type="hidden" name="model" value="${esc(m.slug)}">
          <label>Full name <span>*</span><input type="text" name="firstname" required></label>
          <label>Email <span>*</span><input type="email" name="email" required></label>
          <label>Phone <span>*</span><input type="tel" name="phone" required pattern="[0-9+ ]{8,15}"></label>
          <button type="submit" class="reserve-pay">Pay ${esc(amtStr)} securely →</button>
          <p class="reserve-secure">🔒 Payment processed securely by PayU. ${getSetting('payu_mode','test') === 'test' ? '(Test mode)' : ''}</p>
        </form>
      </div>
    </main>` +
    pageTail()
  );
});

app.post('/api/reserve/initiate', (req, res) => {
  if (getSetting('payu_enabled', '0') !== '1') return res.redirect('/');
  const ctx = reserveContext(String(req.body.model || ''));
  const key = getSetting('payu_merchant_key', '');
  const salt = getSetting('payu_salt', '');
  if (!ctx || !ctx.amount || !key || !salt) return res.status(400).send('Reservation is not available right now.');
  const firstname = String(req.body.firstname || '').trim().slice(0, 60);
  const email = String(req.body.email || '').trim().slice(0, 120);
  const phone = String(req.body.phone || '').replace(/[^\d+]/g, '').slice(0, 15);
  if (!firstname || !email || !phone) return res.status(400).send('Name, email and phone are required.');
  const amount = ctx.amount.toFixed(2);
  const txnid = 'MOBI' + Date.now() + Math.random().toString(36).slice(2, 7);
  const productinfo = ('Reserve ' + ctx.model.name).slice(0, 100);
  const base = baseUrl(req);
  const surl = base + '/reserve/success';
  const furl = base + '/reserve/failure';
  // PayU request hash: key|txnid|amount|productinfo|firstname|email|udf1..udf10(empty)|salt
  const udf = ['', '', '', '', '', '', '', '', '', ''];
  const hashStr = [key, txnid, amount, productinfo, firstname, email, ...udf, salt].join('|');
  const hash = crypto.createHash('sha512').update(hashStr).digest('hex');
  const f = (n, v) => `<input type="hidden" name="${n}" value="${String(v).replace(/"/g, '&quot;')}">`;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Redirecting to secure payment…</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;">
    <p>Redirecting you to PayU secure checkout…</p>
    <form id="payu" method="POST" action="${payuUrl()}">
      ${f('key', key)}${f('txnid', txnid)}${f('amount', amount)}${f('productinfo', productinfo)}
      ${f('firstname', firstname)}${f('email', email)}${f('phone', phone)}
      ${f('surl', surl)}${f('furl', furl)}${f('hash', hash)}
    </form>
    <script>document.getElementById('payu').submit();</script></body></html>`);
});

function verifyPayu(body) {
  const salt = getSetting('payu_salt', '');
  const key = getSetting('payu_merchant_key', '');
  const { status, txnid, amount, productinfo, firstname, email } = body;
  // PayU reverse hash: salt|status|udf10..udf1(empty)|email|firstname|productinfo|amount|txnid|key
  const udf = ['', '', '', '', '', '', '', '', '', ''];
  const str = [salt, status, ...udf, email, firstname, productinfo, amount, txnid, key].join('|');
  const calc = crypto.createHash('sha512').update(str).digest('hex');
  return calc === String(body.hash || '');
}
function reservePage(req, title, body) {
  return pageHead(req, title + ' — ' + getSetting('brand_name', 'Mobirapid'), title, baseUrl(req) + '/reserve', '<meta name="robots" content="noindex">') +
    siteHeaderHtml() + `<main class="container page-body reserve-page">${body}</main>` + pageTail();
}
app.post('/reserve/success', (req, res) => {
  const ok = verifyPayu(req.body);
  if (!ok) return res.send(reservePage(req, 'Payment received', `<div class="reserve-result"><h1>Payment received</h1><p>We could not automatically verify the payment signature. If money was deducted, please contact us with your transaction ID <strong>${esc(String(req.body.txnid || ''))}</strong> and we'll confirm your reservation.</p><a class="pdp-book" href="/">Back to home</a></div>`));
  const msg = esc(getSetting('reserve_thankyou_text', 'Thank you! Your reservation payment was received.'));
  res.send(reservePage(req, 'Reservation confirmed', `<div class="reserve-result ok">
    <div class="reserve-check">✓</div>
    <h1>Reservation confirmed</h1>
    <p>${msg}</p>
    <p class="reserve-ref">Amount: <strong>₹${esc(String(digits(req.body.amount).toLocaleString('en-IN')))}</strong> · Txn ID: <strong>${esc(String(req.body.txnid || ''))}</strong></p>
    <a class="pdp-book" href="/">Back to home</a>
  </div>`));
});
app.post('/reserve/failure', (req, res) => {
  res.send(reservePage(req, 'Payment not completed', `<div class="reserve-result fail">
    <h1>Payment not completed</h1>
    <p>Your payment was not completed${req.body.txnid ? ` (Txn ID: <strong>${esc(String(req.body.txnid))}</strong>)` : ''}. No amount has been reserved. You can try again or book a free video call instead.</p>
    <a class="pdp-book" href="/#lead-form">Book a video call</a>
  </div>`));
});

// Business & contact details block (from admin settings) appended to every policy page —
// required by payment aggregators (legal name, registered address, GSTIN, contact).
function businessDetailsHtml() {
  const legal = getSetting('legal_name', '') || getSetting('brand_name', 'Mobirapid');
  const addr = getSetting('registered_address', '');
  const gstin = getSetting('gstin', '');
  const email = getSetting('customer_care_email', '') || getSetting('social_email', '');
  const phone = getSetting('customer_care_phone', '') || getSetting('social_phone', '');
  const goName = getSetting('grievance_officer_name', '');
  const goEmail = getSetting('grievance_officer_email', '');
  const goPhone = getSetting('grievance_officer_phone', '');
  const rows = [];
  if (legal) rows.push(['Legal entity', esc(legal)]);
  if (addr) rows.push(['Registered address', esc(addr).replace(/\n/g, '<br>')]);
  if (gstin) rows.push(['GSTIN', esc(gstin)]);
  if (email) rows.push(['Customer care email', `<a href="mailto:${esc(email)}">${esc(email)}</a>`]);
  if (phone) rows.push(['Customer care phone', `<a href="tel:${esc(phone.replace(/\s/g, ''))}">${esc(phone)}</a>`]);
  if (goName || goEmail || goPhone) {
    rows.push(['Grievance Officer', [esc(goName), goEmail ? `<a href="mailto:${esc(goEmail)}">${esc(goEmail)}</a>` : '', esc(goPhone)].filter(Boolean).join(' · ')]);
  }
  if (!rows.length) return '';
  return `<section class="biz-details">
    <h2>Business &amp; contact details</h2>
    <table class="biz-table"><tbody>${rows.map((r) => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('')}</tbody></table>
    <p class="biz-note">Online payments are processed securely by PayU (PCI-DSS compliant). All prices are in Indian Rupees (₹) and include applicable taxes as shown at checkout.</p>
  </section>`;
}

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
<link rel="stylesheet" href="${ver('/styles.css')}">
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
  ${businessDetailsHtml()}
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
  const callType = String(b.call_type || '').trim();
  const interestedModel = String(b.interested_model || '').trim().slice(0, 200);
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
    `INSERT INTO leads (name, phone, phone_verified, client_type, company_name, company_email, requirement, budget, best_time, call_type, interested_model, message)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, phone, clientType, companyName, companyEmail, requirement, budget, bestTime, callType, interestedModel, message);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(info.lastInsertRowid));
  db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  try { await sendLeadEmail(lead); } catch (e) { console.error('Lead email failed (lead still saved):', e.message); }
  // Meta Conversions API (server-side Lead event, deduped with the browser Pixel via event_id)
  sendMetaCapiLead(lead, req, {
    eventId: String(b.event_id || ''), fbp: String(b.fbp || ''), fbc: String(b.fbc || ''),
    sourceUrl: req.headers.referer || '',
  });
  res.json({ ok: true, message: 'Thanks! Your consultation request has been received. Our team will reach out shortly.' });
});

// ===========================================================================
// ADMIN AUTH  (roles: "admin" = full access, "leads" = leads only)
// ===========================================================================
function signToken(user, role, scope) {
  const payload = Buffer.from(JSON.stringify({ user, role, scope: scope || null, t: Date.now() })).toString('base64url');
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
// Lead-only staff can view leads but not modify/delete them.
function requireFullRole(req, res, next) {
  const role = (req.authUser && req.authUser.role) || 'admin';
  if (role !== 'admin') return res.status(403).json({ ok: false, error: 'You can view leads but not modify them.' });
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
  if (role === 'admin') return next();
  // Staff users can hold multiple roles (stored as a comma-separated list, e.g. "leads,catalog").
  const roles = String(role).split(',').map((s) => s.trim()).filter(Boolean);
  const leadsOk = req.path === '/me' || req.path.startsWith('/leads');
  // Category uploader ('catalog') may manage products + upload images + read categories.
  const catalogOk = req.path === '/me' || req.path.startsWith('/models') || req.path === '/upload' || req.path === '/categories';
  if (roles.includes('leads') && leadsOk) return next();
  if (roles.includes('catalog') && catalogOk) return next();
  return res.status(403).json({ ok: false, error: 'You do not have access to this section.' });
});

// Admin UI lives at /manage (not /admin) to avoid clashing with a /admin path
// that some hosts/other apps occupy. The /api/admin/* API paths are unaffected.
app.get(['/manage/login', '/admin/login'], (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post(['/manage/login', '/admin/login'], (req, res) => {
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
app.post(['/manage/logout', '/admin/logout'], (req, res) => { res.clearCookie('admin_session'); res.redirect('/manage/login'); });
// Serve the admin with cache-busted asset URLs so admins always get the latest admin.js/styles after a deploy.
app.get(['/manage', '/admin'], requireAdmin, (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'views', 'admin.html'), 'utf8')
    .replace('href="/styles.css"', `href="${ver('/styles.css')}"`)
    .replace('src="/admin.js"', `src="${ver('/admin.js')}"`);
  res.type('html').send(html);
});

// ===========================================================================
// ADMIN API
// ===========================================================================

// Who am I (used by the admin UI to show/hide tabs by role)
app.get('/api/admin/me', (req, res) => res.json({ ok: true, user: req.authUser.user, role: req.authUser.role || 'admin', scope: req.authUser.scope || null }));

// User management (full admin only — enforced by the gate above)
app.get('/api/admin/users', (req, res) => {
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
app.post('/api/admin/users', (req, res) => {
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
app.put('/api/admin/users/:id', (req, res) => {
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
app.delete('/api/admin/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Trackable CTA: records the click server-side, then lands on the lead form with
// the model + video call preselected. UTM params make it visible in Google Analytics too.
app.get('/track/video-call', (req, res) => {
  const model = String(req.query.model || '').slice(0, 120);
  try { db.prepare('INSERT INTO click_events (kind, model) VALUES (?, ?)').run('video-call', model); } catch (e) { console.error('click_events insert failed:', e.message); }
  const q = new URLSearchParams({ ...(model ? { model } : {}), call: 'video', utm_source: 'site', utm_medium: 'pdp', utm_campaign: 'schedule_video_call' });
  res.redirect('/?' + q.toString() + '#lead-form');
});

// Leads
// Status options are configurable in the admin (Leads tab). Comma-separated setting; falls back to the defaults.
function leadStatuses() {
  const list = String(getSetting('lead_statuses', '')).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list.slice(0, 20) : ['New', 'Contacted', 'Converted', 'Lost'];
}
app.get('/api/admin/leads', requireAdmin, (req, res) => {
  const videoClicks = db.prepare("SELECT COUNT(*) AS n FROM click_events WHERE kind = 'video-call'").get().n;
  res.json({ ok: true, leads: db.prepare('SELECT * FROM leads ORDER BY id DESC').all(), statuses: leadStatuses(), video_clicks: videoClicks });
});
app.put('/api/admin/leads/:id', requireAdmin, requireFullRole, (req, res) => {
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
    remark: String(b.remark || '').trim().slice(0, 1000),
    status: leadStatuses().includes(b.status) ? b.status : 'New',
  };
  if (!lead.name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  db.prepare(
    `UPDATE leads SET name=@name, phone=@phone, client_type=@client_type, company_name=@company_name,
     company_email=@company_email, requirement=@requirement, budget=@budget, best_time=@best_time,
     call_type=@call_type, interested_model=@interested_model, message=@message, remark=@remark, status=@status WHERE id=@id`
  ).run(lead);
  res.json({ ok: true });
});
// Quick status change (inline dropdown)
// Both admin and lead-only staff may change a lead's status (but not edit/delete the lead).
app.post('/api/admin/leads/:id/status', requireAdmin, (req, res) => {
  const status = req.body.status;
  if (!leadStatuses().includes(status)) return res.status(400).json({ ok: false, error: 'Invalid status.' });
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, parseInt(req.params.id, 10));
  res.json({ ok: true });
});
// Quick remark edit (inline) — any staff with lead access may add/update a remark.
app.post('/api/admin/leads/:id/remark', requireAdmin, (req, res) => {
  const remark = String(req.body.remark || '').trim().slice(0, 1000);
  db.prepare('UPDATE leads SET remark = ? WHERE id = ?').run(remark, parseInt(req.params.id, 10));
  res.json({ ok: true });
});
app.delete('/api/admin/leads/:id', requireAdmin, requireFullRole, (req, res) => {
  db.prepare('DELETE FROM leads WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});
// Bulk delete
app.post('/api/admin/leads/bulk-delete', requireAdmin, requireFullRole, (req, res) => {
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
  const cols = ['id', 'name', 'phone', 'phone_verified', 'client_type', 'company_name', 'company_email', 'requirement', 'interested_model', 'budget', 'call_type', 'best_time', 'status', 'remark', 'message', 'created_at'];
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

// Products (MacBooks + phones + any category) CRUD
function userScope(req) {
  const role = String((req.authUser && req.authUser.role) || '');
  if (!role || role === 'admin') return null;
  // A blank scope on a catalog user means "all categories" (unrestricted).
  return role.split(',').includes('catalog') ? (req.authUser.scope || null) : null;
}
app.get('/api/admin/models', requireAdmin, (req, res) => {
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
    price: normalizePrice(String(b.price || '').trim()),
    mrp: normalizePrice(String(b.mrp || '').trim()),
    best_for: String(b.best_for || '').trim().slice(0, 300),
    condition_prices: JSON.stringify(
      (Array.isArray(b.condition_prices) ? b.condition_prices : [])
        .map((r) => ({ grade: String((r && r.grade) || '').trim().slice(0, 60), price: normalizePrice(String((r && r.price) || '').trim().slice(0, 30)), mrp: normalizePrice(String((r && r.mrp) || '').trim().slice(0, 30)) }))
        .filter((r) => r.grade && r.price)
        .slice(0, 8)
    ),
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
app.post('/api/admin/models', requireAdmin, (req, res) => {
  const m = modelFromBody(req.body);
  if (!m.name) return res.status(400).json({ ok: false, error: 'Model name is required.' });
  const scope = userScope(req);
  if (scope) m.category = scope; // uploaders can only create in their own category
  let slug = m.slug, n = 2;
  while (db.prepare('SELECT id FROM macbook_models WHERE slug = ?').get(slug)) slug = m.slug + '-' + n++;
  const info = db.prepare(
    `INSERT INTO macbook_models (name, category, slug, price, mrp, best_for, condition_prices, image, images, specs, description, badge, condition_grade, warranty, cpu, gpu, memory, storage, display, software, battery_health, colour, sort_order, active)
     VALUES (@name, @category, @slug, @price, @mrp, @best_for, @condition_prices, @image, @images, @specs, @description, @badge, @condition_grade, @warranty, @cpu, @gpu, @memory, @storage, @display, @software, @battery_health, @colour, @sort_order, @active)`
  ).run({ ...m, slug });
  res.json({ ok: true, id: Number(info.lastInsertRowid), slug });
});
app.put('/api/admin/models/:id', requireAdmin, (req, res) => {
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
    `UPDATE macbook_models SET name=@name, category=@category, slug=@slug, price=@price, mrp=@mrp, best_for=@best_for, condition_prices=@condition_prices, image=@image, images=@images, specs=@specs, description=@description, badge=@badge,
     condition_grade=@condition_grade, warranty=@warranty, cpu=@cpu, gpu=@gpu, memory=@memory, storage=@storage, display=@display, software=@software,
     battery_health=@battery_health, colour=@colour, sort_order=@sort_order, active=@active WHERE id=@id`
  ).run({ ...m, slug, id });
  res.json({ ok: true, slug });
});
app.delete('/api/admin/models/:id', requireAdmin, (req, res) => {
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
app.get('/api/admin/categories', requireAdmin, (req, res) => {
  res.json({ ok: true, categories: db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC').all() });
});
app.post('/api/admin/categories', requireAdmin, requireFullRole, (req, res) => {
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
app.put('/api/admin/categories/:id', requireAdmin, requireFullRole, (req, res) => {
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
app.delete('/api/admin/categories/:id', requireAdmin, requireFullRole, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cat = db.prepare('SELECT slug FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ ok: false, error: 'Not found.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM macbook_models WHERE category = ?').get(cat.slug).n;
  if (count > 0) return res.status(400).json({ ok: false, error: `Move or delete the ${count} product(s) in this category first.` });
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
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

// Blog posts CRUD
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'post';
}
app.get('/api/admin/blog', requireAdmin, (req, res) => {
  res.json({ ok: true, posts: db.prepare('SELECT id, slug, title, excerpt, cover_image, author, published, created_at FROM blog_posts ORDER BY id DESC').all() });
});
app.get('/api/admin/blog/:id', requireAdmin, (req, res) => {
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
app.post('/api/admin/blog', requireAdmin, (req, res) => {
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
app.put('/api/admin/blog/:id', requireAdmin, (req, res) => {
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
app.delete('/api/admin/blog/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(parseInt(req.params.id, 10));
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

// Branded 404 (noindex) — catch-all for anything not matched above.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found.' });
  const brand = getSetting('brand_name', 'Mobirapid');
  res.status(404).send(
    pageHead(req, 'Page not found — ' + brand, 'The page you are looking for could not be found.', baseUrl(req) + req.originalUrl, '<meta name="robots" content="noindex">') +
    siteHeaderHtml() +
    `<main class="container page-body" style="text-align:center;padding:80px 20px;">
      <h1 style="font-size:3rem;">404</h1>
      <p style="color:var(--muted);font-size:1.1rem;">Sorry, that page could not be found.</p>
      <p style="margin-top:24px;"><a class="hero-button" href="/" style="background:var(--brand);color:#fff;">← Back to home</a> &nbsp; <a class="hero-button" href="/blog" style="background:#fff;border:1px solid var(--line);">Read the blog</a></p>
    </main>` +
    pageTail()
  );
});

app.listen(PORT, () => {
  console.log(`\nMobirapid lead-gen running:  http://localhost:${PORT}`);
  console.log(`Admin panel:                 http://localhost:${PORT}/manage`);
  const prov = otpProvider();
  console.log(`OTP provider: ${prov}${prov === 'mock' ? '  (codes printed to this console)' : ''}`);
  console.log(`Lead emails -> ${leadNotifyTo()}${buildTransporter() ? '' : '  (SMTP not set: emails printed to console)'}`);
  console.log(`Configure SMS/email from the admin → "SMS & Email" tab.\n`);
});
