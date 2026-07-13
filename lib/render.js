// Shared server-side HTML rendering: homepage template, page shell (head/tail),
// site header/footer and JSON-LD builders. All code moved verbatim from server.js.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { getSetting, googleLiveEnabled, getGCache } = require('./settings');
const { esc, ver, baseUrl } = require('./util');
const { isSoldOut } = require('./catalog');

const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');
let indexTemplate = null;

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
    const gCache = getGCache();
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

module.exports = {
  FONT_HREF, HEAD_COMMON, renderIndex, buildJsonLd,
  siteHeaderHtml, siteFooterHtml, pageHead, pageTail, businessDetailsHtml,
};
