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
ensureColumn('macbook_models', 'slug', 'TEXT');

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
  // SEO + Analytics (injected into the page <head>/<body> from the server)
  site_url: '',
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
  legal_name: 'Mobirapid',
  gstin: '',
  registered_address: '',
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
<p>We share data only with service providers who help us operate (e.g. SMS/email delivery, logistics) and where required by applicable law or a lawful authority.</p>
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
<h3>Intellectual property &amp; trademark disclaimer</h3>
<p>Apple, MacBook, MacBook Air and MacBook Pro are trademarks of Apple Inc., registered in the U.S. and other countries. Mobirapid is an independent reseller and is not affiliated with, authorised, sponsored or endorsed by Apple Inc.</p>
<h3>Governing law &amp; jurisdiction</h3>
<p>These terms are governed by Indian law and subject to the exclusive jurisdiction of the courts at our registered place of business.</p>`,
  },
  {
    slug: 'refund-policy',
    title: 'Refund / Return Policy',
    sort_order: 3,
    content: `${reviewNote}
<h3>Returns</h3>
<p>If a device is dead-on-arrival or does not match the agreed specification or condition, you may raise a return request within the return window communicated at the time of purchase. The device must be returned with all original accessories, packaging and the invoice.</p>
<h3>Refunds</h3>
<p>Approved refunds are processed to the original payment method within the timeline communicated at purchase (typically a few business days after the returned device passes inspection), in line with the Consumer Protection (E-Commerce) Rules, 2020.</p>
<h3>Non-returnable cases</h3>
<p>Returns are not accepted for physical/liquid damage caused after delivery, unauthorised repair, or missing accessories, except where required by law.</p>
<h3>How to claim</h3>
<p>To start a return or refund, contact our customer care (details in the footer) with your order number and reason. You may also escalate to our Grievance Officer.</p>`,
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
<p>We deliver across serviceable locations in India through reputed courier and logistics partners. Estimated delivery timelines are shared at the time of order confirmation.</p>
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
];

const insPage = db.prepare('INSERT INTO content_pages (slug, title, content, sort_order) VALUES (?, ?, ?, ?)');
const getPage = db.prepare('SELECT content FROM content_pages WHERE slug = ?');
const updPage = db.prepare("UPDATE content_pages SET title = ?, content = ?, sort_order = ?, updated_at = datetime('now') WHERE slug = ?");
for (const p of DEFAULT_PAGES) {
  const existing = getPage.get(p.slug);
  if (!existing) {
    insPage.run(p.slug, p.title, p.content, p.sort_order);
  } else if (existing.content && existing.content.indexOf(OLD_MARKER) !== -1) {
    // Page still has the old unedited template — safe to refresh with the India version.
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

module.exports = db;
