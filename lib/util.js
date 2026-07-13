// Small pure helpers, asset versioning and the canonical base URL.
// All code moved verbatim from server.js.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getSetting } = require('./settings');

// Cache-busting version for CSS/JS (changes whenever those files change on deploy).
const ASSET_VER = (() => {
  try {
    const parts = ['styles.css', 'app.js', 'icons.js', 'admin.js'].map((f) => {
      try { return fs.statSync(path.join(__dirname, '..', 'public', f)).mtimeMs; } catch { return 0; }
    });
    return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 8);
  } catch { return String(Date.now()); }
})();
function ver(p) { return p + (p.includes('?') ? '&' : '?') + 'v=' + ASSET_VER; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePhone(p) {
  if (!p) return '';
  const trimmed = String(p).trim().replace(/[\s\-()]/g, '');
  if (/^\+?\d{8,15}$/.test(trimmed)) return trimmed.startsWith('+') ? trimmed : '+' + trimmed;
  return '';
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }
function genOtp() { return ('' + crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

function digits(v) { return parseInt(String(v || '').replace(/[^\d]/g, ''), 10) || 0; }

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'post';
}

function baseUrl(req) {
  // Prefer the configured canonical site URL so canonical/OG/sitemap are consistent
  // across domains (e.g. .in and .com) — avoids duplicate-content issues.
  const configured = getSetting('site_url', '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.secure ? 'https' : 'http';
  return `${proto}://${req.headers.host || 'mobirapid.in'}`;
}

module.exports = { ASSET_VER, ver, esc, slugify, normalizePhone, isEmail, genOtp, sha256, digits, baseUrl };
