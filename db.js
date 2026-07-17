// Database layer with automatic driver selection for maximum host compatibility:
//   1. Node's built-in SQLite (node:sqlite) — Node 22.5+/24+, no install needed.
//   2. Fallback to better-sqlite3 — for older Node versions (e.g. cPanel hosts on
//      Node 18/20). Install it there with: npm install better-sqlite3
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'leads.db');

let db;
try {
  // --- Preferred: built-in node:sqlite ---
  const { DatabaseSync } = require('node:sqlite');
  const rawDb = new DatabaseSync(dbPath);
  db = {
    exec: (sql) => rawDb.exec(sql),
    prepare: (sql) => rawDb.prepare(sql),
    pragma: (str) => rawDb.exec('PRAGMA ' + str),
  };
  console.log('DB: using built-in node:sqlite');
} catch (e) {
  // --- Fallback: better-sqlite3 (native module) ---
  const Database = require('better-sqlite3');
  const rawDb = new Database(dbPath);
  db = {
    exec: (sql) => rawDb.exec(sql),
    prepare: (sql) => rawDb.prepare(sql),
    pragma: (str) => rawDb.pragma(str),
  };
  console.log('DB: using better-sqlite3 fallback');
}

// WAL gives better concurrency on normal disks, but fails on some network/FUSE
// mounts — fall back to the default journal mode if it isn't supported.
try {
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.warn('WAL mode unavailable, using default journal:', e.message);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL,
    phone_verified INTEGER NOT NULL DEFAULT 0,
    client_type   TEXT,
    company_name  TEXT,
    company_email TEXT,
    requirement   TEXT,
    budget        TEXT,
    best_time     TEXT,
    message       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS otps (
    phone       TEXT PRIMARY KEY,
    code        TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    verified    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS macbook_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    price       TEXT,
    image       TEXT,
    specs       TEXT,
    badge       TEXT,
    condition_grade TEXT,
    warranty    TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS content_pages (
    slug       TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    content    TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author     TEXT NOT NULL,
    rating     INTEGER NOT NULL DEFAULT 5,
    text       TEXT,
    date_label TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS blog_posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    slug             TEXT UNIQUE NOT NULL,
    title            TEXT NOT NULL,
    excerpt          TEXT,
    content          TEXT,
    cover_image      TEXT,
    author           TEXT,
    meta_description TEXT,
    published        INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Lightweight migration: add columns if upgrading an older DB ---
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn('leads', 'company_name', 'TEXT');
ensureColumn('leads', 'company_email', 'TEXT');
ensureColumn('macbook_models', 'description', 'TEXT');
ensureColumn('leads', 'status', "TEXT DEFAULT 'New'");
ensureColumn('blog_posts', 'tags', 'TEXT');
ensureColumn('leads', 'call_type', 'TEXT');
ensureColumn('leads', 'interested_model', 'TEXT');
ensureColumn('leads', 'remark', 'TEXT'); // Internal staff note per lead (shown only in the admin).
ensureColumn('leads', 'consent', 'TEXT'); // DPDP consent record: consent-text version + ISO timestamp.
ensureColumn('macbook_models', 'slug', 'TEXT');
ensureColumn('macbook_models', 'cpu', 'TEXT');
ensureColumn('macbook_models', 'gpu', 'TEXT');
ensureColumn('macbook_models', 'memory', 'TEXT');
ensureColumn('macbook_models', 'storage', 'TEXT');
ensureColumn('macbook_models', 'display', 'TEXT');
ensureColumn('macbook_models', 'software', 'TEXT');
// Multi-category catalog: products belong to a category (macbook, phone, …) and phones
// use their own spec fields (chip = cpu, storage reused, plus battery health + colour).
ensureColumn('macbook_models', 'category', "TEXT NOT NULL DEFAULT 'macbooks'");
ensureColumn('macbook_models', 'battery_health', 'TEXT');
ensureColumn('macbook_models', 'colour', 'TEXT');
ensureColumn('macbook_models', 'images', 'TEXT'); // JSON array of image paths (gallery). image = primary/first.
ensureColumn('macbook_models', 'mrp', 'TEXT'); // Actual MRP — shown struck-through with an auto "% off" tag when higher than the selling price.
ensureColumn('macbook_models', 'condition_prices', 'TEXT'); // JSON [{grade, price, mrp}] — per-condition price variations pickable on the product page.
ensureColumn('macbook_models', 'best_for', 'TEXT'); // Comma-separated use-cases shown as "Best for" tags under the price.
// Normalise any legacy/blank category values onto the 'macbooks' category slug.
db.exec("UPDATE macbook_models SET category = 'macbooks' WHERE category IS NULL OR category = '' OR category = 'macbook'");

// Categories (flexible — admin can add/rename/remove). url_prefix drives the pretty URLs
// (/macbook/:slug, /phone/:slug) and the category landing page (/c/:slug).
db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    singular    TEXT NOT NULL,
    url_prefix  TEXT UNIQUE NOT NULL,
    tagline     TEXT,
    fields      TEXT NOT NULL DEFAULT 'macbook',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
  );
`);
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
  const insCat = db.prepare('INSERT INTO categories (slug, name, singular, url_prefix, tagline, fields, sort_order, active) VALUES (@slug,@name,@singular,@url_prefix,@tagline,@fields,@sort_order,@active)');
  insCat.run({ slug: 'macbooks', name: 'Refurbished MacBooks', singular: 'MacBook', url_prefix: 'macbook', tagline: 'M1–M4 · quality-checked · GST invoice & warranty', fields: 'macbook', sort_order: 1, active: 1 });
  insCat.run({ slug: 'phones', name: 'Refurbished Phones', singular: 'Phone', url_prefix: 'phone', tagline: 'iPhone & Android · tested · battery-checked · warranty', fields: 'phone', sort_order: 2, active: 1 });
}

// Users table for additional logins (e.g. lead-only staff accounts).
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    pass_hash  TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'leads',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// scope = category slug a "catalog" uploader is limited to (e.g. 'phones'); NULL for others.
ensureColumn('users', 'scope', 'TEXT');

// Click tracking for site CTAs (e.g. the product page "Schedule video call" button).
db.exec(`
  CREATE TABLE IF NOT EXISTS click_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    model      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Seed default settings (only inserts missing keys) ---
const DEFAULT_SETTINGS = {
  brand_name: 'Mobirapid',
  logo_path: '',
  header_cta_text: 'Book Consultation',
  cta_text: 'Schedule call now',
  announce_enabled: '1',
  announce_text: 'We are an official Apple DPP Partner · New & Refurbished MacBooks · We also buy your old Mac',
  banner_image: '/uploads/banner-hero.jpg',
  banner_eyebrow: 'Refurbished MacBooks · Expert-matched',
  banner_heading: 'Find the right MacBook for the work you actually do.',
  banner_subtext:
    "Tell us what you need it for — AI, Machine Learning, Data Science or everyday tasks — and your budget. We'll match you with a quality-checked refurbished MacBook and walk you through it on a free consultation call.",
  trust_points: JSON.stringify([
    'Verified, quality-checked devices',
    'Matched to your workload & budget',
    'Free, no-obligation consultation',
  ]),
  requirement_options: JSON.stringify(['AI', 'Machine Learning', 'Data Science', 'Daily Tasks']),
  budget_options: JSON.stringify([
    'Under ₹40,000',
    '₹40,000 – ₹70,000',
    '₹70,000 – ₹1,00,000',
    '₹1,00,000 – ₹1,50,000',
    'Above ₹1,50,000',
  ]),
  models_title: 'Hot & Available MacBooks',
  models_subtitle: 'Hand-picked, quality-checked devices ready to ship.',
  price_note: '+ 18% GST',
  // Deal / Offer of the Day (highlighted homepage section)
  offer_enabled: '0',
  offer_label: 'Deal of the Day',
  offer_model_slug: '',
  offer_subtitle: '',
  offer_price: '',
  offer_mrp: '',
  offer_badge: '',
  offer_gst_note: 'Inclusive of GST · Invoice with serial number · 6-month warranty',
  offer_qty: '1',
  offer_reserve_amount: '',
  offer_reserve_url: '',
  // PayU payment gateway (for the Reserve button). Keys are private (never sent to browser).
  payu_enabled: '0',
  payu_mode: 'test',
  payu_merchant_key: '',
  payu_salt: '',
  reserve_thankyou_text: 'Thank you! Your reservation payment was received. Our team will call you shortly to confirm your MacBook and complete the delivery.',
  // Flat "Reserve" button shown on every product. If a fixed PayU payment link is set,
  // the button opens it directly; otherwise it uses the dynamic PayU hosted-checkout flow.
  reserve_button_enabled: '1',
  reserve_flat_amount: '1999',
  reserve_payment_link: '',
  // SEO + Analytics (injected into the page <head>/<body> from the server)
  site_url: 'https://mobirapid.in',
  meta_title: 'Mobirapid — Refurbished MacBooks with Warranty & GST Invoice',
  meta_description: 'Buy quality-checked refurbished Apple MacBooks in India — 35-point tested, 6-month warranty and GST invoice. Book a free consultation with Mobirapid.',
  meta_keywords: 'refurbished macbook, used macbook, buy refurbished macbook india, macbook pro, macbook air, second hand macbook',
  og_image: '',
  ga_measurement_id: '',
  head_code: '',
  body_code: '',
  // Meta (Facebook) Conversions API — server-side Lead events
  fb_capi_enabled: '0',
  fb_pixel_id: '',
  fb_capi_token: '',
  // About section
  about_enabled: '1',
  about_title: 'About Mobirapid',
  about_text:
    "Mobirapid helps individuals and businesses buy the right Apple MacBook without overpaying. Every device — new or refurbished — is quality-checked across 35+ points, comes with a GST invoice and serial number, and is backed by a 6-month warranty.\n\nWe don't just sell laptops; we match you to the machine that fits your work, whether that's AI, machine learning, data science or everyday tasks. Our team guides you on a free consultation call, offers buyback & exchange on your old MacBook, and delivers with care.",
  // Contact section
  contact_enabled: '1',
  contact_title: 'Contact us',
  contact_subtitle: "Have a question? We'd love to help.",
  contact_address: '',
  google_maps_url: '',
  google_maps_embed: '',
  // "How we test" (QC) section
  qc_enabled: '1',
  qc_title: 'How we test — 35-point quality check',
  qc_subtitle: 'Every MacBook passes a rigorous inspection before it reaches you.',
  qc_items: JSON.stringify([
    { icon: 'battery', title: 'Battery', note: 'Health & charge cycles' },
    { icon: 'display', title: 'Display', note: 'Pixels & brightness' },
    { icon: 'keyboard', title: 'Keyboard & trackpad', note: 'Every key & gesture' },
    { icon: 'plug', title: 'Ports & Wi-Fi', note: 'All connectivity' },
    { icon: 'camera', title: 'Camera & mic', note: 'Audio & video' },
    { icon: 'storage', title: 'Storage & speed', note: 'SSD & performance' },
  ]),
  // "How it works" steps (editable in the admin)
  how_enabled: '1',
  how_title: 'How it works',
  how_steps: JSON.stringify([
    { title: 'Schedule a video call', note: 'See the exact device live on a video call and verify its condition before you commit.' },
    { title: 'Reserve the device', note: 'Book it with a small reservation amount — adjusted in your final invoice.' },
    { title: 'Open-box delivery', note: 'Delivered open-box to your doorstep (prepaid), or collect it from our office.' },
  ]),
  qc_video_enabled: '1',
  qc_video_text: 'Prefer to see it yourself? Book a free video-call verification and inspect your exact device — serial number, condition and performance — live before you pay.',
  // FAQ section
  faq_enabled: '1',
  faq_title: 'Frequently asked questions',
  faq_items: JSON.stringify([
    { q: 'Are these genuine Apple MacBooks?', a: 'Yes — every device is an original Apple MacBook, verified by serial number and supplied with a GST invoice.' },
    { q: 'Can I verify the device before buying?', a: 'Absolutely. We offer a free video-call verification where we show you your exact device live — serial number, condition and performance — before you pay.' },
    { q: 'What warranty do I get?', a: 'Every refurbished MacBook comes with a 6-month warranty, in addition to your rights under the Consumer Protection Act.' },
    { q: 'What if the device has a problem?', a: 'You are covered by our warranty and return policy. Contact us and we will repair, replace or refund as per the policy.' },
    { q: 'Do you provide a GST invoice?', a: 'Yes, every purchase includes a GST invoice with the device serial number.' },
  ]),
  // Condition grades — defined on the /condition page and linked from product condition tags.
  condition_enabled: '1',
  condition_title: 'Condition grades explained',
  condition_intro: 'Every device passes our 35-point quality check and is then graded honestly so you know exactly what you are buying. Here is what each grade means — cosmetically and functionally.',
  condition_grades: JSON.stringify([
    { grade: 'New Sealed Pack', summary: 'Brand-new, factory-sealed', detail: 'Completely new, factory-sealed and never opened, with full manufacturer warranty and 100% battery health. Indistinguishable from retail.' },
    { grade: 'Open Box & Non-activated', summary: 'Opened for checks, never activated', detail: 'The box was opened only for our verification, but the device was never activated or used. As good as new, with full warranty and pristine cosmetics.' },
    { grade: 'Open Box & Activated', summary: 'Activated & tested, essentially unused', detail: 'Opened and activated for testing (for example an ex-display or lightly handled unit) but essentially unused. No meaningful signs of wear.' },
    { grade: 'Excellent', summary: 'Near-new, no visible marks', detail: 'Lightly used and fully refurbished. No visible scratches or dents on close inspection and high battery health — looks almost new.' },
    { grade: 'Very Good', summary: 'Minor light micro-scratches', detail: 'Minor signs of use — light micro-scratches visible only at certain angles, no dents. Fully tested and working perfectly.' },
    { grade: 'Good', summary: 'Light visible wear', detail: 'Noticeable but minor cosmetic wear such as light scratches or scuffs, and possibly small marks. Fully functional and tested.' },
    { grade: 'Fair', summary: 'Visible wear, great value', detail: 'Visible cosmetic wear (scratches, scuffs and possibly minor dents) but fully functional and tested. The best value for money.' },
  ]),
  // USP / "Why buy from us" strip
  usps_enabled: '1',
  usps_title: 'Why buy from Mobirapid',
  usps: JSON.stringify([
    { icon: 'invoice', title: 'GST Invoice with Serial Number' },
    { icon: 'qc', title: '35+ Checkpoint QC' },
    { icon: 'warranty', title: '6 Months Warranty' },
    { icon: 'openbox', title: 'Open Box Delivery', note: '*if service available' },
    { icon: 'card', title: 'Credit Card Payment' },
    { icon: 'exchange', title: 'Old MacBook Buyback & Exchange' },
  ]),
  // Blog
  blog_enabled: '1',
  blog_title: 'From our blog',
  blog_subtitle: 'Guides and tips on MacBooks and the Apple ecosystem.',
  footer_text: '© Mobirapid. All rights reserved.',
  footer_email: 'sachin@mobirapid.com',
  footer_tagline: 'Quality-checked new & refurbished Apple MacBooks, matched to your work — with GST invoice, warranty and expert guidance.',
  // Business & India compliance details
  legal_name: 'MOBIRAPID PRIVATE LIMITED',
  gstin: '08AAPCM9747E1ZV',
  registered_address: 'Head Office: A1, Above HDFC Bank, First Floor, Dev Nagar, Tonk Road, Jaipur, Rajasthan — GSTIN: 08AAPCM9747E1ZV\nBranch Office: AVS Compound, 27, 4th Block, Koramangala, Bengaluru, Karnataka 560034 — GSTIN: 29AAPCM9747E1ZR',
  customer_care_email: 'sachin@mobirapid.com',
  customer_care_phone: '',
  grievance_officer_name: '',
  grievance_officer_email: 'sachin@mobirapid.com',
  grievance_officer_phone: '',
  // Social & contact links (blank = hidden). WhatsApp/phone: digits with country code.
  social_instagram: '',
  social_facebook: '',
  social_linkedin: '',
  social_email: 'sachin@mobirapid.com',
  social_phone: '',
  social_whatsapp: '',
  // Google Reviews integration
  reviews_enabled: '0',
  reviews_title: 'What our customers say',
  google_reviews_url: '',
  google_rating: '4.9',
  google_review_count: '0',
  // Live Google rating (Google Places API)
  google_reviews_live: '0',
  google_place_id: '',
  google_places_api_key: '',
  // --- Integrations: SMS (OTP) + Email. Seeded once from .env if present, then
  //     managed from the admin panel. These are NOT exposed in the public API. ---
  otp_provider: process.env.OTP_PROVIDER || 'mock',
  otp_ttl_minutes: process.env.OTP_TTL_MINUTES || '10',
  twilio_account_sid: process.env.TWILIO_ACCOUNT_SID || '',
  twilio_auth_token: process.env.TWILIO_AUTH_TOKEN || '',
  twilio_messaging_service_sid: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
  twilio_from_number: process.env.TWILIO_FROM_NUMBER || '',
  twofactor_api_key: process.env.TWOFACTOR_API_KEY || '',
  twofactor_template_name: process.env.TWOFACTOR_TEMPLATE || '',
  smtp_host: process.env.SMTP_HOST || '',
  smtp_port: process.env.SMTP_PORT || '587',
  smtp_secure: process.env.SMTP_SECURE || 'false',
  smtp_user: process.env.SMTP_USER || '',
  smtp_pass: process.env.SMTP_PASS || '',
  mail_from: process.env.MAIL_FROM || '',
  lead_notify_to: process.env.LEAD_NOTIFY_TO || 'sachin@mobirapid.com',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

// One-time correction of the registered business details to match the PayU-verified
// merchant record (GSTIN, legal name). Runs once; admins can still edit afterwards.
const GST_FIX_FLAG = 'gst_details_fix_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(GST_FIX_FLAG)) {
  const setVal = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  setVal.run('legal_name', 'MOBIRAPID PRIVATE LIMITED');
  setVal.run('gstin', '08AAPCM9747E1ZV');
  setVal.run(GST_FIX_FLAG, '1');
}

// One-time: set the registered office addresses (head office + branch, each with its GSTIN).
// Used on policy pages, contact section and footer. Admin can edit later.
const ADDR_FIX_FLAG = 'address_fix_v2';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(ADDR_FIX_FLAG)) {
  const addr = 'Head Office: A1, Above HDFC Bank, First Floor, Dev Nagar, Tonk Road, Jaipur, Rajasthan — GSTIN: 08AAPCM9747E1ZV\n'
    + 'Branch Office: AVS Compound, 27, 4th Block, Koramangala, Bengaluru, Karnataka 560034 — GSTIN: 29AAPCM9747E1ZR';
  const s = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  s.run('registered_address', addr);
  s.run('contact_address', addr);
  s.run(ADDR_FIX_FLAG, '1');
}

// One-time: set the canonical site URL to the live .in domain (used for canonical tags,
// sitemap, and PayU success/failure return URLs). Admin can change it later.
const DOMAIN_FIX_FLAG = 'domain_fix_in_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(DOMAIN_FIX_FLAG)) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('site_url', 'https://mobirapid.in');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DOMAIN_FIX_FLAG, '1');
}

