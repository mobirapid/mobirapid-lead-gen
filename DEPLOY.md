# Hosting on cPanel

This is a Node.js app, so it runs on cPanel through **Setup Node.js App** (Phusion Passenger / CloudLinux Node.js Selector). Most shared-hosting cPanels include it under the **Software** section.

## 0. Check the Node.js version first (important)

The database uses Node's built-in SQLite, which needs **Node 22.5 or newer** (ideally 24+).

- Open **cPanel → Setup Node.js App → Create Application** and look at the **Node.js version** dropdown.
- If the highest version is **22.5+ / 24+** → you're good, do nothing special.
- If the highest is **18 or 20** → the app auto-falls back to the `better-sqlite3` driver, but you must install it on the server (covered in step 5). Everything else is identical.

If your host has neither a recent Node nor a working build toolchain, a Node-friendly host like Render or Railway is an easier alternative.

## 1. Create the application

cPanel → **Setup Node.js App → Create Application**:

- **Node.js version:** the highest available (22+ preferred)
- **Application mode:** Production
- **Application root:** e.g. `mobirapid` (a new folder in your home directory)
- **Application URL:** pick your domain or a subdomain (e.g. `www.mobirapid.com`)
- **Application startup file:** `server.js`

Click **Create**.

## 2. Upload the project files

Put all the project files into the **Application root** folder you chose, using cPanel **File Manager** (upload a zip and extract) or Git.

**Do NOT upload:**
- `node_modules/` (installed on the server in step 5)
- `.env` (created on the server in step 4)
- `leads.db` (created automatically on first run)

## 3. (If you uploaded a zip) extract it into the application root

Make sure `server.js`, `package.json`, `public/`, `views/`, `db.js` sit directly inside the application root — not in a nested subfolder.

## 4. Create your `.env` file

In File Manager, inside the application root, create a file named `.env` (copy `.env.example` and edit). Set at minimum:

```
ADMIN_USER=admin
ADMIN_PASSWORD=a-strong-password
SESSION_SECRET=a-long-random-string
```

Add SMS/email keys here too if you prefer files over the admin panel — but you can also set all of those later from **Admin → SMS & Email**. (The app reads DB settings first, then `.env`.)

> Tip: you can also set these as **Environment variables** in the Node.js App screen instead of a `.env` file.

## 5. Install dependencies

In the Node.js App screen for your app, click **Run NPM Install** (or open the app's virtual-env terminal and run `npm install`).

- **Only if your host's Node is older than 22.5**, also run:
  ```
  npm install better-sqlite3
  ```
  (The app uses this automatically when the built-in SQLite isn't available.)

## 6. Start / restart the app

Back on the Node.js App screen, click **Restart**. Passenger sets the port automatically; the app already listens on `process.env.PORT`, so nothing to configure.

Visit your domain — the landing page should load. The admin panel is at `https://your-domain/admin`.

## 7. Enable HTTPS

cPanel → **SSL/TLS Status** → run **AutoSSL** for the domain so the site is served over `https://`. Always do this before going live (the admin login and OTP flow should run over HTTPS).

## Notes

- **Data persistence:** `leads.db` and uploaded images (`public/uploads/`) live in the application root and persist across restarts. Back them up periodically (cPanel backups or download `leads.db`).
- **Updating the site:** upload changed files (or `git pull`), then click **Restart** in the Node.js App screen.
- **Secrets:** never commit `.env`. Change `ADMIN_PASSWORD` and `SESSION_SECRET` from the defaults.
- **SMS/Email:** configure 2Factor.in / Twilio / SMTP from **Admin → SMS & Email**, and use the built-in **test** buttons to confirm they work.
