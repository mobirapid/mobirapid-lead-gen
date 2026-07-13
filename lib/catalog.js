// Product & category helpers shared by the public pages.
// All code moved verbatim from server.js.
const db = require('../db');
const { getSetting } = require('./settings');
const { esc } = require('./util');

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

module.exports = {
  catByPrefix, catBySlug, catForProduct, productUrl,
  reserveButton, isSoldOut, discountInfo, discountHtml,
  availabilityButton, gradeBadgeClass,
};
