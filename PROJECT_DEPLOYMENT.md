# Vietnam GeoGuesser Project Notes
# The CF_API_TOKEN can expire. Check it monthly and update the Worker secret before its expiry date.

## Project

This is a static browser game for guessing locations in Vietnam. The frontend is plain HTML, CSS, and JavaScript:

- `index.html`: page structure
- `styles.css`: layout and visual design
- `app.js`: game logic, canvas map drawing, map interaction, scoring, and R2 asset loading
- `auth-config.js`: public Auth0 application configuration
- `auth.js`: login, signup, logout, and session startup
- `images/locations.js`: round list with image paths and answer coordinates
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
  | checks R2 Class A and Class B usage limits
  v
Cloudflare R2: vietnam-map-data
```

Cloudflare Pages hosts only the small frontend files. Cloudflare R2 stores the large GeoJSON and image files. The Worker is the only public read gateway to R2, so it blocks reads when either configured operation threshold is reached.

The Worker only accepts `GET` and `HEAD`, which are Class B operations. Class A operations are writes and lists performed through the Dashboard, Wrangler, the S3 API, or another Worker. The guard can monitor those operations, but it cannot stop a Class A request that bypasses this Worker. Keep public credentials read-only and route any future writes through a guarded endpoint.

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
CLASS_A_MONTHLY_LIMIT = "1000000"
CLASS_A_BLOCK_RATIO = "0.95"
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

## Authentication

The frontend uses Auth0 Universal Login. One Auth0 application can provide username/password accounts plus Google and Facebook login without storing passwords in this project. Auth0 access tokens also authorize every protected R2 Worker request.

Authentication is enabled in `auth-config.js` with the Auth0 Domain, public Client ID, and API audience. These identifiers are safe to expose in a browser application. Never add an Auth0 Client Secret or Google Client Secret to this repository.

Create an Auth0 API under **Applications > APIs > Create API**:

```text
Name: Vietnam GeoGuesser R2 API
Identifier: https://vietnam-geoguesser-r2-guard.my-slave.workers.dev
Signing Algorithm: RS256
```

The Identifier must exactly match `audience` in `auth-config.js` and `AUTH0_AUDIENCE` in the Worker `wrangler.toml`.

Configure the Auth0 Single Page Application with these values:

```text
Allowed Callback URLs:
https://vn-guesser.pages.dev,http://localhost:8080,http://127.0.0.1:8080

Allowed Logout URLs:
https://vn-guesser.pages.dev,http://localhost:8080,http://127.0.0.1:8080

Allowed Web Origins:
https://vn-guesser.pages.dev,http://localhost:8080,http://127.0.0.1:8080
```

Enable the Auth0 database connection for username/password accounts. Enable Google and Facebook under Auth0 social connections when needed. The login screen is hosted by Auth0, while the game shows a small account/logout control after authentication.

After login, the frontend obtains an in-memory access token and sends it as `Authorization: Bearer <token>` for GeoJSON and R2 image requests. The Worker verifies the Auth0 RS256 signature, issuer, audience, subject, and token lifetime before reading R2. `/health` remains public, while `/usage` and all R2 objects require authentication.

The Worker authentication variables are non-secret:

```toml
AUTH0_ISSUER = "https://phuc-khanh.jp.auth0.com/"
AUTH0_AUDIENCE = "https://vietnam-geoguesser-r2-guard.my-slave.workers.dev"
JWKS_CACHE_SECONDS = "3600"
```

## Deploy Commands

Deploy Worker:

```bash
npx wrangler deploy
```

Create the Auth0 API before deploying the protected frontend. Then deploy the Worker and push this repository so Cloudflare Pages publishes the frontend.

Set/update Worker secret:

```bash
npx wrangler secret put CF_API_TOKEN
```

Test Worker:

```text
https://vietnam-geoguesser-r2-guard.my-slave.workers.dev/health
https://vietnam-geoguesser-r2-guard.my-slave.workers.dev/usage
```

`/health` should work without a token. Opening `/usage` or an object URL directly should return HTTP 401. Requests made by the authenticated game should succeed.

`/usage` reports separate `classA` and `classB` counters. Its `blocked` value becomes `true` when either threshold is reached. Analytics can be delayed, so this is a safety guard rather than a guaranteed billing hard cap.

Cloudflare Pages deploys the frontend from the private GitHub repo.