// --- Seed compliance pages (India-specific templates) ---
// NOTE: These are starter templates aligned with Indian law (IT Act 2000 & SPDI
// Rules 2011, DPDP Act 2023, Consumer Protection (E-Commerce) Rules 2020, IT Rules
// 2021). Please review and adapt them with your legal advisor before going live.
const PAGE_MARKER = 'MOBIRAPID_DEFAULT_TEMPLATE';
const OLD_MARKER = 'update this date from the admin panel';
const reviewNote = `<p><em>Last reviewed: please update this date and verify all details from the admin panel. This is a starter template — review it with your legal advisor. <span style="display:none">${PAGE_MARKER}</span></em></p>`;

const DEFAULT_PAGES = [
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    sort_order: 1,
    content: `${reviewNote}
<p>Mobirapid ("we", "us", "our") is committed to protecting your privacy and handling your personal data in accordance with the Information Technology Act, 2000, the IT (Reasonable Security Practices and Procedures and Sensitive Personal Data or Information) Rules, 2011, and the Digital Personal Data Protection Act, 2023 (DPDP Act).</p>
<h3>Information we collect</h3>
<p>When you submit the consultation form we collect your name, phone number (verified via OTP), customer type, company name and email (for business enquiries), requirement, budget, preferred contact time and any message you provide. We may also collect basic technical data such as cookies for analytics.</p>
<h3>Purpose &amp; lawful basis</h3>
<p>We process your data, with your consent, solely to respond to your enquiry, provide our products and services, issue GST invoices, and for legitimate business and legal purposes. We do not sell your personal data.</p>
<h3>Sharing</h3>
<p>We share data only with service providers who help us operate (e.g. SMS/email delivery, logistics, and our payment gateway) and where required by applicable law or a lawful authority.</p>
<h3>Payment information</h3>
<p>Online payments (including any booking/reservation amount) are processed by our PCI-DSS compliant payment aggregator, PayU. Your full card, UPI, net-banking or wallet credentials are entered on the payment provider's secure page and are <strong>never</strong> collected, seen or stored on our servers. We only receive a payment status and transaction reference to confirm your order.</p>
<h3>Data retention &amp; security</h3>
<p>We retain your data only as long as necessary for the purposes above or as required by law, and we apply reasonable security practices to protect it.</p>
<h3>Your rights</h3>
<p>Under the DPDP Act you may request access to, correction or erasure of your personal data, and you may withdraw consent at any time by contacting us.</p>
<h3>Grievance Officer</h3>
<p>In accordance with the IT Act, 2000 and rules made thereunder, the name and contact details of our Grievance Officer are published in the footer of this website. You may write to the Grievance Officer for any data-protection or privacy concern, and we will respond within the timelines prescribed under applicable law.</p>`,
  },
  {
    slug: 'terms-conditions',
    title: 'Terms & Conditions',
    sort_order: 2,
    content: `${reviewNote}
<p>By accessing this website and placing an enquiry or order, you agree to these Terms &amp; Conditions, which are governed by the laws of India, including the Consumer Protection Act, 2019 and the Consumer Protection (E-Commerce) Rules, 2020.</p>
<h3>About us</h3>
<p>Our legal name, registered address, GSTIN and customer-care details are published in the footer of this website.</p>
<h3>Products &amp; pricing</h3>
<p>We sell new and quality-checked refurbished Apple MacBooks. Prices are in Indian Rupees (₹) and are inclusive/exclusive of GST as indicated at checkout. A GST invoice with the device serial number is provided with every purchase. Final price, configuration and availability are confirmed during your consultation.</p>
<h3>Orders</h3>
<p>Submitting the consultation form is a request to be contacted and does not by itself create a binding contract of sale. A sale is confirmed only upon our acceptance and your payment.</p>
<h3>Payments &amp; booking amount</h3>
<p>All payments are collected in Indian Rupees (₹) through our PCI-DSS compliant payment aggregator, PayU. Where you choose to reserve a device, a part-payment ("booking amount") is collected online to hold that unit for you; this booking amount is adjusted against your final invoice. Prices, taxes and any applicable shipping charges are shown before you confirm payment. We do not store your card, UPI or net-banking credentials — these are handled on PayU's secure page.</p>
<h3>Intellectual property &amp; trademark disclaimer</h3>
<p>Apple, MacBook, MacBook Air and MacBook Pro are trademarks of Apple Inc., registered in the U.S. and other countries. Mobirapid is an independent reseller and is not affiliated with, authorised, sponsored or endorsed by Apple Inc.</p>
<h3>Governing law &amp; jurisdiction</h3>
<p>These terms are governed by Indian law and subject to the exclusive jurisdiction of the courts at our registered place of business.</p>`,
  },
  {
    slug: 'refund-policy',
    title: 'Refund & Cancellation Policy',
    sort_order: 3,
    content: `${reviewNote}
<h3>Order cancellation</h3>
<p>You may cancel an order any time before it is dispatched by contacting our customer care. Once a cancellation is accepted, any amount already paid (including a booking/reservation amount) is refunded in full to your original payment method.</p>
<h3>Booking / reservation amount</h3>
<p>A booking amount paid to reserve a device is adjusted against your final invoice. If you cancel before dispatch, or if we are unable to fulfil the reserved device, the booking amount is refunded in full. Booking amounts are non-refundable only where you fail to complete the purchase after the device has been held and confirmed for you, as communicated at the time of reservation.</p>
<h3>Returns</h3>
<p>If a device is dead-on-arrival or does not match the agreed specification or condition, you may raise a return request within the return window communicated at the time of purchase. The device must be returned with all original accessories, packaging and the invoice.</p>
<h3>Refund timeline</h3>
<p>Approved refunds and cancellations are processed to the original payment method within <strong>7–10 business days</strong> (for returns, after the returned device passes inspection), in line with the Consumer Protection (E-Commerce) Rules, 2020. The actual credit date depends on your bank or card issuer.</p>
<h3>Non-returnable cases</h3>
<p>Returns are not accepted for physical/liquid damage caused after delivery, unauthorised repair, or missing accessories, except where required by law.</p>
<h3>How to claim</h3>
<p>To cancel an order or start a return or refund, contact our customer care (details below) with your order/transaction number and reason. You may also escalate to our Grievance Officer.</p>`,
  },
  {
    slug: 'warranty-policy',
    title: 'Warranty Policy',
    sort_order: 4,
    content: `${reviewNote}
<h3>Coverage</h3>
<p>Each MacBook is covered by a warranty whose duration is confirmed at purchase and shown on the product card where applicable (refurbished devices typically carry a 6-month warranty). This is in addition to any rights you have under the Consumer Protection Act, 2019.</p>
<h3>What's covered</h3>
<p>The warranty covers hardware faults arising in normal use that are not caused by accidental damage, liquid damage, or unauthorised repair.</p>
<h3>Claims</h3>
<p>To make a warranty claim, contact our customer care (details in the footer) with your invoice, device serial number and a description of the issue.</p>`,
  },
  {
    slug: 'shipping-policy',
    title: 'Shipping & Delivery',
    sort_order: 5,
    content: `${reviewNote}
<h3>Delivery</h3>
<p>We deliver across serviceable locations in India through reputed courier and logistics partners. Orders are typically dispatched within <strong>1–3 business days</strong> of payment confirmation and delivered within <strong>3–7 business days</strong>, depending on your location. Exact timelines are confirmed at the time of order.</p>
<h3>Charges</h3>
<p>Shipping charges, if any, are displayed before you confirm your order. Open-box delivery may be available in select locations where the service is supported.</p>
<h3>Tracking &amp; receipt</h3>
<p>You will receive tracking details once your order is dispatched. Please inspect the package at the time of delivery and report any visible damage immediately.</p>
<h3>Support</h3>
<p>For any delivery query, contact our customer care (details in the footer).</p>`,
  },
  {
    slug: 'grievance-redressal',
    title: 'Grievance Redressal',
    sort_order: 6,
    content: `${reviewNote}
<h3>Our commitment</h3>
<p>In compliance with the Information Technology Act, 2000, the IT (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021, the Consumer Protection (E-Commerce) Rules, 2020 and the Digital Personal Data Protection Act, 2023, Mobirapid has appointed a Grievance Officer to address complaints regarding our products, services, orders and the handling of your personal data.</p>
<h3>Grievance Officer</h3>
<p>The name and contact details of our Grievance Officer are published in the footer of this website. You may contact the Grievance Officer by email or phone for any complaint.</p>
<h3>How to raise a complaint</h3>
<p>Write to our Grievance Officer (or our customer care) with your name, contact number, order/invoice number (if any) and a clear description of the issue. Please retain any supporting documents.</p>
<h3>Resolution timelines</h3>
<p>We will acknowledge your complaint within 48 hours of receipt and endeavour to resolve it within 30 days, or within any shorter period required by applicable law. Data-protection grievances under the DPDP Act, 2023 are handled within the timelines prescribed thereunder.</p>
<h3>Escalation</h3>
<p>If you are not satisfied with the resolution, you may approach the appropriate consumer forum or the National Consumer Helpline (1915 · consumerhelpline.gov.in).</p>`,
  },
  {
    slug: 'contact-us',
    title: 'Contact Us',
    sort_order: 7,
    content: `${reviewNote}
<p>We're happy to help with any question about our refurbished MacBooks, your order, a payment, a return or a warranty claim. Reach us using the details below and our team will respond promptly during business hours.</p>
<h3>Business hours</h3>
<p>Monday to Saturday, 10:00 AM – 7:00 PM IST (excluding public holidays).</p>
<h3>Registered business &amp; contact details</h3>
<p>Our full legal name, registered address, GSTIN, customer-care email and phone number are listed at the bottom of this page and in the site footer. For payment or refund queries, please keep your order/transaction reference handy.</p>`,
  },
];

