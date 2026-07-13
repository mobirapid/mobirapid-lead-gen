// Outbound notifications: lead email (SMTP), OTP SMS providers and the
// Meta (Facebook) Conversions API. All code moved verbatim from server.js.
const nodemailer = require('nodemailer');
const { getSetting, cfg, otpProvider, otpTtlMinutes, leadNotifyTo } = require('./settings');
const { sha256, baseUrl } = require('./util');

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
// Meta (Facebook) Conversions API — server-side "Lead" event.
// ---------------------------------------------------------------------------

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

module.exports = { buildTransporter, sendLeadEmail, sendSms, sendMetaCapiLead };
