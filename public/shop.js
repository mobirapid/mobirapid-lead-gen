// Mobirapid shop: cart (localStorage), mobile+OTP login, cart/checkout/orders pages.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  const CART_KEY = 'mobirapid_cart';

  const cart = {
    read() { try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch { return []; } },
    write(items) { localStorage.setItem(CART_KEY, JSON.stringify(items)); updateBadge(); },
    count() { return this.read().reduce((n, i) => n + (i.qty || 1), 0); },
    add(item) {
      const items = this.read();
      const key = (x) => x.slug + '|' + (x.grade || '');
      const ex = items.find((x) => key(x) === key(item));
      if (ex) ex.qty = Math.min(10, (ex.qty || 1) + (item.qty || 1));
      else items.push({ slug: item.slug, grade: item.grade || '', qty: item.qty || 1 });
      this.write(items);
    },
    setQty(slug, grade, qty) {
      const items = this.read().map((x) => (x.slug === slug && (x.grade || '') === (grade || '')) ? { ...x, qty } : x).filter((x) => x.qty > 0);
      this.write(items);
    },
    remove(slug, grade) { this.write(this.read().filter((x) => !(x.slug === slug && (x.grade || '') === (grade || '')))); },
    clear() { this.write([]); },
  };
  window.MobiCart = cart;

  function updateBadge() {
    const b = $('cartBadge'); if (!b) return;
    const n = cart.count();
    b.textContent = n; b.hidden = n === 0;
  }

  // ---- Add-to-cart wiring on product cards / PDP (buttons carry data-add / data-buy) ----
  function toast(msg) {
    let t = $('mobiToast');
    if (!t) { t = document.createElement('div'); t.id = 'mobiToast'; t.className = 'mobi-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
  }
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add-cart]');
    const buy = e.target.closest('[data-buy-now]');
    const el = add || buy;
    if (!el) return;
    e.preventDefault();
    // Read the currently selected condition on a product page, if present.
    let grade = el.getAttribute('data-grade') || '';
    const sel = document.querySelector('.pdp-cond-opt.on');
    if (sel && el.getAttribute('data-pdp') === '1') grade = sel.getAttribute('data-grade') || '';
    cart.add({ slug: el.getAttribute('data-slug'), grade, qty: 1 });
    if (buy) location.href = '/cart';
    else toast('Added to cart');
  });

  // ---- Auth ----
  let me = { loggedIn: false, customer: null, shop_enabled: false };
  async function loadMe() {
    try { me = await (await fetch('/api/customer/me')).json(); } catch {}
    document.body.classList.toggle('logged-in', !!me.loggedIn);
    const acc = $('accountLink');
    if (acc) acc.textContent = me.loggedIn ? (me.customer.name || 'My account') : 'Login';
    return me;
  }

  // Login modal (mobile + OTP)
  function openLogin(afterLogin) {
    let m = $('loginModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'loginModal'; m.className = 'mobi-modal';
      m.innerHTML = `<div class="mobi-modal-card">
        <button class="mobi-modal-x" aria-label="Close">✕</button>
        <h3>Login / Sign up</h3>
        <p class="muted">We'll send a one-time code to your mobile number.</p>
        <div class="field"><label>Mobile number</label>
          <div class="phone-row"><input type="tel" id="lgPhone" placeholder="+91 98765 43210" /><button class="otp-btn" id="lgSend">Send code</button></div>
        </div>
        <div class="field" id="lgOtpWrap" hidden><label>Enter 6-digit code</label>
          <div class="phone-row"><input type="text" id="lgOtp" inputmode="numeric" maxlength="6" placeholder="123456" /><button class="otp-btn" id="lgVerify">Verify</button></div>
        </div>
        <div class="field" id="lgNameWrap" hidden><label>Your name</label><input type="text" id="lgName" placeholder="e.g. Sachin Sharma" /></div>
        <p class="form-status" id="lgStatus"></p>
      </div>`;
      document.body.appendChild(m);
      m.querySelector('.mobi-modal-x').addEventListener('click', () => m.classList.remove('open'));
      m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
      const st = (msg, kind) => { $('lgStatus').textContent = msg || ''; $('lgStatus').className = 'form-status' + (kind ? ' ' + kind : ''); };
      $('lgSend').addEventListener('click', async () => {
        const phone = $('lgPhone').value.trim();
        if (!phone) return st('Enter your mobile number.', 'err');
        $('lgSend').disabled = true;
        try {
          const d = await (await fetch('/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) })).json();
          if (!d.ok) throw new Error(d.error);
          $('lgOtpWrap').hidden = false; st(d.mock ? 'Demo mode: code is in the server console.' : 'Code sent.', 'ok');
        } catch (e) { st(e.message || 'Could not send code.', 'err'); } finally { $('lgSend').disabled = false; }
      });
      $('lgVerify').addEventListener('click', async () => {
        const phone = $('lgPhone').value.trim(), code = $('lgOtp').value.trim();
        try {
          const v = await (await fetch('/api/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code }) })).json();
          if (!v.ok) throw new Error(v.error);
          const name = $('lgName') ? $('lgName').value.trim() : '';
          const l = await (await fetch('/api/customer/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, name }) })).json();
          if (!l.ok) throw new Error(l.error);
          m.classList.remove('open');
          await loadMe();
          if (typeof afterLogin === 'function') afterLogin();
        } catch (e) {
          if (/verify your phone/i.test(e.message || '')) { $('lgNameWrap').hidden = false; st('Almost there — add your name and tap Verify again.', ''); }
          else st(e.message || 'Could not verify.', 'err');
        }
      });
    }
    m.classList.add('open');
    $('lgPhone').focus();
  }
  window.MobiLogin = openLogin;

  // ---- Page renderers ----
  async function priceCart() {
    const items = cart.read();
    if (!items.length) return { items: [], subtotal: 0 };
    try { return await (await fetch('/api/cart/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })).json(); }
    catch { return { items: [], subtotal: 0 }; }
  }

  async function renderCartPage() {
    const wrap = $('cartPage'); if (!wrap) return;
    const { items, subtotal } = await priceCart();
    if (!items.length) {
      wrap.innerHTML = `<div class="shop-empty"><h2>Your cart is empty</h2><p class="muted">Browse our refurbished devices and add something you like.</p><a class="pdp-book" href="/#modelsSection">Shop devices →</a></div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="cart-lines">${items.map((i) => `
        <div class="cart-line">
          <div class="cart-thumb">${i.image ? `<img src="${esc(i.image)}" alt="">` : ''}</div>
          <div class="cart-mid"><b>${esc(i.name)}</b><span>${inr(i.price)}</span></div>
          <div class="cart-qty">
            <button data-q="dec" data-slug="${esc(i.slug)}" data-grade="${esc(i.grade || '')}">−</button>
            <span>${i.qty}</span>
            <button data-q="inc" data-slug="${esc(i.slug)}" data-grade="${esc(i.grade || '')}">+</button>
          </div>
          <div class="cart-line-total">${inr(i.line)}</div>
          <button class="cart-rm" data-rm data-slug="${esc(i.slug)}" data-grade="${esc(i.grade || '')}" aria-label="Remove">✕</button>
        </div>`).join('')}</div>
      <div class="cart-summary">
        <div class="cart-sum-row"><span>Subtotal</span><b>${inr(subtotal)}</b></div>
        <p class="muted">Taxes and delivery shown at checkout.</p>
        <a class="pdp-book cart-checkout" href="/checkout">Proceed to checkout →</a>
      </div>`;
    wrap.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      const it = cart.read().find((x) => x.slug === b.dataset.slug && (x.grade || '') === (b.dataset.grade || ''));
      const q = (it ? it.qty : 1) + (b.dataset.q === 'inc' ? 1 : -1);
      cart.setQty(b.dataset.slug, b.dataset.grade, q); renderCartPage();
    }));
    wrap.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { cart.remove(b.dataset.slug, b.dataset.grade); renderCartPage(); }));
  }

  async function renderCheckout() {
    const wrap = $('checkoutPage'); if (!wrap) return;
    if (!me.loggedIn) {
      wrap.innerHTML = `<div class="shop-empty"><h2>Please log in to checkout</h2><p class="muted">We use your mobile number to secure your order.</p><button class="pdp-book" id="coLogin">Login with mobile</button></div>`;
      $('coLogin').addEventListener('click', () => openLogin(renderCheckout));
      return;
    }
    const { items, subtotal } = await priceCart();
    if (!items.length) { wrap.innerHTML = `<div class="shop-empty"><h2>Your cart is empty</h2><a class="pdp-book" href="/#modelsSection">Shop devices →</a></div>`; return; }
    let saved = [];
    try { saved = (await (await fetch('/api/customer/addresses')).json()).addresses || []; } catch {}
    const d = saved.find((a) => a.is_default) || saved[0] || {};
    const reserveAmt = window.MOBI_RESERVE || 1999;
    const prepaidPct = window.MOBI_PREPAID_PCT || 0;
    const prepaidDisc = Math.round(subtotal * prepaidPct / 100);
    const fullPay = subtotal - prepaidDisc;
    wrap.innerHTML = `
      <div class="checkout-grid">
        <div class="checkout-main">
          <section class="pdp-card">
            <h2>Delivery address</h2>
            <div class="grid2">
              <div class="field"><label>Full name</label><input id="ad-name" value="${esc(d.name || me.customer.name || '')}"></div>
              <div class="field"><label>Phone</label><input id="ad-phone" value="${esc(d.phone || me.customer.phone || '')}"></div>
            </div>
            <div class="field"><label>Address line 1</label><input id="ad-line1" value="${esc(d.line1 || '')}"></div>
            <div class="field"><label>Address line 2 (optional)</label><input id="ad-line2" value="${esc(d.line2 || '')}"></div>
            <div class="grid3">
              <div class="field"><label>City</label><input id="ad-city" value="${esc(d.city || '')}"></div>
              <div class="field"><label>State</label><input id="ad-state" value="${esc(d.state || '')}"></div>
              <div class="field"><label>PIN code</label><input id="ad-pincode" inputmode="numeric" maxlength="6" value="${esc(d.pincode || '')}"></div>
            </div>
          </section>
          <section class="pdp-card">
            <h2>Payment</h2>
            <div class="pay-note"><b>Prepaid order — pay securely online.</b>${prepaidPct ? ` You save <b>${prepaidPct}%</b> by paying online.` : ''} Your device is dispatched after payment.</div>
            <p class="muted" style="margin:10px 0 0;">Prefer to inspect before paying? Use <b>Book with ₹X</b> on any product page for open-box delivery.</p>
          </section>
        </div>
        <aside class="checkout-side">
          <div class="pdp-card">
            <h2>Order summary</h2>
            ${items.map((i) => `<div class="co-line"><span>${i.qty}× ${esc(i.name)}</span><b>${inr(i.line)}</b></div>`).join('')}
            <div class="co-line"><span>Subtotal</span><b>${inr(subtotal)}</b></div>
            ${prepaidDisc > 0 ? `<div class="co-line co-disc"><span>Prepaid discount (${prepaidPct}%)</span><b>− ${inr(prepaidDisc)}</b></div>` : ''}
            <div class="co-line co-total"><span>Total payable</span><b>${inr(fullPay)}</b></div>
            <button class="pdp-book co-place" id="placeOrder">Pay ${inr(fullPay)} &amp; place order →</button>
            <p class="form-status" id="coStatus"></p>
          </div>
        </aside>
      </div>`;
    $('placeOrder').addEventListener('click', placeOrder);
  }

  async function placeOrder() {
    const st = (m, k) => { $('coStatus').textContent = m || ''; $('coStatus').className = 'form-status' + (k ? ' ' + k : ''); };
    const address = { name: $('ad-name').value.trim(), phone: $('ad-phone').value.trim(), line1: $('ad-line1').value.trim(), line2: $('ad-line2').value.trim(), city: $('ad-city').value.trim(), state: $('ad-state').value.trim(), pincode: $('ad-pincode').value.trim() };
    const payment_mode = 'full'; // cart checkout is prepaid-only; open-box is via "Book with ₹X"
    $('placeOrder').disabled = true; $('placeOrder').textContent = 'Placing…'; st('');
    try {
      const r = await fetch('/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: cart.read(), address, payment_mode }) });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      cart.clear();
      if (d.pay_online && d.pay_amount > 0) { location.href = '/pay/' + encodeURIComponent(d.order_no); return; }
      location.href = '/order/' + encodeURIComponent(d.order_no);
    } catch (e) { st(e.message || 'Could not place the order.', 'err'); $('placeOrder').disabled = false; $('placeOrder').textContent = 'Place order'; }
  }

  async function renderOrders() {
    const wrap = $('ordersPage'); if (!wrap) return;
    if (!me.loggedIn) { wrap.innerHTML = `<div class="shop-empty"><h2>Please log in</h2><button class="pdp-book" id="orLogin">Login with mobile</button></div>`; $('orLogin').addEventListener('click', () => openLogin(renderOrders)); return; }
    let orders = [];
    try { orders = (await (await fetch('/api/customer/orders')).json()).orders || []; } catch {}
    if (!orders.length) { wrap.innerHTML = `<div class="shop-empty"><h2>No orders yet</h2><a class="pdp-book" href="/#modelsSection">Shop devices →</a></div>`; return; }
    wrap.innerHTML = orders.map((o) => `
      <div class="order-card">
        <div class="order-head"><b>#${esc(o.order_no)}</b><span class="order-status s-${esc(String(o.status || '').toLowerCase())}">${esc(o.status)}</span></div>
        <div class="order-items">${(o.items || []).map((i) => `${i.qty}× ${esc(i.name)}`).join(' · ')}</div>
        <div class="order-foot"><span>${esc((o.created_at || '').slice(0, 10))}</span><b>${inr(o.total)}</b><span class="order-pay">${esc(payLabel(o))}</span></div>
      </div>`).join('');
  }
  function payLabel(o) {
    if (o.payment_status === 'paid') return 'Paid';
    if (o.payment_mode === 'openbox') return 'Pay at delivery';
    if (o.payment_mode === 'reserve') return 'Reserve pending';
    return 'Payment pending';
  }

  // ---- Account page (logout + orders link) ----
  function wireAccount() {
    const lo = $('logoutBtn');
    if (lo) lo.addEventListener('click', async () => { await fetch('/api/customer/logout', { method: 'POST' }); location.href = '/'; });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    updateBadge();
    await loadMe();
    renderCartPage();
    renderCheckout();
    renderOrders();
    wireAccount();
    const al = $('accountLink');
    if (al) al.addEventListener('click', (e) => { if (!me.loggedIn) { e.preventDefault(); openLogin(() => location.href = '/account'); } });
  });
})();