const insPage = db.prepare('INSERT INTO content_pages (slug, title, content, sort_order) VALUES (?, ?, ?, ?)');
const getPage = db.prepare('SELECT content FROM content_pages WHERE slug = ?');
const updPage = db.prepare("UPDATE content_pages SET title = ?, content = ?, sort_order = ?, updated_at = datetime('now') WHERE slug = ?");
for (const p of DEFAULT_PAGES) {
  const existing = getPage.get(p.slug);
  if (!existing) {
    insPage.run(p.slug, p.title, p.content, p.sort_order);
  } else if (existing.content && (existing.content.indexOf(OLD_MARKER) !== -1 || existing.content.indexOf(PAGE_MARKER) !== -1)) {
    // Page still has an unedited starter template (old or current) — safe to refresh.
    updPage.run(p.title, p.content, p.sort_order, p.slug);
  }
  // Otherwise the page was edited by the admin — leave it untouched.
}

// --- Seed a few example MacBook models (only if table is empty) ---
const modelCount = db.prepare('SELECT COUNT(*) AS n FROM macbook_models').get().n;
if (modelCount === 0) {
  const insModel = db.prepare(
    `INSERT INTO macbook_models (name, price, image, specs, badge, condition_grade, warranty, sort_order, active)
     VALUES (@name, @price, @image, @specs, @badge, @condition_grade, @warranty, @sort_order, @active)`
  );
  const seed = [
    { name: 'MacBook Pro 14" M3', price: '₹1,29,000', image: '', specs: 'M3 · 16GB · 512GB SSD', badge: 'Hot', condition_grade: 'Excellent', warranty: '6-month warranty', sort_order: 1, active: 1 },
    { name: 'MacBook Air 13" M2', price: '₹84,000', image: '', specs: 'M2 · 8GB · 256GB SSD', badge: 'Available', condition_grade: 'Very Good', warranty: '6-month warranty', sort_order: 2, active: 1 },
    { name: 'MacBook Pro 16" M1 Pro', price: '₹1,45,000', image: '', specs: 'M1 Pro · 16GB · 1TB SSD', badge: 'Hot', condition_grade: 'Excellent', warranty: '6-month warranty', sort_order: 3, active: 1 },
  ];
  for (const m of seed) insModel.run(m);
}

