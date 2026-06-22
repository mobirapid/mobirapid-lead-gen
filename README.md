# Mobirapid — Lead Generation Landing Page + Admin CMS

A clean, conversion-style landing page for Mobirapid (refurbished MacBooks + consultation),
with a full **admin panel** that controls almost everything on the page — no code edits needed.

Visitors fill the form, **verify their phone by SMS OTP**, and book a consultation by **date & time**.
Every lead is **saved to a database** and **emailed** to your team.

## What the visitor sees

- Full-bleed hero (banner image + headline + trust points) — *editable from admin*
- **USP strip** ("Why buy from us") — GST invoice + serial, 35+ checkpoint QC, 6-month warranty,
  open box delivery, credit-card payment, buyback & exchange — *each item's text, built-in icon, or
  uploaded custom icon is editable from admin*
- Consultation form:
  - Full name
  - Phone number with **6-digit SMS OTP verification** (two-factor)
  - Company or Individual — choosing **Company** reveals **Company Name + Company Email** (both required)
  - "What will you use the MacBook for?" — *options editable from admin* (AI, ML, Data Science, Daily Tasks…)
  - Budget — *options editable from admin*
  - **Best time to connect: date + time picker**
  - Optional message
  - CTA: **Book my free consultation**
- **Hot & Available MacBooks** section — model cards (image, name, price, specs, badge, condition, warranty) *managed from admin*
- **Google Reviews** section — rating, review link, and curated reviews *managed from admin*
- Header (logo + button) and footer (text, email, policy links) — *editable from admin*
- **Social & contact**: Instagram, Facebook, LinkedIn, Email, Call, WhatsApp icons in the footer,
  plus floating **WhatsApp** and **Call** buttons — *all editable from admin (blank = hidden)*
- Compliance pages: **Privacy Policy, Terms & Conditions, Refund/Return Policy, Warranty Policy** *(editable)*

## Admin panel (`/admin`)

Tabbed dashboard:

- **Leads** — searchable, filterable table (incl. company details), stats, CSV export
- **Branding** — upload logo & banner image, edit hero text, header button, footer, section headings,
  and manage the **USP strip** (add/remove items, pick a built-in icon or upload your own icon image)
- **MacBook Models** — add / edit / delete / hide / reorder the "Hot & Available" cards (with image upload)
- **Form Options** — edit the requirement ("MacBook use") and budget dropdown options
- **Google Reviews** — enable the section, set Google rating / review count / profile link, add curated reviews
- **Compliance Pages** — edit the title & HTML of each policy page

---

## Tech

Node.js + Express · **built-in SQLite (`node:sqlite`)** · Twilio (SMS OTP) · Nodemailer (email) · Multer (image uploads).
Plain HTML/CSS/JS front-end — no build step. **No native modules to compile** — the database uses
Node's built-in SQLite, so there is nothing platform-specific to install.

> **Requires Node.js 24 or newer** (you have v26 ✓). Check with `node -v`.

## Quick start

```bash
npm install
cp .env.example .env      # then edit .env (see below)
npm start
```

> **Upgrading from an earlier copy / seeing a `better_sqlite3` or `ERR_DLOPEN_FAILED` error?**
> That came from an old native dependency. Do a clean reinstall once:
> ```bash
> rm -rf node_modules package-lock.json
> npm install
> npm start
> ```

Open:

- Landing page → http://localhost:3000
- Admin panel  → http://localhost:3000/admin  (default login `admin` / `change-me-now`)

Out of the box it runs in **demo mode**: OTP codes print to the server console (no SMS sent)
and lead emails print to the console (no SMTP needed) — so you can test everything immediately.
The database is seeded with example MacBook models, reviews, and the four compliance pages.

---

## Configuration (`.env`)

**Admin login**
```
ADMIN_USER=admin
ADMIN_PASSWORD=change-me-now      # CHANGE THIS
SESSION_SECRET=<long-random-string>
```

**Lead notification email** — sent to `LEAD_NOTIFY_TO` (default `sachin@mobirapid.com`).
Set SMTP to actually send; leave `SMTP_HOST`/`SMTP_USER` blank to print emails to the console.
```
LEAD_NOTIFY_TO=sachin@mobirapid.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user@mobirapid.com
SMTP_PASS=your-app-password        # Gmail/Workspace: use an App Password
MAIL_FROM="Mobirapid Leads <no-reply@mobirapid.com>"
```

**SMS OTP (two-factor)** — `mock` prints codes to console; `twilio` sends real SMS.
```
OTP_PROVIDER=mock
OTP_TTL_MINUTES=10
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_MESSAGING_SERVICE_SID=      # preferred; OR set TWILIO_FROM_NUMBER
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
```

---

## Google Reviews — how it works

The reviews section is designed to be reliable and free of API billing:

1. In **Admin → Google Reviews**, turn the section on.
2. Paste your **Google review link** (your Google Business "leave a review" / profile URL),
   and enter your overall **rating** and **review count** (copy them from your Google listing).
3. Add a few **curated reviews** (name, stars, text) to display as cards.

Visitors see your rating badge, your best reviews, and a **"Read our Google reviews →"** button
that opens your real Google profile.

> Want fully automatic live syncing of every review? That requires the **Google Places API**
> (a Google Cloud API key with billing enabled and your Place ID). This build uses the
> link + curated approach by default so it works with zero external setup. Ask if you'd like
> the live Places API version wired in.

---

## Notes

- Uploaded images are stored in `public/uploads/` and served automatically.
- Data lives in `leads.db` (SQLite). Set `DB_PATH` to store it elsewhere. The schema auto-migrates
  and seeds defaults on first run; existing data is preserved on upgrade.
- Built-in protections: OTP/submit rate limiting, max 5 wrong-code attempts, OTP expiry & single-use,
  HMAC-signed admin cookie, server-side validation, image-type/size limits on uploads.

## Deploy

Runs on any Node host. In production: use HTTPS, set a strong `ADMIN_PASSWORD` and `SESSION_SECRET`,
and host on a persistent volume so `leads.db` and `public/uploads/` survive restarts.

## Project structure

```
server.js          Express app: OTP, lead, content + admin APIs, uploads, email
db.js              Built-in SQLite (node:sqlite) schema, migrations, default seeds
public/            index.html, styles.css, app.js (landing) · admin.js · uploads/
views/             admin.html (dashboard), login.html
.env.example       Configuration template
```
