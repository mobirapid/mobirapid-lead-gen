// Partner application form: OTP verification + submit.
(function () {
  const $ = (id) => document.getElementById(id);
  const form = $('partnerForm');
  if (!form) return;
  const phone = $('p-phone');
  const sendBtn = $('p-sendOtp');
  const otpField = $('p-otpField');
  const otpInput = $('p-otp');
  const verifyBtn = $('p-verifyOtp');
  const otpHint = $('p-otpHint');
  const submitBtn = $('p-submit');
  const status = $('p-status');
  let verified = false;

  const setStatus = (msg, kind) => { status.textContent = msg; status.className = 'form-status' + (kind ? ' ' + kind : ''); };
  const clean = (v) => String(v || '').trim();

  sendBtn.addEventListener('click', async () => {
    if (!clean(phone.value)) { setStatus('Please enter your phone number.', 'err'); return; }
    sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone.value }) });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'Could not send the code.');
      otpField.hidden = false;
      otpHint.textContent = d.mock ? 'Demo mode: the code is printed in the server console.' : 'Code sent. It expires in a few minutes.';
      otpInput.focus();
      setStatus('', '');
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      sendBtn.disabled = false; sendBtn.textContent = 'Send code';
    }
  });

  verifyBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true; verifyBtn.textContent = 'Verifying…';
    try {
      const r = await fetch('/api/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: phone.value, code: otpInput.value }) });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'That code did not match.');
      verified = true;
      submitBtn.disabled = false;
      otpHint.textContent = 'Phone verified ✓';
      phone.readOnly = true;
      setStatus('', '');
    } catch (e) {
      setStatus(e.message, 'err');
    } finally {
      verifyBtn.disabled = false; verifyBtn.textContent = 'Verify';
    }
  });

  // Re-verification is required if the number changes.
  phone.addEventListener('input', () => { verified = false; submitBtn.disabled = true; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!verified) { setStatus('Please verify your phone number first.', 'err'); return; }
    if (!clean($('p-name').value)) { setStatus('Please enter your name.', 'err'); return; }
    if (!clean($('p-city').value)) { setStatus('Please enter your city.', 'err'); return; }
    if (!$('p-consent').checked) { setStatus('Please tick the consent box so we can process your application.', 'err'); $('p-consent').focus(); return; }

    submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; setStatus('', '');
    try {
      const r = await fetch('/api/partner', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('p-name').value, phone: phone.value, city: $('p-city').value,
          message: $('p-message').value, consent: $('p-consent').checked,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'Something went wrong.');
      form.reset(); otpField.hidden = true; verified = false; phone.readOnly = false;
      setStatus(d.message, 'ok');
      submitBtn.textContent = 'Application received ✓';
      try { if (window.gtag) window.gtag('event', 'generate_lead', { event_category: 'partner' }); } catch (err) {}
    } catch (e) {
      setStatus(e.message, 'err');
      submitBtn.disabled = false; submitBtn.textContent = 'Submit application';
    }
  });
})();