// --- One-time catalog load (v1): replace the example models with the real
//     refurbished MacBook line-up. Prices and images are left blank for the
//     admin to fill/upload. Runs once, then never touches the table again. ---
const catalogFlag = db.prepare("SELECT value FROM settings WHERE key = 'catalog_v1'").get();
if (!catalogFlag || catalogFlag.value !== '1') {
  db.exec('DELETE FROM macbook_models');
  const insCat = db.prepare(
    `INSERT INTO macbook_models (name, price, image, specs, description, badge, condition_grade, warranty, sort_order, active)
     VALUES (@name, @price, @image, @specs, @description, @badge, @condition_grade, @warranty, @sort_order, @active)`
  );
  const W = '6-month warranty';
  const catalog = [
    { name: 'Refurbished MacBook Pro 16" M3 Pro', specs: 'M3 Pro · 16-inch · 36GB · 512GB SSD', description: '16-inch Liquid Retina XDR display with the M3 Pro chip and 36GB memory — built for the most demanding video editing, 3D and software-development workloads.', badge: 'Hot', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Pro 14" M3 Pro', specs: 'M3 Pro · 14-inch · 18GB · 512GB SSD', description: '14-inch MacBook Pro with the M3 Pro chip and 18GB memory — serious pro performance in a compact, portable body.', badge: 'Hot', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Pro 14" M2 Pro', specs: 'M2 Pro · 14-inch · 16GB · 512GB SSD', description: '14-inch MacBook Pro with the M2 Pro chip — fast, efficient and ideal for creators and developers.', badge: 'Available', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Pro 16" M1 Pro', specs: 'M1 Pro · 16-inch · 16GB · 512GB SSD', description: 'Large 16-inch Liquid Retina XDR display powered by the M1 Pro chip — a portable powerhouse with all-day battery life.', badge: 'Hot', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Pro 14" M1 Pro', specs: 'M1 Pro · 14-inch · 16GB · 512GB SSD', description: '14-inch MacBook Pro with M1 Pro performance — great for coding, photo and video work on the move.', badge: 'Available', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Air 13" M4', specs: 'M4 · 13-inch · 24GB · 512GB SSD', description: 'The latest M4 MacBook Air with 24GB memory — a thin, light machine that comfortably handles heavy multitasking.', badge: 'Hot', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Air 13" M4', specs: 'M4 · 13-inch · 16GB · 512GB SSD', description: 'The newest M4 MacBook Air — faster and more efficient than ever for everyday and creative work.', badge: 'Hot', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Air 13" M3', specs: 'M3 · 13-inch · 16GB · 512GB SSD', description: 'Ultra-thin, fanless MacBook Air with the fast, efficient M3 chip — ideal for work, study and creative tasks.', badge: 'Available', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Air 13" M2', specs: 'M2 · 13-inch · 16GB · 256GB SSD', description: 'MacBook Air with the M2 chip and 16GB memory — smooth multitasking in a sleek, lightweight design.', badge: 'Available', condition_grade: 'Excellent' },
    { name: 'Refurbished MacBook Air 13" M2', specs: 'M2 · 13-inch · 8GB · 256GB SSD', description: 'Lightweight MacBook Air with the M2 chip — a reliable everyday laptop with excellent battery life.', badge: 'Available', condition_grade: 'Very Good' },
    { name: 'Refurbished MacBook Air 13" M1', specs: 'M1 · 13-inch · 8GB · 256GB SSD', description: 'The classic M1 MacBook Air — silent, efficient and dependable for browsing, office work and study.', badge: 'Available', condition_grade: 'Very Good' },
  ];
  catalog.forEach((m, i) => insCat.run({
    name: m.name, price: '', image: '', specs: m.specs, description: m.description,
    badge: m.badge, condition_grade: m.condition_grade, warranty: W, sort_order: i + 1, active: 1,
  }));
  db.prepare("INSERT INTO settings (key, value) VALUES ('catalog_v1', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
}

// --- Seed example reviews (only if table is empty) ---
const reviewCount = db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n;
if (reviewCount === 0) {
  const insReview = db.prepare(
    'INSERT INTO reviews (author, rating, text, date_label, sort_order, active) VALUES (@author, @rating, @text, @date_label, @sort_order, @active)'
  );
  const seed = [
    { author: 'Priya N.', rating: 5, text: 'Got a refurbished MacBook Pro for my data science work — exactly the spec they recommended, and it runs flawlessly.', date_label: '2 weeks ago', sort_order: 1, active: 1 },
    { author: 'Rahul M.', rating: 5, text: 'Smooth consultation call, fair pricing, and the device looked brand new. Highly recommend Mobirapid.', date_label: '1 month ago', sort_order: 2, active: 1 },
    { author: 'Aisha K.', rating: 5, text: 'They helped our startup buy 4 machines within budget. Great service and quick delivery.', date_label: '1 month ago', sort_order: 3, active: 1 },
  ];
  for (const r of seed) insReview.run(r);
}

// --- Seed starter blog posts (only if table is empty) ---
const blogCount = db.prepare('SELECT COUNT(*) AS n FROM blog_posts').get().n;
if (blogCount === 0) {
  const insBlog = db.prepare(
    `INSERT INTO blog_posts (slug, title, excerpt, content, cover_image, author, meta_description, tags, published)
     VALUES (@slug, @title, @excerpt, @content, @cover_image, @author, @meta_description, @tags, @published)`
  );
  const posts = [
    {
      slug: 'refurbished-vs-new-macbook-2025',
      title: 'Refurbished vs New MacBook: which should you buy?',
      excerpt: 'A refurbished MacBook can save you 30–60% over new. Here is how to decide which is right for you.',
      meta_description: 'Refurbished vs new MacBook — compare price, warranty, condition and value to decide which is right for you in India.',
      author: 'Mobirapid Team',
      content: `<p>Apple MacBooks hold their value and last for years, which makes a good refurbished unit one of the smartest purchases in tech. But is refurbished right for you, or should you buy new? Here is a simple way to decide.</p>
<h3>When refurbished makes sense</h3>
<p>If you want maximum value, a quality-checked refurbished MacBook typically costs 30–60% less than new while performing identically for everyday work, study, coding and creative tasks. Look for a seller that grades condition honestly, tests the battery, and provides a warranty and a GST invoice.</p>
<h3>When to buy new</h3>
<p>Buy new if you need the very latest chip on day one, want the full Apple warranty, or need a specific build-to-order configuration. For most people, though, last-generation refurbished hardware is more than enough — an M1 or M2 MacBook still flies.</p>
<h3>What to check before buying refurbished</h3>
<p>Confirm the exact chip, RAM and storage; ask for the battery health; verify the serial number; and make sure you get a written warranty. At Mobirapid, every device passes a 35-point quality check and you can even verify your unit on a video call before you pay.</p>`,
      cover_image: '/uploads/blog-refurbished.jpg', tags: 'Buying guide, Refurbished', published: 1,
    },
    {
      slug: 'check-macbook-battery-health',
      title: 'How to check the battery health of your MacBook',
      excerpt: 'Battery health is the number one thing to check on any used MacBook. Here is how to read it in seconds.',
      meta_description: 'Learn how to check your MacBook battery health and cycle count in seconds, and what a healthy number looks like.',
      author: 'Mobirapid Team',
      content: `<p>Battery is the part of a laptop that wears with use, so it is the first thing to check on any pre-owned MacBook. The good news: macOS tells you everything you need in a couple of clicks.</p>
<h3>The quick way</h3>
<p>Hold <strong>Option</strong> and click the battery icon in the menu bar, or open <em>System Settings → Battery → Battery Health</em>. You will see a status such as "Normal" and, on newer versions, a maximum-capacity percentage.</p>
<h3>Check the cycle count</h3>
<p>Open <em>Apple menu → About This Mac → More Info → System Report → Power</em> and look for "Cycle Count". Apple rates most modern MacBook batteries for 1000 cycles. A unit with a few hundred cycles and 85%+ capacity has plenty of life left.</p>
<h3>What we do at Mobirapid</h3>
<p>We test and report battery health on every device, and back it with a 6-month warranty — so you never have to guess.</p>`,
      cover_image: '/uploads/blog-battery.jpg', tags: 'Tips, macOS', published: 1,
    },
    {
      slug: 'macbook-air-vs-pro',
      title: 'MacBook Air vs MacBook Pro: which one fits your work?',
      excerpt: 'Air or Pro? The right choice depends on what you actually do. Here is a plain-English guide.',
      meta_description: 'MacBook Air vs MacBook Pro — a plain-English guide to choosing the right MacBook for your workload and budget.',
      author: 'Mobirapid Team',
      content: `<p>Both the MacBook Air and MacBook Pro are excellent — the difference is how hard you push them. Here is how to choose.</p>
<h3>Choose the MacBook Air if…</h3>
<p>You mainly browse, write, use office apps, attend video calls and do light photo editing. The Air is thin, silent (fanless) and has all-day battery life. For students and everyday professionals, it is usually all the MacBook you need.</p>
<h3>Choose the MacBook Pro if…</h3>
<p>You do sustained heavy work — video editing, 3D, large codebases, music production or data science. The Pro's active cooling, brighter display and Pro-class chips keep performance high for hours, and the bigger screens help.</p>
<h3>Still not sure?</h3>
<p>Tell us what you do and your budget, and we will match you to the right refurbished model on a free consultation call.</p>`,
      cover_image: '/uploads/blog-air-vs-pro.jpg', tags: 'Buying guide, Comparison', published: 1,
    },
  ];
  for (const p of posts) insBlog.run(p);
}

// Backfill cover images on the starter posts if they were seeded before covers existed
// (only fills blanks — never overwrites a cover you set yourself).
const starterCovers = {
  'refurbished-vs-new-macbook-2025': '/uploads/blog-refurbished.jpg',
  'check-macbook-battery-health': '/uploads/blog-battery.jpg',
  'macbook-air-vs-pro': '/uploads/blog-air-vs-pro.jpg',
};
const updCover = db.prepare("UPDATE blog_posts SET cover_image = ? WHERE slug = ? AND (cover_image IS NULL OR cover_image = '')");
for (const [slug, img] of Object.entries(starterCovers)) updCover.run(img, slug);

// Add specific articles on deploy if they don't already exist (by slug).
const extraPosts = [
  {
    slug: 'how-to-qc-a-macbook',
    title: 'How to QC a MacBook before you buy: a practical checklist',
    excerpt: 'Buying a used or refurbished MacBook? Run these checks in 10 minutes to make sure it is genuine, healthy and worth the price.',
    meta_description: 'A practical checklist to quality-check (QC) a used or refurbished MacBook — serial number, battery health, display, keyboard, Activation Lock and more.',
    author: 'Mobirapid Team',
    cover_image: '/uploads/blog-qc.jpg',
    tags: 'Buying guide, Tips, Refurbished',
    published: 1,
    content: `<p>A MacBook is a big purchase, and a few minutes of checking can save you from an expensive mistake. Whether you buy from us or anywhere else, here is the exact quality-check (QC) routine our team runs on every device — do the same and you will buy with confidence.</p>
<h3>1. Verify it is a genuine Apple device</h3>
<p>Check the serial number under <em>Apple menu → About This Mac</em> and confirm it on Apple's "Check Coverage" page. The serial there should match the one printed on the underside of the MacBook. This confirms the model, year and that it is a real Apple unit.</p>
<h3>2. Check Activation Lock and Find My</h3>
<p>Make sure the previous owner has signed out of iCloud and removed the device from Find My. Go to <em>System Settings → your name → Find My</em>. A locked device is unusable — never pay before this is cleared.</p>
<h3>3. Battery health and cycle count</h3>
<p>Open <em>System Settings → Battery → Battery Health</em> for the maximum capacity, and <em>About This Mac → System Report → Power</em> for the cycle count. Apple rates modern batteries for about 1000 cycles; a low cycle count with 85%+ capacity is healthy.</p>
<h3>4. Display</h3>
<p>Look for dead or stuck pixels, backlight bleed and scratches. Show a full-white and a full-black image and inspect closely. Check that brightness ramps smoothly from low to high.</p>
<h3>5. Keyboard and trackpad</h3>
<p>Type in a text field and press every key. On the trackpad, test click, right-click and multi-finger gestures. Force Touch should feel consistent across the whole surface.</p>
<h3>6. Ports, Wi-Fi and Bluetooth</h3>
<p>Test each USB-C/Thunderbolt port with a charger and a device. Connect to Wi-Fi and pair a Bluetooth accessory to confirm the wireless card works.</p>
<h3>7. Camera, microphone and speakers</h3>
<p>Open Photo Booth to check the camera and mic, and play audio to confirm both speakers work without distortion.</p>
<h3>8. Storage and performance</h3>
<p>Confirm the advertised storage in <em>About This Mac → Storage</em>, and run a quick task to make sure the machine feels responsive and does not overheat or throttle under light load.</p>
<h3>9. Physical condition and paperwork</h3>
<p>Inspect the chassis, hinge and screen bezel for dents or cracks. Insist on a GST invoice with the serial number and a written warranty — this is your proof of purchase and protection.</p>
<h3>The easy way</h3>
<p>At Mobirapid, every MacBook passes a 35-point quality check covering all of the above, ships with a GST invoice and a 6-month warranty, and you can even inspect your exact device on a free video call before you pay. <a href="/#lead-form">Book a free consultation</a> and we will help you buy the right MacBook with total confidence.</p>`,
  },
  {
    slug: 'macbook-serial-number-check',
    title: 'MacBook serial number check: how to verify authenticity',
    excerpt: 'The serial number is the fastest way to confirm a MacBook is genuine and see its exact model and warranty. Here is how to check it.',
    meta_description: 'How to find and verify a MacBook serial number to confirm it is a genuine Apple device, check its model, and see warranty coverage.',
    author: 'Mobirapid Team',
    cover_image: '/uploads/blog-serial.jpg',
    tags: 'Tips, Buying guide',
    published: 1,
    content: `<p>Before buying any MacBook, the single most useful thing you can do is check its serial number. It tells you the exact model, the year, and whether the device is genuine and still under warranty. Here is how.</p>
<h3>Where to find the serial number</h3>
<p>There are three places, and they should all match: under <em>Apple menu → About This Mac</em>; printed in small text on the underside of the MacBook; and on the original box. If the numbers do not match, walk away.</p>
<h3>Verify it with Apple</h3>
<p>Go to Apple's official "Check Coverage" page and enter the serial number. Apple will confirm the model, the purchase/coverage status and whether it is eligible for support. A valid serial that returns the correct model is a strong sign the device is genuine.</p>
<h3>What the result tells you</h3>
<p>You will see the exact model (helpful because sellers sometimes mislabel year or chip), warranty and AppleCare status, and whether the serial is recognised at all. An unrecognised or "invalid" serial is a major red flag.</p>
<h3>Also check Activation Lock</h3>
<p>A genuine device can still be unusable if it is locked to someone else's iCloud. Make sure the seller has signed out of iCloud and removed the MacBook from Find My before you pay.</p>
<h3>Buy with the serial on your invoice</h3>
<p>Always get a GST invoice that lists the device serial number — it is your proof of exactly what you bought. Every Mobirapid device ships with a serial-matched GST invoice and a 6-month warranty, and we will happily verify the serial with you on a video call. <a href="/#lead-form">Talk to us</a> before you buy.</p>`,
  },
  {
    slug: 'is-refurbished-macbook-worth-it-india',
    title: 'Is a refurbished MacBook worth it in India?',
    excerpt: 'Refurbished MacBooks can be one of the best value buys in tech — if you buy from the right seller. Here is the honest answer.',
    meta_description: 'Is a refurbished MacBook worth it in India? We break down the savings, risks, warranty and how to buy safely.',
    author: 'Mobirapid Team',
    cover_image: '/uploads/blog-worth.jpg',
    tags: 'Buying guide, Refurbished',
    published: 1,
    content: `<p>Short answer: yes — a quality-checked refurbished MacBook is one of the best value purchases you can make in India, as long as you buy from a seller who tests, warranties and invoices properly. Here is the honest breakdown.</p>
<h3>The savings are real</h3>
<p>A good refurbished MacBook typically costs 30–60% less than new. Because Apple hardware lasts for years, a one- or two-generation-old MacBook (M1 or M2) still handles modern work beautifully — often for the price of a mid-range Windows laptop.</p>
<h3>What you might give up</h3>
<p>You will not get the very latest chip on day one, and the battery has some usage on it (which is why battery health matters — always ask for it). Cosmetic condition can vary, so look for honest condition grades like "Excellent" or "Very Good".</p>
<h3>The risks — and how to remove them</h3>
<p>The real risk with refurbished is buying from a seller who does not test devices or stand behind them. Remove that risk by insisting on: a 35-point quality check, stated battery health, a GST invoice with the serial number, and a written warranty. If a seller cannot provide these, keep looking.</p>
<h3>Who should buy refurbished?</h3>
<p>Students, professionals, startups buying in bulk, and anyone who wants Apple quality without paying full price. If you need absolute latest-gen hardware or a specific custom configuration, new may suit you better.</p>
<h3>The Mobirapid promise</h3>
<p>Every device is quality-checked across 35 points, comes with a GST invoice and a 6-month warranty, and you can verify your exact unit on a free video call before paying. We even buy back and exchange your old Mac. <a href="/#lead-form">Book a free consultation</a> and we will match you to the right MacBook and budget.</p>`,
  },
  {
    slug: 'best-macbook-for-ai-ml-data-science',
    title: 'Best refurbished MacBook for AI, machine learning & data science',
    excerpt: 'Which MacBook handles AI, ML and data science best — and how much RAM you really need. A practical, budget-aware guide.',
    meta_description: 'The best refurbished MacBook for AI, machine learning and data science in India — how much unified memory you need, which chip to pick, and value recommendations.',
    author: 'Mobirapid Team',
    cover_image: '/uploads/blog-ai-ml.jpg',
    tags: 'Buying guide, AI & ML, Data science',
    published: 1,
    content: `<p>Apple silicon changed the game for data work. Because the CPU, GPU and Neural Engine share a single pool of <strong>unified memory</strong>, a MacBook can move large datasets and models around far more efficiently than a traditional laptop — no copying data back and forth between separate CPU and GPU memory. That, plus all-day battery and near-silent operation, is why so many machine-learning engineers and data scientists work on a Mac. Here is how to choose the right one, especially if you are buying refurbished to stretch your budget.</p>
<h3>Memory matters more than anything else</h3>
<p>For AI, ML and data science, unified memory (RAM) is the single most important spec. It decides how large a dataset you can hold in a pandas dataframe, how big a model you can fine-tune, and whether you can run a local large language model at all. A rough guide:</p>
<p><strong>16GB</strong> — comfortable for learning, notebooks, classical ML (scikit-learn, XGBoost), data cleaning and small-to-medium datasets. This is the sensible minimum.<br>
<strong>24–36GB</strong> — the sweet spot for serious work: larger dataframes, computer-vision training, and running mid-size local LLMs (7B–13B) with quantisation.<br>
<strong>48GB and above</strong> — for heavy on-device model work, big feature sets and running larger local models smoothly.</p>
<p>Because you cannot upgrade memory later on Apple silicon, buy a little more than you think you need today.</p>
<h3>Which chip should you pick?</h3>
<p>Every M-series chip includes a Neural Engine and Metal-accelerated GPU that PyTorch and TensorFlow can use via the Metal backend. The differences are about scale and speed:</p>
<p><strong>M1 / M2 / M3 / M4 (standard)</strong> in a MacBook Air or base Pro are excellent for study, notebooks, data analysis and light model training. An M2 or M3 Air with 16–24GB is a brilliant value machine for a data-science student or analyst.<br>
<strong>M-series Pro chips</strong> (M1 Pro, M2 Pro, M3 Pro) add more CPU and GPU cores and much higher memory bandwidth — a real difference when you train models, run heavy pipelines or keep many containers open.<br>
<strong>M-series Max chips</strong> are for the heaviest local training and large-model work, with the most GPU cores and the highest memory ceilings.</p>
<h3>Storage: get an SSD you will not outgrow</h3>
<p>Datasets, model checkpoints and Docker images fill space fast. 512GB is a practical starting point; 1TB is better if you keep large datasets locally. You can always add an external SSD over Thunderbolt, but internal storage is faster and hassle-free.</p>
<h3>Value picks by budget</h3>
<p><strong>Best value overall:</strong> a refurbished M2 or M3 MacBook Air with 16–24GB — silent, light and more than capable for most data-science and ML learning.<br>
<strong>Best for serious ML:</strong> a refurbished 14" MacBook Pro with an M-series Pro chip and 24–36GB — sustained performance for training and pipelines.<br>
<strong>Best for local LLMs and heavy training:</strong> a Pro or Max configuration with 36GB+ unified memory.</p>
<p>Buying refurbished means you can often afford one memory tier higher than you could with a new machine — and for AI/ML work, that extra memory is exactly where the money should go.</p>
<h3>Set yourself up for success</h3>
<p>Install Python via <em>miniforge</em> or <em>conda</em>, use PyTorch or TensorFlow with the Metal (MPS) backend for GPU acceleration, and keep projects in isolated environments. For very large training runs you will still reach for the cloud — but a well-specced MacBook handles the vast majority of day-to-day AI and data work locally.</p>
<h3>Not sure which to choose?</h3>
<p>Tell us your workload — notebooks, computer vision, NLP, local LLMs — and your budget, and we will match you to the right refurbished MacBook. You can <a href="/compare">compare models side by side</a> or <a href="/#lead-form">book a free consultation</a>, and every device ships with a GST invoice, a 6-month warranty and a 35-point quality check.</p>`,
  },
  {
    slug: 'm1-vs-m2-vs-m3-vs-m4-macbook',
    title: 'M1 vs M2 vs M3 vs M4: which MacBook chip should you buy refurbished?',
    excerpt: 'Four generations of Apple silicon, one simple question: which offers the best value today? Here is a clear, no-hype comparison.',
    meta_description: 'M1 vs M2 vs M3 vs M4 MacBook chips compared — real-world differences, who each suits, and which offers the best value on the refurbished market.',
    author: 'Mobirapid Team',
    cover_image: '/uploads/blog-chips.jpg',
    tags: 'Buying guide, Comparison, Apple silicon',
    published: 1,
    content: `<p>Since 2020, Apple has released four generations of its own silicon — M1, M2, M3 and M4 — and each is available in standard, Pro and Max versions. On the refurbished market they now sit side by side, which raises the obvious question: which one should you actually buy? Here is a plain-English comparison to help you get the most performance for your money.</p>
<h3>M1 — the value champion</h3>
<p>The chip that started it all is still remarkably capable. An M1 MacBook Air or Pro breezes through browsing, office apps, coding, photo editing and everyday multitasking, and it is silent and cool. On the refurbished market the M1 offers the lowest price for genuine Apple-silicon performance — ideal for students, everyday professionals and anyone on a tight budget.</p>
<h3>M2 — the sweet spot</h3>
<p>The M2 improved CPU and GPU performance and raised memory ceilings. In practice it feels a little snappier than M1 under load and handles light creative and data work more comfortably. A refurbished M2 Air with 16GB is arguably the best all-round value MacBook you can buy today — modern, efficient and affordable.</p>
<h3>M3 — a real GPU and efficiency step</h3>
<p>Built on a newer process, the M3 brought a more capable GPU (with features like hardware-accelerated ray tracing) and better efficiency. If you do more sustained creative work — video, photography, larger codebases — the M3 pulls ahead while keeping excellent battery life.</p>
<h3>M4 — the latest and fastest</h3>
<p>The M4 is Apple's newest generation, with higher core counts and the strongest performance and efficiency of the four. If you want the closest thing to current-generation power at a refurbished price, and you run demanding workloads, the M4 is the pick — though it commands the highest price of the group.</p>
<h3>Standard vs Pro vs Max</h3>
<p>Within each generation, the <strong>standard</strong> chip (in the Air and base Pro) is perfect for everyday and light-creative use. <strong>Pro</strong> chips add CPU and GPU cores plus much higher memory bandwidth — noticeable in video editing, development and data work. <strong>Max</strong> chips are for the heaviest professional workloads: high-resolution video, 3D and large local models. Read the exact core counts on each product page before you buy, since configurations vary.</p>
<h3>So which is the best value?</h3>
<p><strong>Tightest budget:</strong> M1 — still excellent for daily work.<br>
<strong>Best all-round value:</strong> M2 — modern and affordable.<br>
<strong>For creators:</strong> M3 — a real GPU and efficiency step.<br>
<strong>For power users who want the latest:</strong> M4.</p>
<p>Remember that memory and storage often matter more to your day-to-day experience than the chip generation. A well-specced M1 with 16GB will feel faster for real work than a base M3 with 8GB.</p>
<h3>Compare and decide</h3>
<p>You can <a href="/compare">compare our MacBook models side by side</a> — chip, cores, memory, storage and price — and <a href="/#lead-form">book a free consultation</a> if you would like us to recommend the best value for your budget. Every device is quality-checked across 35 points and comes with a GST invoice and a 6-month warranty.</p>`,
  },
  {
    slug: 'gst-invoice-refurbished-macbook-business',
    title: 'GST invoice on a refurbished MacBook: why it matters for businesses',
    excerpt: 'Buying MacBooks for your team? A proper GST invoice protects your input tax credit, your warranty and your books. Here is what to know.',
    meta_description: 'Why a GST invoice matters when businesses buy refurbished MacBooks in India — input tax credit, warranty, authenticity and buying for teams.',
    author: 'Mobirapid Team',
    cover_image: '/uploads/blog-gst.jpg',
    tags: 'Business, GST, Buying guide',
    published: 1,
    content: `<p>For a business, buying a laptop is not just about the sticker price — it is about the paperwork behind it. When you buy refurbished MacBooks for your team, a proper <strong>GST invoice</strong> is what turns a good deal into a clean, claimable, warranty-backed business asset. Here is why it matters and what to look for.</p>
<h3>Input Tax Credit (ITC)</h3>
<p>A GST-registered business can generally claim input tax credit on the GST paid for goods bought for business use. Without a valid tax invoice — showing the seller's GSTIN, the correct GST breakdown and your business details — you cannot claim that credit. On a fleet of laptops, that ITC is real money. Always insist on a proper GST invoice, not just a cash receipt.</p>
<h3>Proof of authenticity and ownership</h3>
<p>A GST invoice that lists the device <strong>serial number</strong> is your record that the machine is genuine and legitimately yours. It ties a specific MacBook to your purchase, which matters for asset registers, audits, insurance and any future resale.</p>
<h3>Warranty and returns</h3>
<p>Your warranty and return rights are anchored to the invoice. If a device needs a warranty repair or replacement, the invoice with its serial number is what makes the claim straightforward. Buying without one leaves you exposed if anything goes wrong.</p>
<h3>Clean books and compliance</h3>
<p>Proper invoices keep your accounting clean: capitalised assets, correct GST records and a clear audit trail. For startups and growing teams, that tidiness pays off at funding, audit and tax time.</p>
<h3>Buying for a team? A few extra tips</h3>
<p>Standardise on one or two configurations so support and spares are simpler. Match the machine to the role — an Air for sales and operations, a Pro for engineering and design. Ask for stated battery health and condition grades on every unit, and get everything on one consolidated GST invoice where possible. And consider <strong>buyback or exchange</strong> of your old fleet to offset the cost of the upgrade.</p>
<h3>How Mobirapid supports business buyers</h3>
<p>Every MacBook we sell — new or refurbished — comes with a <strong>GST invoice showing the device serial number</strong>, a 6-month warranty and a 35-point quality check. We supply individuals and teams, offer buyback and exchange on your old Macs, and can help you pick consistent configurations for different roles. You can even verify each unit on a video call before you pay. <a href="/#lead-form">Book a consultation</a> and tell us your team size and requirement — we will put together the right devices and paperwork.</p>`,
  },
];
const insExtra = db.prepare(
  `INSERT INTO blog_posts (slug, title, excerpt, content, cover_image, author, meta_description, tags, published)
   VALUES (@slug, @title, @excerpt, @content, @cover_image, @author, @meta_description, @tags, @published)`
);
for (const p of extraPosts) {
  if (!db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(p.slug)) insExtra.run(p);
}

// Backfill unique slugs for MacBook models (used for /macbook/:slug product pages)
function slugifyModel(s) {
  return String(s || '').toLowerCase().trim().replace(/["]/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'macbook';
}
const allModels = db.prepare('SELECT id, name, slug FROM macbook_models').all();
const usedSlugs = new Set(allModels.map((m) => m.slug).filter(Boolean));
const setModelSlug = db.prepare('UPDATE macbook_models SET slug = ? WHERE id = ?');
for (const m of allModels) {
  if (m.slug) continue;
  let base = slugifyModel(m.name), s = base, n = 2;
  while (usedSlugs.has(s)) s = base + '-' + n++;
  usedSlugs.add(s);
  setModelSlug.run(s, m.id);
}

// Backfill structured spec fields (CPU/GPU cores, memory, storage, display, compatible software)
// derived from the model name + specs line. Only fills fields that are empty so admin edits stick.
function chipOf(text) {
  const t = String(text || '');
  if (/M4\s*Max/i.test(t)) return 'M4 Max';
  if (/M4\s*Pro/i.test(t)) return 'M4 Pro';
  if (/M4/i.test(t)) return 'M4';
  if (/M3\s*Max/i.test(t)) return 'M3 Max';
  if (/M3\s*Pro/i.test(t)) return 'M3 Pro';
  if (/M3/i.test(t)) return 'M3';
  if (/M2\s*Max/i.test(t)) return 'M2 Max';
  if (/M2\s*Pro/i.test(t)) return 'M2 Pro';
  if (/M2/i.test(t)) return 'M2';
  if (/M1\s*Max/i.test(t)) return 'M1 Max';
  if (/M1\s*Pro/i.test(t)) return 'M1 Pro';
  if (/M1/i.test(t)) return 'M1';
  return '';
}
const CHIP_CORES = {
  'M1':      { cpu: '8-core CPU', gpu: '7-core GPU' },
  'M2':      { cpu: '8-core CPU', gpu: '10-core GPU' },
  'M3':      { cpu: '8-core CPU', gpu: '10-core GPU' },
  'M4':      { cpu: '10-core CPU', gpu: '10-core GPU' },
  'M1 Pro':  { cpu: '10-core CPU', gpu: '16-core GPU' },
  'M2 Pro':  { cpu: '12-core CPU', gpu: '19-core GPU' },
  'M3 Pro':  { cpu: '12-core CPU', gpu: '18-core GPU' },
  'M4 Pro':  { cpu: '14-core CPU', gpu: '20-core GPU' },
  'M1 Max':  { cpu: '10-core CPU', gpu: '32-core GPU' },
  'M2 Max':  { cpu: '12-core CPU', gpu: '38-core GPU' },
  'M3 Max':  { cpu: '16-core CPU', gpu: '40-core GPU' },
  'M4 Max':  { cpu: '16-core CPU', gpu: '40-core GPU' },
};
// Pro chips shipped different base core counts by screen size — pick the accurate base config.
function coresFor(chip, name) {
  const is16 = /16[\s-]?inch|16"/.test(String(name || ''));
  if (chip === 'M1 Pro') return is16 ? { cpu: '10-core CPU', gpu: '16-core GPU' } : { cpu: '8-core CPU', gpu: '14-core GPU' };
  if (chip === 'M2 Pro') return is16 ? { cpu: '12-core CPU', gpu: '19-core GPU' } : { cpu: '10-core CPU', gpu: '16-core GPU' };
  if (chip === 'M3 Pro') return is16 ? { cpu: '12-core CPU', gpu: '18-core GPU' } : { cpu: '11-core CPU', gpu: '14-core GPU' };
  return CHIP_CORES[chip] || { cpu: '', gpu: '' };
}
function displayOf(chip, name) {
  const n = String(name || '');
  if (/16[\s-]?inch|16"/.test(n)) return '16.2" Liquid Retina XDR · 3456×2234 · 120Hz ProMotion · 1000 nits';
  if (/14[\s-]?inch|14"/.test(n)) return '14.2" Liquid Retina XDR · 3024×1964 · 120Hz ProMotion · 1000 nits';
  if (chip === 'M1' && /Air/i.test(n)) return '13.3" Retina · 2560×1600 · 400 nits';
  return '13.6" Liquid Retina · 2560×1664 · 500 nits';
}
function softwareOf(chip) {
  if (/Pro|Max/.test(chip)) {
    return 'Final Cut Pro, DaVinci Resolve & Adobe Premiere (4K/8K editing), Blender & Cinema 4D (3D), Xcode, Docker, Logic Pro, Photoshop & Lightroom, and AI/ML frameworks (PyTorch, TensorFlow).';
  }
  return 'Adobe Photoshop & Lightroom, Final Cut Pro, Xcode & VS Code, Microsoft Office 365, Figma, light 4K video editing, and data-science notebooks (Python, Jupyter).';
}
function memStoreFrom(specs) {
  const parts = String(specs || '').split(/[·|,]/).map((x) => x.trim());
  let memory = '', storage = '';
  for (const p of parts) {
    if (/SSD|TB|storage/i.test(p) && /\d/.test(p)) storage = p;
    else if (/GB\b/i.test(p) && /RAM|memory/i.test(p)) memory = p.replace(/\s*(RAM|memory)/i, '').trim();
    else if (/GB\b/i.test(p) && !storage && parts.indexOf(p) !== parts.length - 1) memory = memory || p;
  }
  // Fallback: first "NNGB" token = memory, a token with SSD/TB = storage
  if (!memory) { const m = String(specs || '').match(/(\d+)\s*GB(?!\s*SSD)/i); if (m) memory = m[1] + 'GB'; }
  if (!storage) { const s = String(specs || '').match(/(\d+\s*(?:GB|TB)\s*SSD)/i); if (s) storage = s[1]; }
  if (memory && !/GB|memory/i.test(memory)) memory = memory + 'GB';
  if (memory) memory = memory.replace(/\s+/g, '') + (/(unified|memory)/i.test(memory) ? '' : ' unified memory');
  return { memory, storage };
}
const specModels = db.prepare('SELECT id, name, specs, cpu, gpu, memory, storage, display, software FROM macbook_models').all();
const setSpecs = db.prepare('UPDATE macbook_models SET cpu=@cpu, gpu=@gpu, memory=@memory, storage=@storage, display=@display, software=@software WHERE id=@id');
for (const m of specModels) {
  if (m.cpu || m.gpu || m.display || m.software) continue; // don't overwrite admin edits
  const chip = chipOf(m.name) || chipOf(m.specs);
  const cores = coresFor(chip, m.name);
  const ms = memStoreFrom(m.specs);
  setSpecs.run({
    id: m.id,
    cpu: (chip ? chip + ' chip · ' : '') + cores.cpu,
    gpu: cores.gpu,
    memory: ms.memory,
    storage: ms.storage,
    display: displayOf(chip, m.name),
    software: softwareOf(chip),
  });
}

// One-time correction: earlier auto-fill used upgraded (higher) core counts for some base
// configs. Fix the seeded catalog to Apple's accurate base specs. Runs once, and skips any
// row an admin has clearly customised (so manual edits are never clobbered).
const SPEC_FIX_FLAG = 'spec_cores_fix_v2';
const already = db.prepare('SELECT value FROM settings WHERE key = ?').get(SPEC_FIX_FLAG);
if (!already) {
  const CORRECT = {
    'Refurbished MacBook Pro 14" M3 Pro': { from: '12-core CPU', cpu: 'M3 Pro chip · 11-core CPU', gpu: '14-core GPU' },
    'Refurbished MacBook Pro 14" M2 Pro': { from: '12-core CPU', cpu: 'M2 Pro chip · 10-core CPU', gpu: '16-core GPU' },
    'Refurbished MacBook Pro 14" M1 Pro': { from: '10-core CPU', cpu: 'M1 Pro chip · 8-core CPU', gpu: '14-core GPU' },
    'Refurbished MacBook Air 13" M2':     { from: '10-core GPU', cpu: 'M2 chip · 8-core CPU', gpu: '8-core GPU' },
  };
  const upd = db.prepare('UPDATE macbook_models SET cpu=@cpu, gpu=@gpu WHERE id=@id');
  const rows = db.prepare('SELECT id, name, cpu, gpu FROM macbook_models').all();
  for (const r of rows) {
    const fix = CORRECT[r.name];
    if (!fix) continue;
    // Only correct rows that still hold the old auto-filled value (don't touch admin edits)
    if ((r.cpu || '').includes(fix.from) || (r.gpu || '').includes(fix.from)) {
      upd.run({ id: r.id, cpu: fix.cpu, gpu: fix.gpu });
    }
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(SPEC_FIX_FLAG, '1');
}

// One-time: restore the global price note to "+ 18% GST" (exclusive) — only tablets are
// GST-inclusive, handled via a per-category price note below.
const PRICE_NOTE_FIX_FLAG = 'price_note_fix_v2';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(PRICE_NOTE_FIX_FLAG)) {
  const cur = db.prepare("SELECT value FROM settings WHERE key = 'price_note'").get();
  if (cur && cur.value === 'incl. 18% GST') {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('price_note', '+ 18% GST')").run();
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(PRICE_NOTE_FIX_FLAG, '1');
}

// Per-category price note override (blank = use the global note).
ensureColumn('categories', 'price_note', 'TEXT');
// Per-category homepage visibility (0 = keep off the homepage; category page still works). NULL/1 = shown.
ensureColumn('categories', 'show_home', 'INTEGER');
ensureColumn('categories', 'icon_image', 'TEXT'); // Circle icon for the homepage category strip.

// One-time seed: Samsung tablet catalog into a "Refurbished Tablets" category.
const TAB_FLAG = 'tablets_seed_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(TAB_FLAG)) {
  let cat = db.prepare("SELECT slug FROM categories WHERE slug = 'tablets' OR url_prefix = 'tablet'").get();
  if (!cat) {
    // Seeded hidden — the whole category stays off the site until you verify and enable it.
    db.prepare('INSERT INTO categories (slug, name, singular, url_prefix, tagline, fields, sort_order, active, price_note) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('tablets', 'Refurbished Tablets', 'Tablet', 'tablet', 'Samsung Galaxy Tabs · open-box · tested · warranty & GST invoice', 'phone', 3, 0, 'incl. 18% GST');
    cat = { slug: 'tablets' };
  }
  function tab(model, ram, store, conn, colour, size, price) {
    const sizePart = size ? ` (${size})` : '';
    return {
      name: `Refurbished Samsung Galaxy Tab ${model} ${ram}/${store} ${conn} — ${colour}${sizePart}`,
      storage: `${store}GB`,
      colour,
      specs: `${ram}GB RAM · ${store}GB · ${conn}${size ? ` · ${size}` : ''}`,
      price: price ? '₹' + Number(price).toLocaleString('en-IN') : '',
    };
  }
  const tabs = [
    tab('A11', '4', '64', 'Wi-Fi', 'Silver', '8.7"', 14000),
    tab('A11', '4', '64', 'Wi-Fi', 'Gray', '8.7"', 14000),
    tab('A11', '8', '128', 'Wi-Fi', 'Gray', '', 16000),
    tab('A11', '8', '128', 'Wi-Fi', 'Silver', '', 16000),
    tab('A9+', '8', '128', 'Wi-Fi', 'Navy', '', 16000),
    tab('A9+', '8', '128', 'Wi-Fi', 'Graphite', '', 16000),
    tab('A9+', '8', '128', '5G', 'Graphite', '11"', 19000),
    tab('A9+', '8', '128', '5G', 'Navy', '11"', 19000),
    tab('A9+', '8', '128', '5G', 'Silver', '11"', 19000),
    tab('S9 FE', '6', '128', 'Wi-Fi', 'Lavender', '10.9"', 24000),
    tab('S9 FE', '6', '128', 'Wi-Fi', 'Silver', '10.9"', 24000),
    tab('S9 FE', '6', '128', 'Wi-Fi', 'Mint', '10.9"', 24000),
    tab('S9 FE', '8', '256', 'Wi-Fi', 'Gray', '', 26000),
    tab('S9 FE', '8', '256', 'Wi-Fi', 'Lavender', '', 26000),
    tab('S10 Lite', '6', '128', '5G', 'Gray', '10.9"', 28000),
    tab('S9 FE+', '8', '128', 'Wi-Fi', 'Mint', '', 28000),
    tab('S9 FE+', '8', '128', 'Wi-Fi', 'Gray', '12.4"', 28000),
    tab('S9 FE+', '8', '128', 'Wi-Fi', 'Silver', '12.4"', 28000),
    tab('S10 FE+', '8', '128', 'Wi-Fi', 'Blue', '13.1"', 40000),
    tab('S9 FE+', '12', '256', 'Wi-Fi', 'Gray', '12.4"', null),
    tab('S9', '12', '256', '5G', 'Beige', '10.9"', 44000),
    tab('S9', '12', '256', '5G', 'Graphite', '10.9"', 44000),
    tab('A11+', '6', '128', '5G', 'Gray', '', 21000),
    tab('A11+', '6', '128', 'Wi-Fi', 'Gray', '', 19000),
    tab('A11+', '6', '128', 'Wi-Fi', 'Silver', '', 19000),
  ];
  const usedTabSlugs = new Set(db.prepare('SELECT slug FROM macbook_models').all().map((r) => r.slug).filter(Boolean));
  const insTab = db.prepare(`INSERT INTO macbook_models (name, category, slug, price, specs, badge, condition_grade, warranty, storage, colour, sort_order, active)
    VALUES (@name, @category, @slug, @price, @specs, @badge, @condition_grade, @warranty, @storage, @colour, @sort_order, @active)`);
  let so = 1;
  for (const t of tabs) {
    let base = slugifyModel(t.name), s = base, n = 2;
    while (usedTabSlugs.has(s)) s = base + '-' + n++;
    usedTabSlugs.add(s);
    insTab.run({ name: t.name, category: cat.slug, slug: s, price: t.price, specs: t.specs, badge: '', condition_grade: 'Open Box & Activated', warranty: '6-month warranty', storage: t.storage, colour: t.colour, sort_order: so++, active: 1 });
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TAB_FLAG, '1');
}

// One-time: switch already-seeded tablets to "Open Box & Activated" (only rows still on
// the original seeded grade — admin edits are left untouched).
const TAB_COND_FLAG = 'tablets_cond_activated_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(TAB_COND_FLAG)) {
  db.prepare("UPDATE macbook_models SET condition_grade = 'Open Box & Activated' WHERE category = 'tablets' AND condition_grade = 'Open Box & Non-activated'").run();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TAB_COND_FLAG, '1');
}

// One-time: hide the Tablets category until it's verified (enable it later from the admin),
// and mark tablet prices as GST-inclusive.
const TAB_HIDE_FLAG = 'tablets_hidden_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(TAB_HIDE_FLAG)) {
  db.prepare("UPDATE categories SET active = 0 WHERE slug = 'tablets'").run();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TAB_HIDE_FLAG, '1');
}
const TAB_PRICENOTE_FLAG = 'tablets_pricenote_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(TAB_PRICENOTE_FLAG)) {
  db.prepare("UPDATE categories SET price_note = 'incl. 18% GST' WHERE slug = 'tablets' AND (price_note IS NULL OR price_note = '')").run();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TAB_PRICENOTE_FLAG, '1');
}

// One-time: fill in Samsung tablet MRPs (official Samsung India list/launch prices, researched Jul 2026).
// Only fills rows whose MRP is still empty, so admin edits are preserved.
const TAB_MRP_FLAG = 'tablets_mrp_v2'; // v2: match by product slug only — the category slug is admin-editable (production uses 'refurbished-tablets').
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(TAB_MRP_FLAG)) {
  const mrps = [
    ['%tab-a11-464-wi-fi%', 12999],   // Tab A11 4/64 Wi-Fi
    ['%tab-a11-8128-wi-fi%', 17999],  // Tab A11 8/128 Wi-Fi
    ['%tab-a11-6128-wi-fi%', 22999],  // Tab A11+ 6/128 Wi-Fi
    ['%tab-a11-6128-5g%', 26999],     // Tab A11+ 6/128 5G
    ['%tab-a9-8128-wi-fi%', 20999],   // Tab A9+ 8/128 Wi-Fi
    ['%tab-a9-8128-5g%', 29999],      // Tab A9+ 8/128 5G
    ['%tab-s9-fe-6128-wi-fi%', 36999],  // Tab S9 FE 6/128 Wi-Fi
    ['%tab-s9-fe-8256-wi-fi%', 40999],  // Tab S9 FE 8/256 Wi-Fi
    ['%tab-s9-fe-8128-wi-fi%', 46999],  // Tab S9 FE+ 8/128 Wi-Fi
    ['%tab-s9-fe-12256-wi-fi%', 52999], // Tab S9 FE+ 12/256 Wi-Fi
    ['%tab-s10-lite-6128-5g%', 35999],  // Tab S10 Lite 6/128 5G
    ['%tab-s10-fe-8128-wi-fi%', 52999], // Tab S10 FE+ 8/128 Wi-Fi
    ['%tab-s9-12256-5g%', 96999],       // Tab S9 12/256 5G
  ];
  const upd = db.prepare("UPDATE macbook_models SET mrp = ? WHERE slug LIKE ? AND (mrp IS NULL OR mrp = '')");
  for (const [pat, v] of mrps) upd.run('₹' + Number(v).toLocaleString('en-IN'), pat);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TAB_MRP_FLAG, '1');
}

