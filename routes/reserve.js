// Reserve / booking payment via PayU (hosted checkout).
// All code moved verbatim from server.js.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { getSetting } = require('../lib/settings');
const { esc, digits, baseUrl } = require('../lib/util');
const { pageHead, pageTail, siteHeaderHtml } = require('../lib/render');

const router = express.Router();

// ---------------------------------------------------------------------------
// Reserve / booking payment via PayU (hosted checkout)
// ---------------------------------------------------------------------------

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

router.get('/reserve', (req, res) => {
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

router.post('/api/reserve/initiate', (req, res) => {
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
router.post('/reserve/success', (req, res) => {
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
router.post('/reserve/failure', (req, res) => {
  res.send(reservePage(req, 'Payment not completed', `<div class="reserve-result fail">
    <h1>Payment not completed</h1>
    <p>Your payment was not completed${req.body.txnid ? ` (Txn ID: <strong>${esc(String(req.body.txnid))}</strong>)` : ''}. No amount has been reserved. You can try again or book a free video call instead.</p>
    <a class="pdp-book" href="/#lead-form">Book a video call</a>
  </div>`));
});

module.exports = router;
