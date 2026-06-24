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

// --- Seed default settings (only inserts missing keys) ---
const DEFAULT_SETTINGS = {
  brand_name: 'Mobirapid',
  logo_path: '',
  header_cta_text: 'Book Consultation',
  cta_text: 'Schedule call now',
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

module.exports = db;