// One-time: keep phones & tablets off the homepage (their category pages stay live).
// Re-enable any time from the admin: Categories → edit → "Show on homepage?".
const HOME_CATS_FLAG = 'home_cats_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(HOME_CATS_FLAG)) {
  db.prepare("UPDATE categories SET show_home = 0 WHERE url_prefix IN ('phone', 'tablet')").run();
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(HOME_CATS_FLAG, '1');
}

// One-time: add the ₹ symbol + Indian grouping to existing bare-number prices
// ("14000" -> "₹14,000") across price, MRP and condition-based variations.
const RUPEE_FLAG = 'prices_rupee_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(RUPEE_FLAG)) {
  const norm = (s) => {
    const t = String(s || '').trim();
    if (!t || t.includes('₹')) return t;
    const numeric = t.replace(/(?:rs\.?|inr)/i, '').replace(/[,\s]/g, '');
    if (/^\d+(\.\d+)?$/.test(numeric)) return '₹' + Number(numeric).toLocaleString('en-IN');
    return t;
  };
  const rows = db.prepare('SELECT id, price, mrp, condition_prices FROM macbook_models').all();
  const upd = db.prepare('UPDATE macbook_models SET price = ?, mrp = ?, condition_prices = ? WHERE id = ?');
  for (const r of rows) {
    let cp = r.condition_prices || '';
    try {
      const v = JSON.parse(cp || '[]');
      if (Array.isArray(v) && v.length) cp = JSON.stringify(v.map((x) => ({ ...x, price: norm(x.price), mrp: norm(x.mrp) })));
    } catch { /* leave as-is */ }
    const np = norm(r.price), nm = norm(r.mrp);
    if (np !== (r.price || '') || nm !== (r.mrp || '') || cp !== (r.condition_prices || '')) upd.run(np, nm, cp, r.id);
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(RUPEE_FLAG, '1');
}

