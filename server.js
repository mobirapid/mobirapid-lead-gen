require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const morgan = require('morgan');
require('./db'); // opens SQLite, runs migrations + seeds, logs which driver is in use

const { getSetting } = require('./lib/settings');
const { otpProvider, leadNotifyTo } = require('./lib/settings');
const { baseUrl } = require('./lib/util');
const { pageHead, pageTail, siteHeaderHtml } = require('./lib/render');
const { buildTransporter } = require('./lib/notify');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind LiteSpeed/Passenger (cPanel), Node sits behind a reverse proxy.
// Trust it so Express reads the real client IP and protocol from X-Forwarded-* headers.
app.set('trust proxy', 1);

// Force HTTPS — only when actually proxied over http (skips local dev, which has no proxy header).
app.use((req, res, next) => {
  const xfp = req.headers['x-forwarded-proto'];
  if (xfp && xfp !== 'https' && !req.secure) {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// Security headers
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request logging: method, url, status and response time. Static asset and
// /uploads hits are skipped to keep the logs readable.
app.use(morgan(':method :url :status :response-time ms', {
  skip: (req) => req.path.startsWith('/uploads') ||
    /\.(?:css|js|mjs|map|jpg|jpeg|png|webp|gif|svg|ico|woff2?|ttf)$/i.test(req.path),
}));

// Long-lived caching for static assets. Uploaded images have unique filenames and
// CSS/JS are cache-busted with ?v=ASSET_VER, so everything is safe to cache for a year.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(?:jpg|jpeg|png|webp|gif|svg|ico|woff2?|ttf)$/i.test(filePath) || /[\\/]uploads[\\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.(?:css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ---------------------------------------------------------------------------
// Routes. Mount order mirrors the original single-file registration order —
// routes/public.js contains the generic GET /:prefix/:slug product route,
// which calls next() for unknown prefixes so later routers still match.
// ---------------------------------------------------------------------------
app.use(require('./routes/public'));
app.use(require('./routes/reserve'));
app.use(require('./routes/leads'));
app.use(require('./routes/admin'));

// Branded 404 (noindex) — catch-all for anything not matched above.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found.' });
  const brand = getSetting('brand_name', 'Mobirapid');
  res.status(404).send(
    pageHead(req, 'Page not found — ' + brand, 'The page you are looking for could not be found.', baseUrl(req) + req.originalUrl, '<meta name="robots" content="noindex">') +
    siteHeaderHtml() +
    `<main class="container page-body" style="text-align:center;padding:80px 20px;">
      <h1 style="font-size:3rem;">404</h1>
      <p style="color:var(--muted);font-size:1.1rem;">Sorry, that page could not be found.</p>
      <p style="margin-top:24px;"><a class="hero-button" href="/" style="background:var(--brand);color:#fff;">← Back to home</a> &nbsp; <a class="hero-button" href="/blog" style="background:#fff;border:1px solid var(--line);">Read the blog</a></p>
    </main>` +
    pageTail()
  );
});

// Central error handler — must be the last middleware. Logs the failure with
// timestamp/method/path and hides internals from the response. Unknown /api/
// paths already get a JSON 404 from the catch-all above.
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ERROR ${req.method} ${req.path}\n${(err && err.stack) || err}`);
  if (res.headersSent) return next(err);
  const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (req.path.startsWith('/api/')) return res.status(status).json({ ok: false, error: 'Internal error' });
  res.status(status).type('html').send('Internal server error. Please try again shortly.');
});

app.listen(PORT, () => {
  console.log(`[boot] server.js · Node ${process.version} · PID ${process.pid} · port ${PORT}`);
  console.log(`\nMobirapid lead-gen running:  http://localhost:${PORT}`);
  console.log(`Admin panel:                 http://localhost:${PORT}/manage`);
  const prov = otpProvider();
  console.log(`OTP provider: ${prov}${prov === 'mock' ? '  (codes printed to this console)' : ''}`);
  console.log(`Lead emails -> ${leadNotifyTo()}${buildTransporter() ? '' : '  (SMTP not set: emails printed to console)'}`);
  console.log(`Configure SMS/email from the admin → "SMS & Email" tab.\n`);
});
