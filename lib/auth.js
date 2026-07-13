// Admin authentication: session tokens, password hashing, role middleware and
// the /api/admin role gate. All code moved verbatim from server.js.
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// ===========================================================================
// ADMIN AUTH  (roles: "admin" = full access, "leads" = leads only)
// ===========================================================================

function signToken(user, role, scope) {
  const payload = Buffer.from(JSON.stringify({ user, role, scope: scope || null, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [salt, h] = String(stored).split(':');
    const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(test, 'hex'));
  } catch { return false; }
}
// Authenticate the request and return the token payload, or null.
function authOf(req) { return verifyToken(req.cookies.admin_session); }

function requireAdmin(req, res, next) {
  const data = authOf(req);
  if (!data) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
    return res.redirect('/manage/login');
  }
  req.authUser = data;
  next();
}
// Lead-only staff can view leads but not modify/delete them.
function requireFullRole(req, res, next) {
  const role = (req.authUser && req.authUser.role) || 'admin';
  if (role !== 'admin') return res.status(403).json({ ok: false, error: 'You can view leads but not modify them.' });
  next();
}

// Gate for all /api/admin/* routes: any logged-in user may use the leads (and /me)
// endpoints; everything else requires the full "admin" role.
function adminApiGate(req, res, next) {
  const data = authOf(req);
  if (!data) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  req.authUser = data;
  // Tokens issued before roles existed have no role — treat them as full admin
  // (only the .env admin could have logged in back then).
  const role = data.role || 'admin';
  if (role === 'admin') return next();
  // Staff users can hold multiple roles (stored as a comma-separated list, e.g. "leads,catalog").
  const roles = String(role).split(',').map((s) => s.trim()).filter(Boolean);
  const leadsOk = req.path === '/me' || req.path.startsWith('/leads');
  // Category uploader ('catalog') may manage products + upload images + read categories.
  const catalogOk = req.path === '/me' || req.path.startsWith('/models') || req.path === '/upload' || req.path === '/categories';
  if (roles.includes('leads') && leadsOk) return next();
  if (roles.includes('catalog') && catalogOk) return next();
  return res.status(403).json({ ok: false, error: 'You do not have access to this section.' });
}

function userScope(req) {
  const role = String((req.authUser && req.authUser.role) || '');
  if (!role || role === 'admin') return null;
  // A blank scope on a catalog user means "all categories" (unrestricted).
  return role.split(',').includes('catalog') ? (req.authUser.scope || null) : null;
}

module.exports = {
  ADMIN_USER, ADMIN_PASSWORD, SESSION_SECRET,
  signToken, verifyToken, hashPassword, verifyPassword,
  authOf, requireAdmin, requireFullRole, adminApiGate, userScope,
};
