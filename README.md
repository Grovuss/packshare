# packshare.site

Static frontend for `packshare.site`.

This repo uses:

- Firebase Anonymous Auth
- Firestore for pack metadata
- Cloudflare Worker + R2 for `.mrpack` file storage
- Vercel for static hosting

## Files

```txt
index.html                  Main website
vercel.json                 Vercel static deployment config
package.json                Optional local preview script
firestore.rules             Firestore rules to paste in Firebase
/docs/cloudflare-worker.js  Backup copy of the Cloudflare Worker code
```

## Before deploying

Open `index.html` and check this line:

```js
const WORKER_URL = 'https://packshare-api.grovuss.workers.dev';
```

Make sure it is your real deployed Cloudflare Worker URL.

Also make sure Firebase Anonymous Auth is enabled and Firestore exists.

## Firebase setup

In Firebase Console:

1. Go to `Authentication > Sign-in method`.
2. Enable `Anonymous`.
3. Go to `Firestore Database`.
4. Create database in production mode.
5. Go to `Firestore Database > Rules`.
6. Paste the contents of `firestore.rules`.
7. Publish.

## Cloudflare setup

You should already have:

- R2 bucket: `packshare-files`
- Worker: `packshare-api`
- R2 binding variable: `PACKS`

If you need to restore the Worker code, paste `docs/cloudflare-worker.js` into the Cloudflare Worker editor and deploy.

## Deploy with Vercel using GitHub

1. Create a new GitHub repo.
2. Upload/commit these files to the repo root.
3. Go to Vercel.
4. Add New Project.
5. Import the GitHub repo.
6. Framework Preset: `Other`.
7. Build Command: leave blank.
8. Output Directory: leave blank.
9. Deploy.

## Deploy with Vercel CLI

Install Vercel CLI:

```bash
npm i -g vercel
```

From this folder:

```bash
vercel --prod
```

## Local preview

```bash
npm install
npm run dev
```

Then open the local URL shown in your terminal.

## Testing checklist

1. Open the deployed Vercel URL.
2. Upload a small `.mrpack`.
3. Confirm it creates an R2 object under `packs/{slug}.mrpack`.
4. Confirm it creates a Firestore document under `packs/{slug}`.
5. Open the generated share link in an incognito window.
6. Click download and confirm the `.mrpack` downloads.


## Retention / auto-delete setup

This version supports three link lifetimes:

- 7 days: files up to 50 MB
- 14 days: files up to 25 MB
- 30 days: files up to 10 MB

To make those lifetimes actually work in Cloudflare R2, do **not** use one catch-all `packs/` delete rule at 7 days. Use separate lifecycle rules by prefix:

- Prefix `packs/7d/` → delete after 7 days
- Prefix `packs/14d/` → delete after 14 days
- Prefix `packs/30d/` → delete after 30 days

For Firestore metadata cleanup, add a TTL policy:

- Collection group: `packs`
- TTL field: `expiresAt`

## CurseForge zip support

The frontend accepts `.zip` files only when the zip contains a root `manifest.json` with `manifestType: "minecraftModpack"`, a `minecraft` object, and a `files` array. Random zip files are rejected before upload.

After updating the frontend, also update the Cloudflare Worker using `docs/cloudflare-worker.js`, because the Worker must allow `.zip` files and the new retention folders.
