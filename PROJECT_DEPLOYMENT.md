# Vietnam GeoGuesser Deployment

## Architecture

```text
Browser
  |
  | Auth0 access token
  v
Cloudflare Worker
  |-- Durable Object: match order, active round, score, expiry
  |-- R2 binding: maps, wards, private image catalog, WebP images
  v
Cloudflare R2: vietnam-map-data
```

Cloudflare Pages hosts only the public HTML, CSS, JavaScript, menu image, and placeholder. It does not contain round coordinates, province answers, semantic round filenames, or scoring logic.

The Worker source is in `worker/worker.js`. Its configuration is `worker/wrangler.toml`.

## Match API

Authenticated frontend requests use these endpoints:

```text
POST /api/matches
POST /api/matches/{matchId}/ready
GET  /api/round-images/{opaqueAssetId}?size=1280
POST /api/matches/{matchId}/rounds/{roundIndex}/guess
```

`POST /api/matches` selects eight rounds and creates one SQLite-backed Durable Object. The browser receives only opaque image IDs. The correct title, province, coordinates, distance, and score are returned after a valid one-time guess.

The Durable Object binds each match to the Auth0 `sub`, enforces round order, rejects replayed submissions, and deletes the match after 24 hours.

Direct R2 access through the Worker is limited to:

```text
provinces.geojson
special.geojson
wards/{provinceCode}.geojson
```

All `private/` and `images/` keys are rejected by the generic object route.

## Private Round Data

The local source manifest is:

```text
.private/rounds.json
```

This file is intentionally ignored by Git. It contains the answer coordinates and the original image filename. Do not move it into a tracked or Pages-hosted directory.

Original photographs remain outside this repository:

```text
..\images\rounds\
```

The optimizer creates ignored upload artifacts in `.r2-upload/`:

```text
.r2-upload/private/round-catalog.v1.json
.r2-upload/private/round-images/{opaqueId}-1280-{hash}.webp
.r2-upload/private/round-images/{opaqueId}-1920-{hash}.webp
```

The content hash changes the URL whenever image bytes change, so immutable browser caching remains correct.

## Prepare Images

Open Command Prompt in this repository:

```cmd
cd /d D:\project\other\geoguesser-me-code\vn-guesser
npm install
npm run optimize:rounds
```

Sharp rotates from EXIF orientation, strips unnecessary metadata, resizes without enlargement, and generates quality-80 WebP files at 1280px and 1920px.

Upload the generated images and private catalog:

```cmd
npm run upload:rounds
```

The upload script targets `vietnam-map-data`. Override it for another bucket with:

```cmd
set R2_BUCKET_NAME=another-bucket
npm run upload:rounds
```

## Worker Configuration

Important non-secret variables are in `worker/wrangler.toml`:

```toml
ROUND_CATALOG_KEY = "private/round-catalog.v1.json"
STANDARD_MATCH_ROUND_COUNT = "8"
MATCH_LIFETIME_SECONDS = "86400"
ALLOWED_ORIGINS = "https://vn-guesser.pages.dev,http://localhost:8080,http://127.0.0.1:8080"
```

The existing secret must remain configured on the Worker:

```text
CF_API_TOKEN
```

Update it from Command Prompt without placing its value in a file:

```cmd
npx wrangler secret put CF_API_TOKEN --config worker\wrangler.toml
```

## Verification

Run the unit tests, regenerate assets, and validate the Worker bundle:

```cmd
npm test
npm run optimize:rounds
npm run check:worker
```

The Worker dry run verifies the R2 and Durable Object bindings without deploying.

## Deployment Order

1. Upload the optimized private R2 assets.
2. Deploy the Worker containing the match API and Durable Object migration.
3. Push the frontend commit so Cloudflare Pages deploys it.

Commands:

```cmd
cd /d D:\project\other\geoguesser-me-code\vn-guesser
npm run upload:rounds
npx wrangler deploy --config worker\wrangler.toml
git push origin main
```

Deploying the Worker with the same service name keeps the existing `CF_API_TOKEN` secret. The first deployment creates the SQLite-backed `MatchSession` Durable Object namespace.

## Caching Behavior

The preparation screen downloads all selected compressed images with three concurrent requests. It decodes only the active round and two rounds ahead. The timer starts after the map, images, and initial decoded window are ready.

Round image responses use a one-year private immutable browser cache. Stable opaque asset URLs allow reuse in later matches. The Worker also uses Cloudflare's Cache API after authentication; R2 edge caching requires a custom domain or Worker route because it has no effect on `*.workers.dev`.

The frontend does not request ward GeoJSON. Province and special-region files are sufficient for map drawing, hit-testing, flag placement, and scoring. Ward objects may remain in R2 for future features without affecting current loading time.

## Security Boundary

Players can always inspect photographs downloaded by their browser. They cannot obtain answer coordinates from the frontend bundle, image URLs, or match-creation response. Auth0 protects the API, and scoring happens only inside the match Durable Object.

Never commit `.private/`, `.r2-upload/`, Auth0 client secrets, Google/Facebook client secrets, or `CF_API_TOKEN`.