// One-time: append a DPDP Act, 2023 rights section to the Privacy Policy page
// (skipped if the page already mentions the DPDP Act — admin edits are preserved).
const DPDP_FLAG = 'privacy_dpdp_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(DPDP_FLAG)) {
  const page = db.prepare("SELECT slug, content FROM content_pages WHERE slug = 'privacy-policy'").get();
  if (page && !/DPDP/i.test(page.content || '')) {
    const dpdp = `
<h2>Your rights under the Digital Personal Data Protection Act, 2023 (DPDP Act)</h2>
<p>We process the personal data you provide on this site — such as your name, phone number, email address and enquiry details — solely to respond to your enquiry, arrange consultations, process reservations and provide related support. We process this data on the basis of the <strong>consent</strong> you give via the consent checkbox on our forms, and we keep a record of when that consent was given.</p>
<ul>
<li><strong>Withdraw consent:</strong> you may withdraw your consent at any time by contacting us using the details below. After withdrawal we will stop processing your data and delete it, unless a law requires us to retain it.</li>
<li><strong>Access &amp; correction:</strong> you may ask for a summary of the personal data we hold about you and have inaccuracies corrected or incomplete data updated.</li>
<li><strong>Erasure:</strong> you may ask us to delete your personal data once it is no longer needed for the purpose it was collected for.</li>
<li><strong>Grievance redressal:</strong> concerns are handled by our Grievance Officer (contact details on this page and the Grievance Redressal page). We acknowledge and resolve grievances within the timelines prescribed under the DPDP Act.</li>
<li><strong>Escalation:</strong> if you are not satisfied with our response, you may complain to the Data Protection Board of India.</li>
<li><strong>Nomination:</strong> you may nominate another individual to exercise these rights on your behalf in case of death or incapacity.</li>
</ul>
<p>We collect only the data needed for the purposes above, retain it only as long as necessary, never sell personal data, and restrict access to authorised staff. Data is stored on secure servers and requests for access, correction or erasure are honoured free of charge.</p>`;
    db.prepare("UPDATE content_pages SET content = content || ?, updated_at = datetime('now') WHERE slug = ?").run(dpdp, page.slug);
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DPDP_FLAG, '1');
}

// One-time: seed the "How it works" steps into existing installs (settings rows are
// only inserted on first run, so upgrades need this).
const HOW_FLAG = 'how_steps_v1';
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get(HOW_FLAG)) {
  const put = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  put.run('how_enabled', '1');
  put.run('how_title', 'How it works');
  put.run('how_steps', JSON.stringify([
    { title: 'Schedule a video call', note: 'See the exact device live on a video call and verify its condition before you commit.' },
    { title: 'Reserve the device', note: 'Book it with a small reservation amount — adjusted in your final invoice.' },
    { title: 'Open-box delivery', note: 'Delivered open-box to your doorstep (prepaid), or collect it from our office.' },
  ]));
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(HOW_FLAG, '1');
}

module.exports = db;
