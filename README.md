# Packshare

Static frontend for `packshare.site` plus Cloudflare Worker code for R2 uploads/downloads and mod page resolution.

## Files

- `index.html` — Vercel static frontend.
- `docs/cloudflare-worker.js` — Cloudflare Worker code. Paste this into `packshare-api`.
- `firestore.rules` — Firestore rules.

## Cloudflare Worker bindings

Required R2 binding:

- Binding name: `PACKS`
- Bucket: `packshare-files`

Optional secret for CurseForge mod name/page lookup:

- Secret name: `CURSEFORGE_API_KEY`
- Value: your CurseForge Core API key

Without `CURSEFORGE_API_KEY`, CurseForge ZIPs still upload and download, but the mod list falls back to project/file IDs.

## Worker endpoints

- `POST /api/upload` — stores `.mrpack` / `.zip` in R2.
- `GET /api/download/:slug` — downloads stored file.
- `POST /api/resolve-mods` — resolves mod page links through Modrinth and CurseForge APIs.

## Vercel deployment

Import this repo into Vercel as a static project. No build command is needed.


## Safety UI update

This version adds an unverified-upload warning to download pages, a required browser confirmation before downloading, Modrinth-page match indicators per mod, and modlist search/sort controls.
