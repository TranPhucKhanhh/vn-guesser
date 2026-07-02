# Vietnam GeoGuesser Project Notes
# CF_API_TOKEN in worker can the expired, please check every month to reset and update it to the worker

## Project

This is a static browser game for guessing locations in Vietnam. The frontend is plain HTML, CSS, and JavaScript:

- `index.html`: page structure
- `styles.css`: layout and visual design
- `app.js`: game logic, canvas map drawing, map interaction, scoring, and R2 asset loading
- `images/locations.js`: round list with image paths and answer `coordinates
- `polygon-clipping/`: local helper library used by the map work

Large map/image assets should not be deployed with the frontend repo.

## Data

Large assets are stored in Cloudflare R2 bucket:

```text
vietnam-map-data
```

Expected R2 object keys:

```text
provinces.geojson
special.geojson
wards/01.geojson
wards/04.geojson
images/rounds/hanoi.jpg
```

The frontend uses the same path strings, then `app.js` prepends the Worker URL.

## Deployment Architecture

```text
Browser
  |
  | loads website
  v
Cloudflare Pages
  |
  | fetches map data/images
  v
Cloudflare Worker: vietnam-geoguesser-r2-guard
  |
  | checks R2 Class B usage limit
  v
Cloudflare R2: vietnam-map-data
```

Cloudflare Pages hosts only the small frontend files. Cloudflare R2 stores the large GeoJSON and image files. The Worker is the only public gateway to R2, so it can block reads when the Class B usage limit is near the configured threshold.

## Worker

Worker file:

```text
cloudflare-r2-class-b-guard-worker.js
```

Wrangler config:

```text
wrangler.toml
```

Important config:

```toml
CLASS_B_MONTHLY_LIMIT = "10000000"
CLASS_B_BLOCK_RATIO = "0.95"
USAGE_CACHE_SECONDS = "300"
ALLOWED_ORIGINS = "https://vn-guesser.pages.dev,http://localhost:8080"
```

The API token is stored as a Worker secret named:

```text
CF_API_TOKEN WHICH CAN EXPIRED AROUND OCTOBER 2026
```

It must not be committed into code.

## Deploy Commands

Deploy Worker:

```bash
npx wrangler deploy
```

Set/update Worker secret:

```bash
npx wrangler secret put CF_API_TOKEN
```

Test Worker:

```text
https://vietnam-geoguesser-r2-guard.my-slave.workers.dev/health
https://vietnam-geoguesser-r2-guard.my-slave.workers.dev/usage
```

Cloudflare Pages deploys the frontend from the private GitHub repo.

