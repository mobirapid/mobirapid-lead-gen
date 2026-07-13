// Settings storage, dynamic config (DB -> env -> default) and the live
// Google rating cache. All code moved verbatim from server.js.
const db = require('../db');

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

// Accessor for the shared mutable cache (refreshGoogleRating reassigns gCache,
// so consumers must read it through this function instead of importing the object).
function getGCache() { return gCache; }

module.exports = {
  PRIVATE_KEYS,
  getSetting, setSetting, getAllSettings, parseJsonSetting,
  cfg, otpProvider, otpTtlMinutes, leadNotifyTo,
  G_TTL, refreshGoogleRating, googleLiveEnabled, getGCache,
};
