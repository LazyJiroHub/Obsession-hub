# Obsession Hub — Netlify shared storage setup

The site previously saved scripts, settings, photos, and the admin password only in each visitor's browser. This version uses Netlify Functions and Netlify Blobs for shared records and images. Admin writes are checked on the server.

## 1. Deploy from GitHub

1. Upload/commit the contents of this project to the root of `jiroscriptsss/Obsession-hub` (keep `index.html`, `netlify.toml`, `package.json`, and the `netlify/functions/` folder at repository root).
2. In Netlify, open the connected site and select **Deploys**. A push to the production branch should trigger a new deploy.
3. Check the deploy log. Netlify should install `@netlify/blobs` and package the `api` function automatically.

## 2. Configure the admin password (required)

In Netlify, open **Site configuration / Project configuration → Environment variables** and add:

- `OBSESSION_ADMIN_PASSWORD` — choose a new, unique admin password.
- `OBSESSION_SESSION_SECRET` — a separate random secret of at least 32 characters. For example, generate a random 48–64 character string using a trusted password manager. Do not put either secret in GitHub or `index.html`.

Make sure both variables are available to **Functions** at runtime. Save the variables, then trigger a new deploy so the function uses them.

When you click the lock icon on the website, enter `OBSESSION_ADMIN_PASSWORD`. The successful login creates a signed session that expires after 12 hours. Logging in no longer creates a password in the visitor's browser.

## 3. Test shared publishing

1. Log in as admin on the live site.
2. Add a small test script and publish it.
3. Open the site in a private/incognito window or on another device. The same entry should appear after the page refreshes (the page also refreshes shared data periodically).
4. Confirm Netlify's **Functions** logs show requests to `api` if anything fails.

## 4. Import old browser-only entries

After the new version is deployed, log in as admin from the browser that had the old site data. On a fresh shared database, the app makes a one-time import attempt for the old `obs_store_v1` / `obs_assets_v1` browser storage. It does not overwrite an already-populated shared database. If the shared database already has records, old local-only entries will need to be added again through the Add script form.

## Notes

- Netlify Blobs data is shared across browsers and survives new deployments.
- Keep the deployed site on Netlify; a static host that does not run Netlify Functions will not provide the API.
- Do not use a shared or public admin password. Anyone with the admin password can manage the site's entries.
