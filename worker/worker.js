const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DEFAULT_CLASS_A_MONTHLY_LIMIT = 1_000_000;
const DEFAULT_CLASS_B_MONTHLY_LIMIT = 10_000_000;
const DEFAULT_BLOCK_RATIO = 0.95;
const DEFAULT_CACHE_SECONDS = 300;
const DEFAULT_JWKS_CACHE_SECONDS = 3600;
const JWT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_ROUND_CATALOG_KEY = "private/round-catalog.v1.json";
const DEFAULT_MATCH_ROUND_COUNT = 8;
const DEFAULT_MATCH_LIFETIME_SECONDS = 86_400;
const DEFAULT_OBJECT_CACHE_SECONDS = 31_536_000;
const DEFAULT_LEADERBOARD_KEY = "leaderboard/standard_mode/entries.json";
const DEFAULT_LEADERBOARD_LIMIT = 1000;
const DEFAULT_LEADERBOARD_PAGE_SIZE = 10;
const ROUND_IMAGE_WIDTHS = new Set(["1280", "1920"]);

let roundCatalogMemoryCache = null;
let usageMemoryCache = null;
let usageRefreshPromise = null;
let jwksMemoryCache = null;
let jwksRefreshPromise = null;

const CLASS_A_ACTION_TYPES = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);

const CLASS_B_ACTION_TYPES = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), env, request);
    }

    if (url.pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return json({ ok: true, service: "r2-operation-guard" }, env, 200, request);
    }

    const authenticated = await authenticateRequest(request, env, ctx);
    if (!authenticated) {
      return unauthorized(env, request);
    }

    if (url.pathname === "/usage") {
      if (request.method !== "GET") return methodNotAllowed(env, request, ["GET"]);
      const usage = await getR2Usage(env, ctx, { forceRefresh: true });
      return json(usage, env, 200, request);
    }

    if (url.pathname === "/api/matches") {
      if (request.method !== "POST") return methodNotAllowed(env, request, ["POST"]);
      return createMatch(authenticated, env, ctx, request);
    }

    if (url.pathname === "/api/leaderboards/standard_mode") {
      if (request.method !== "GET") return methodNotAllowed(env, request, ["GET"]);
      return getStandardLeaderboard(env, request);
    }

    const leaderboardProfileRoute = url.pathname.match(
      /^\/api\/leaderboards\/standard_mode\/profiles\/([a-f0-9]{24})$/i,
    );
    if (leaderboardProfileRoute) {
      if (request.method !== "GET") return methodNotAllowed(env, request, ["GET"]);
      return getStandardLeaderboardProfile(leaderboardProfileRoute[1], env, request);
    }

    const readyRoute = url.pathname.match(/^\/api\/matches\/([0-9a-f]+)\/ready$/i);
    if (readyRoute) {
      if (request.method !== "POST") return methodNotAllowed(env, request, ["POST"]);
      return forwardMatchRequest(readyRoute[1], "/ready", authenticated, env, ctx, request);
    }

    const guessRoute = url.pathname.match(
      /^\/api\/matches\/([0-9a-f]+)\/rounds\/(\d+)\/guess$/i,
    );
    if (guessRoute) {
      if (request.method !== "POST") return methodNotAllowed(env, request, ["POST"]);
      return forwardMatchRequest(
        guessRoute[1],
        `/rounds/${guessRoute[2]}/guess`,
        authenticated,
        env,
        ctx,
        request,
      );
    }

    const imageRoute = url.pathname.match(/^\/api\/round-images\/([a-z0-9_-]+)$/i);
    if (imageRoute) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(env, request, ["GET", "HEAD"]);
      }
      return serveRoundImage(imageRoute[1], url.searchParams.get("size"), env, ctx, request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(env, request, ["GET", "HEAD"]);
    }

    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (!isAllowedMapAssetKey(key)) {
      return json({ ok: false, error: "Missing or invalid object key." }, env, 400, request);
    }
    return serveR2Object(key, env, ctx, request, {
      browserCacheControl: env.OBJECT_CACHE_CONTROL || "private, max-age=86400",
    });
  },
};

export class MatchSession {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const existing = await this.state.storage.get("match");
      if (existing) return internalJson({ error: "Match already exists." }, 409);

      const match = await request.json();
      if (!isValidStoredMatch(match)) {
        return internalJson({ error: "Invalid match data." }, 400);
      }

      await this.state.storage.put("match", match);
      await this.state.storage.setAlarm(match.expiresAt);
      return internalJson({ ok: true });
    }

    const match = await this.state.storage.get("match");
    if (!match) return internalJson({ error: "Match not found." }, 404);

    if (Date.now() >= match.expiresAt) {
      await this.state.storage.deleteAll();
      return internalJson({ error: "Match expired." }, 410);
    }

    const playerSubject = request.headers.get("x-player-sub");
    if (!playerSubject || playerSubject !== match.playerSubject) {
      return internalJson({ error: "This match belongs to another player." }, 403);
    }

    if (url.pathname === "/ready" && request.method === "POST") {
      if (!match.startedAt) {
        match.startedAt = Date.now();
        await this.state.storage.put("match", match);
      }

      return internalJson({
        ok: true,
        startedAt: match.startedAt,
        roundCount: match.rounds.length,
      });
    }

    const guessRoute = url.pathname.match(/^\/rounds\/(\d+)\/guess$/);
    if (guessRoute && request.method === "POST") {
      if (!match.startedAt) return internalJson({ error: "Match has not started." }, 409);

      const roundIndex = Number(guessRoute[1]);
      if (roundIndex !== match.currentRoundIndex) {
        return internalJson(
          { error: "This round has already been submitted or is not active." },
          409,
        );
      }

      const payload = await readJsonBody(request);
      const guess = normalizeGuess(payload?.guess);
      if (!guess) return internalJson({ error: "Invalid guess coordinates." }, 400);

      const round = match.rounds[roundIndex];
      if (!round) return internalJson({ error: "Round not found." }, 404);

      const distance = haversineDistance(guess.lat, guess.lng, round.lat, round.lng);
      const roundScore = calculateScore(distance);
      match.totalScore += roundScore;
      match.currentRoundIndex += 1;
      const finished = match.currentRoundIndex >= match.rounds.length;
      if (finished && !match.completedAt) match.completedAt = Date.now();
      await this.state.storage.put("match", match);

      return internalJson({
        ok: true,
        result: {
          title: round.title,
          province: round.province,
          lat: round.lat,
          lng: round.lng,
          distance,
          roundScore,
          totalScore: match.totalScore,
        },
        finished,
        completion: finished
          ? {
              profileId: match.profileId,
              playerName: match.playerName,
              points: match.totalScore,
              timeMs: Math.max(0, match.completedAt - match.startedAt),
              completedAt: match.completedAt,
            }
          : undefined,
      });
    }

    return internalJson({ error: "Match route not found." }, 404);
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

export class LeaderboardStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.recordQueue = Promise.resolve();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/entries" && request.method === "GET") {
      const snapshot = await this.getSnapshot();
      return internalJson({ ok: true, snapshot });
    }

    const profileRoute = url.pathname.match(/^\/profiles\/([a-f0-9]{24})$/i);
    if (profileRoute && request.method === "GET") {
      const snapshot = await this.getSnapshot();
      const index = snapshot.entries.findIndex(
        (entry) => entry.profileId === profileRoute[1].toLowerCase(),
      );
      if (index < 0) return internalJson({ error: "Player profile not found." }, 404);
      return internalJson({
        ok: true,
        profile: { ...snapshot.entries[index], rank: index + 1 },
      });
    }

    if (url.pathname === "/record" && request.method === "POST") {
      const result = normalizeLeaderboardResult(await readJsonBody(request));
      if (!result) return internalJson({ error: "Invalid leaderboard result." }, 400);

      const recording = this.recordQueue.then(() => this.recordResult(result));
      this.recordQueue = recording.catch(() => {});
      return recording;
    }

    return internalJson({ error: "Leaderboard route not found." }, 404);
  }

  async recordResult(result) {
    const snapshot = await this.getSnapshot();
    const existing = snapshot.entries.find((entry) => entry.profileId === result.profileId);
    const gamesPlayed = (existing?.gamesPlayed || 0) + 1;
    const bestResult = !existing || compareLeaderboardEntries(result, existing) < 0
      ? result
      : existing;
    const entry = {
      ...bestResult,
      name: result.name,
      initials: initialsForName(result.name),
      gamesPlayed,
      updatedAt: result.completedAt,
    };
    const entries = snapshot.entries
      .filter((item) => item.profileId !== result.profileId)
      .concat(entry)
      .sort(compareLeaderboardEntries)
      .slice(0, numberFromEnv(this.env.LEADERBOARD_MAX_ENTRIES, DEFAULT_LEADERBOARD_LIMIT));
    const nextSnapshot = {
      version: 1,
      mode: "standard_mode",
      updatedAt: new Date().toISOString(),
      entries,
    };

    await this.state.storage.put("snapshot", nextSnapshot);
    await this.env.DATA_BUCKET.put(
      this.env.STANDARD_LEADERBOARD_KEY || DEFAULT_LEADERBOARD_KEY,
      JSON.stringify(nextSnapshot),
      { httpMetadata: { contentType: "application/json; charset=utf-8" } },
    );

    const rank = entries.findIndex((item) => item.profileId === result.profileId) + 1;
    return internalJson({ ok: true, rank: rank || null });
  }

  async getSnapshot() {
    const stored = await this.state.storage.get("snapshot");
    if (stored) return normalizeLeaderboardSnapshot(stored);

    const key = this.env.STANDARD_LEADERBOARD_KEY || DEFAULT_LEADERBOARD_KEY;
    const object = await this.env.DATA_BUCKET.get(key);
    const snapshot = object
      ? normalizeLeaderboardSnapshot(await object.json())
      : emptyLeaderboardSnapshot();
    await this.state.storage.put("snapshot", snapshot);
    return snapshot;
  }
}

async function createMatch(authenticated, env, ctx, request) {
  if (!env.MATCHES) {
    return json({ ok: false, error: "Match storage binding is unavailable." }, env, 500, request);
  }

  const usageError = await getUsageBlockResponse(env, ctx, request);
  if (usageError) return usageError;

  try {
    const payload = await readJsonBody(request);
    const playerName = normalizePlayerName(payload?.playerName);
    const profileId = await publicProfileId(authenticated.sub);
    const catalog = await getRoundCatalog(env, ctx);
    const requestedCount = Math.min(
      numberFromEnv(env.STANDARD_MATCH_ROUND_COUNT, DEFAULT_MATCH_ROUND_COUNT),
      catalog.rounds.length,
    );
    const rounds = shuffledCopy(catalog.rounds).slice(0, requestedCount);
    const durableId = env.MATCHES.newUniqueId();
    const matchId = durableId.toString();
    const now = Date.now();
    const match = {
      playerSubject: authenticated.sub,
      profileId,
      playerName,
      createdAt: now,
      expiresAt:
        now +
        numberFromEnv(env.MATCH_LIFETIME_SECONDS, DEFAULT_MATCH_LIFETIME_SECONDS) * 1000,
      startedAt: null,
      currentRoundIndex: 0,
      totalScore: 0,
      rounds,
    };
    const stub = env.MATCHES.get(durableId);
    const initialized = await stub.fetch("https://match.internal/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(match),
    });

    if (!initialized.ok) {
      const failure = await initialized.json();
      throw new Error(failure.error || "Could not initialize match.");
    }

    return json(
      {
        ok: true,
        matchId,
        roundCount: rounds.length,
        rounds: rounds.map((round, index) => ({
          index,
          imagePath: `api/round-images/${encodeURIComponent(round.assetId)}`,
        })),
      },
      env,
      201,
      request,
    );
  } catch (error) {
    console.error("Match creation failed:", error);
    if (error.usage) {
      return json(
        { ok: false, error: "R2 operation limit guard is active.", usage: error.usage },
        env,
        429,
        request,
      );
    }
    return json({ ok: false, error: "Could not prepare a match." }, env, 500, request);
  }
}

async function forwardMatchRequest(matchId, internalPath, authenticated, env, ctx, request) {
  if (!env.MATCHES) {
    return json({ ok: false, error: "Match storage binding is unavailable." }, env, 500, request);
  }

  let durableId;
  try {
    durableId = env.MATCHES.idFromString(matchId);
  } catch {
    return json({ ok: false, error: "Invalid match ID." }, env, 400, request);
  }

  const headers = new Headers({
    "content-type": "application/json",
    "x-player-sub": authenticated.sub,
  });
  const body = internalPath === "/ready" ? undefined : await request.text();
  const response = await env.MATCHES.get(durableId).fetch(`https://match.internal${internalPath}`, {
    method: "POST",
    headers,
    body,
  });
  const payload = await response.json();
  if (response.ok && payload.finished && payload.completion) {
    try {
      const leaderboardResult = await recordStandardLeaderboardResult(
        payload.completion,
        env,
        ctx,
        request,
      );
      payload.leaderboard = leaderboardResult;
    } catch (error) {
      console.error("Leaderboard result recording failed:", error);
      payload.leaderboard = { saved: false };
    }
  }
  return json({ ok: response.ok, ...payload }, env, response.status, request);
}

async function recordStandardLeaderboardResult(completion, env, ctx, request) {
  if (!env.LEADERBOARDS) return { saved: false };
  const usageError = await getUsageBlockResponse(env, ctx, request);
  if (usageError) return { saved: false, blocked: true };

  const response = await standardLeaderboardStub(env).fetch("https://leaderboard.internal/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(completion),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Could not record leaderboard result.");
  return { saved: true, rank: payload.rank };
}

async function getStandardLeaderboard(env, request) {
  if (!env.LEADERBOARDS) {
    return json({ ok: false, error: "Leaderboard storage binding is unavailable." }, env, 500, request);
  }

  const response = await standardLeaderboardStub(env).fetch("https://leaderboard.internal/entries");
  const payload = await response.json();
  if (!response.ok) return json({ ok: false, ...payload }, env, response.status, request);
  const limit = numberFromEnv(env.LEADERBOARD_PAGE_SIZE, DEFAULT_LEADERBOARD_PAGE_SIZE);
  return json(
    {
      ok: true,
      mode: payload.snapshot.mode,
      updatedAt: payload.snapshot.updatedAt,
      entries: payload.snapshot.entries.slice(0, limit).map((entry, index) => ({
        ...entry,
        rank: index + 1,
      })),
    },
    env,
    200,
    request,
  );
}

async function getStandardLeaderboardProfile(profileId, env, request) {
  if (!env.LEADERBOARDS) {
    return json({ ok: false, error: "Leaderboard storage binding is unavailable." }, env, 500, request);
  }

  const response = await standardLeaderboardStub(env).fetch(
    `https://leaderboard.internal/profiles/${profileId.toLowerCase()}`,
  );
  const payload = await response.json();
  return json({ ok: response.ok, ...payload }, env, response.status, request);
}

function standardLeaderboardStub(env) {
  return env.LEADERBOARDS.get(env.LEADERBOARDS.idFromName("standard_mode"));
}

async function serveRoundImage(assetId, requestedWidth, env, ctx, request) {
  const width = ROUND_IMAGE_WIDTHS.has(requestedWidth) ? requestedWidth : "1920";

  try {
    const catalog = await getRoundCatalog(env, ctx, request);
    const round = catalog.roundsByAssetId.get(assetId);
    const key = round?.images?.[width] || round?.images?.["1920"];
    if (!key) return json({ ok: false, error: "Round image not found." }, env, 404, request);

    return serveR2Object(key, env, ctx, request, {
      browserCacheControl: `private, max-age=${DEFAULT_OBJECT_CACHE_SECONDS}, immutable`,
    });
  } catch (error) {
    console.error("Round image request failed:", error);
    if (error.usage) {
      return json(
        { ok: false, error: "R2 operation limit guard is active.", usage: error.usage },
        env,
        429,
        request,
      );
    }
    return json({ ok: false, error: "Could not load round image." }, env, 500, request);
  }
}

async function getRoundCatalog(env, ctx, request = null) {
  const now = Date.now();
  if (roundCatalogMemoryCache?.expiresAt > now) return roundCatalogMemoryCache.catalog;

  const usage = await getR2Usage(env, ctx);
  if (usage.blocked) {
    const error = new Error("R2 operation limit guard is active.");
    error.usage = usage;
    throw error;
  }

  const key = env.ROUND_CATALOG_KEY || DEFAULT_ROUND_CATALOG_KEY;
  const object = await env.DATA_BUCKET.get(key);
  if (!object) throw new Error(`Round catalog object not found: ${key}`);

  const rawCatalog = await object.json();
  const catalog = validateRoundCatalog(rawCatalog);
  roundCatalogMemoryCache = {
    catalog,
    expiresAt: now + numberFromEnv(env.ROUND_CATALOG_CACHE_SECONDS, DEFAULT_CACHE_SECONDS) * 1000,
  };
  return catalog;
}

function validateRoundCatalog(rawCatalog) {
  if (!rawCatalog || !Array.isArray(rawCatalog.rounds)) {
    throw new Error("Round catalog must contain a rounds array.");
  }

  const assetIds = new Set();
  const rounds = rawCatalog.rounds.map((round) => {
    const lat = Number(round.lat);
    const lng = Number(round.lng);
    if (
      typeof round.assetId !== "string" ||
      !/^[a-z0-9_-]{16,80}$/i.test(round.assetId) ||
      assetIds.has(round.assetId) ||
      typeof round.title !== "string" ||
      typeof round.province !== "string" ||
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lng) ||
      lng < -180 ||
      lng > 180 ||
      typeof round.images?.["1280"] !== "string" ||
      typeof round.images?.["1920"] !== "string"
    ) {
      throw new Error("Round catalog contains an invalid entry.");
    }

    assetIds.add(round.assetId);
    return {
      assetId: round.assetId,
      title: round.title,
      province: round.province,
      lat,
      lng,
      images: {
        "1280": round.images["1280"],
        "1920": round.images["1920"],
      },
    };
  });

  if (!rounds.length) throw new Error("Round catalog is empty.");
  return {
    version: rawCatalog.version || 1,
    rounds,
    roundsByAssetId: new Map(rounds.map((round) => [round.assetId, round])),
  };
}

function isAllowedMapAssetKey(key) {
  if (!key || key.includes("..") || key.startsWith("private/") || key.startsWith("images/")) {
    return false;
  }

  return key === "provinces.geojson" || key === "special.geojson" || /^wards\/\d{2}\.geojson$/.test(key);
}

async function serveR2Object(key, env, ctx, request, options = {}) {
  const cached = await getEdgeCachedObject(key, request);
  if (cached) {
    return responseForBrowser(cached, env, request, options.browserCacheControl);
  }

  const usageError = await getUsageBlockResponse(env, ctx, request);
  if (usageError) return usageError;

  const object =
    request.method === "HEAD" ? await env.DATA_BUCKET.head(key) : await env.DATA_BUCKET.get(key);
  if (!object) return json({ ok: false, error: "Object not found." }, env, 404, request);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));

  if (request.method === "HEAD") {
    headers.set("cache-control", options.browserCacheControl || "private, max-age=86400");
    return withCors(new Response(null, { headers }), env, request);
  }

  const edgeHeaders = new Headers(headers);
  edgeHeaders.set("cache-control", `public, max-age=${DEFAULT_OBJECT_CACHE_SECONDS}, immutable`);
  const edgeResponse = new Response(object.body, { headers: edgeHeaders });
  ctx.waitUntil(putEdgeCachedObject(key, request, edgeResponse.clone()));
  return responseForBrowser(edgeResponse, env, request, options.browserCacheControl);
}

function responseForBrowser(response, env, request, cacheControl) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", cacheControl || "private, max-age=86400");
  return withCors(new Response(request.method === "HEAD" ? null : response.body, { headers }), env, request);
}

function edgeCacheKey(key, request) {
  const origin = new URL(request.url).origin;
  return new Request(`${origin}/__r2-object-cache/${encodeURIComponent(key)}`);
}

async function getEdgeCachedObject(key, request) {
  const response = await caches.default.match(edgeCacheKey(key, request));
  if (!response) return null;
  return request.method === "HEAD" ? new Response(null, { headers: response.headers }) : response;
}

async function putEdgeCachedObject(key, request, response) {
  try {
    await caches.default.put(edgeCacheKey(key, request), response);
  } catch (error) {
    console.warn("R2 edge cache write failed:", error);
  }
}

async function getUsageBlockResponse(env, ctx, request) {
  const usage = await getR2Usage(env, ctx);
  if (!usage.blocked) return null;
  return json(
    { ok: false, error: "R2 operation limit guard is active.", usage },
    env,
    429,
    request,
  );
}

function shuffledCopy(items) {
  const shuffled = items.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    const swapIndex = Math.floor(random * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function isValidStoredMatch(match) {
  return Boolean(
    match &&
      typeof match.playerSubject === "string" &&
      Number.isFinite(match.createdAt) &&
      Number.isFinite(match.expiresAt) &&
      Array.isArray(match.rounds) &&
      match.rounds.length > 0,
  );
}

function normalizePlayerName(value) {
  if (typeof value !== "string") return "Người chơi";
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
  return name.slice(0, 40) || "Người chơi";
}

function initialsForName(name) {
  const parts = normalizePlayerName(name).split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0] || "")
    .join("")
    .toUpperCase() || "U";
}

async function publicProfileId(subject) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return Array.from(new Uint8Array(bytes).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function normalizeLeaderboardResult(value) {
  const profileId = String(value?.profileId || "").toLowerCase();
  const points = Number(value?.points);
  const timeMs = Number(value?.timeMs);
  const completedAt = new Date(value?.completedAt);
  if (
    !/^[a-f0-9]{24}$/.test(profileId) ||
    !Number.isFinite(points) ||
    points < 0 ||
    points > 1_000_000 ||
    !Number.isFinite(timeMs) ||
    timeMs < 0 ||
    timeMs > DEFAULT_MATCH_LIFETIME_SECONDS * 1000 ||
    Number.isNaN(completedAt.getTime())
  ) {
    return null;
  }

  const name = normalizePlayerName(value.playerName ?? value.name);
  return {
    profileId,
    name,
    initials: initialsForName(name),
    points: Math.round(points),
    timeMs: Math.round(timeMs),
    completedAt: completedAt.toISOString(),
  };
}

function normalizeLeaderboardSnapshot(value) {
  const entries = Array.isArray(value?.entries)
    ? value.entries
        .map((entry) => {
          const normalized = normalizeLeaderboardResult(entry);
          if (!normalized) return null;
          return {
            ...normalized,
            gamesPlayed: Math.max(1, Math.floor(Number(entry.gamesPlayed) || 1)),
            updatedAt: new Date(entry.updatedAt || normalized.completedAt).toISOString(),
          };
        })
        .filter(Boolean)
        .sort(compareLeaderboardEntries)
    : [];

  return {
    version: 1,
    mode: "standard_mode",
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
    entries,
  };
}

function emptyLeaderboardSnapshot() {
  return { version: 1, mode: "standard_mode", updatedAt: null, entries: [] };
}

function compareLeaderboardEntries(left, right) {
  return right.points - left.points || left.timeMs - right.timeMs ||
    left.name.localeCompare(right.name, "vi");
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeGuess(guess) {
  const lat = Number(guess?.lat);
  const lng = Number(guess?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const latDelta = ((lat2 - lat1) * Math.PI) / 180;
  const lngDelta = ((lng2 - lng1) * Math.PI) / 180;
  const value =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(lngDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function calculateScore(distanceKm) {
  return Math.max(0, Math.round(5000 * Math.exp(-distanceKm / 200)));
}

function internalJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function authenticateRequest(request, env, ctx) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1].length > 16_384) {
    return null;
  }

  try {
    return await verifyAccessToken(match[1], env, ctx);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "auth_rejected",
        reason: error instanceof Error ? error.message : "Unknown token validation error",
      }),
    );
    return null;
  }
}

async function verifyAccessToken(token, env, ctx) {
  assertAuthEnv(env);

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error("Malformed JWT");
  }

  const header = decodeJwtJson(parts[0]);
  const claims = decodeJwtJson(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new Error("Unsupported JWT header");
  }

  const jwk = await getSigningJwk(env, ctx, header.kid);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) {
    throw new Error("Invalid JWT signature");
  }

  validateAccessTokenClaims(claims, env);
  return claims;
}

function validateAccessTokenClaims(claims, env) {
  const now = Math.floor(Date.now() / 1000);
  const issuer = normalizedIssuer(env.AUTH0_ISSUER);

  if (claims.iss !== issuer) {
    throw new Error("Invalid token issuer");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.AUTH0_AUDIENCE)) {
    throw new Error("Invalid token audience");
  }

  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("Missing token subject");
  }

  if (typeof claims.exp !== "number" || claims.exp <= now - JWT_CLOCK_SKEW_SECONDS) {
    throw new Error("Expired token");
  }

  if (
    typeof claims.nbf === "number" &&
    claims.nbf > now + JWT_CLOCK_SKEW_SECONDS
  ) {
    throw new Error("Token is not active yet");
  }
}

async function getSigningJwk(env, ctx, kid) {
  let jwks = await getJwks(env, ctx, false);
  let jwk = findSigningJwk(jwks, kid);

  if (!jwk) {
    jwks = await getJwks(env, ctx, true);
    jwk = findSigningJwk(jwks, kid);
  }

  if (!jwk) {
    throw new Error("Unknown signing key");
  }

  return jwk;
}

function findSigningJwk(jwks, kid) {
  if (!Array.isArray(jwks?.keys)) return null;

  return jwks.keys.find(
    (key) =>
      key.kid === kid &&
      key.kty === "RSA" &&
      (!key.use || key.use === "sig") &&
      (!key.alg || key.alg === "RS256"),
  ) || null;
}

async function getJwks(env, ctx, forceRefresh) {
  const cacheSeconds = numberFromEnv(env.JWKS_CACHE_SECONDS, DEFAULT_JWKS_CACHE_SECONDS);
  if (!forceRefresh && jwksMemoryCache?.expiresAt > Date.now()) {
    return jwksMemoryCache.value;
  }

  if (!forceRefresh && jwksRefreshPromise) return jwksRefreshPromise;

  const refresh = refreshJwks(env, ctx, forceRefresh).then((jwks) => {
    jwksMemoryCache = {
      value: jwks,
      expiresAt: Date.now() + cacheSeconds * 1000,
    };
    return jwks;
  });

  if (forceRefresh) return refresh;

  jwksRefreshPromise = refresh;
  try {
    return await refresh;
  } finally {
    jwksRefreshPromise = null;
  }
}

async function refreshJwks(env, ctx, forceRefresh) {
  const jwksUrl = new URL(".well-known/jwks.json", normalizedIssuer(env.AUTH0_ISSUER)).toString();
  const cacheKey = new Request(jwksUrl);

  if (!forceRefresh) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return cached.json();
    }
  }

  const response = await fetch(jwksUrl, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`JWKS request failed with status ${response.status}`);
  }

  const jwks = await response.json();
  const cacheSeconds = numberFromEnv(env.JWKS_CACHE_SECONDS, DEFAULT_JWKS_CACHE_SECONDS);
  const cacheResponse = new Response(JSON.stringify(jwks), {
    headers: {
      "content-type": "application/json",
      "cache-control": `max-age=${cacheSeconds}`,
    },
  });
  ctx.waitUntil(caches.default.put(cacheKey, cacheResponse));
  return jwks;
}

function decodeJwtJson(value) {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  } catch {
    throw new Error("Invalid JWT encoding");
  }
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizedIssuer(issuer) {
  return `${String(issuer || "").replace(/\/+$/, "")}/`;
}

function assertAuthEnv(env) {
  const missing = ["AUTH0_ISSUER", "AUTH0_AUDIENCE"].filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing authentication variable: ${missing.join(", ")}`);
  }
}

function unauthorized(env, request) {
  const response = json(
    { ok: false, error: "A valid Auth0 access token is required." },
    env,
    401,
    request,
  );
  response.headers.set("www-authenticate", 'Bearer realm="vietnam-geoguesser-r2"');
  return response;
}

function methodNotAllowed(env, request, allowedMethods) {
  const response = json(
    { ok: false, error: `Allowed methods: ${allowedMethods.join(", ")}.` },
    env,
    405,
    request,
  );
  response.headers.set("allow", allowedMethods.join(", "));
  return response;
}

async function getR2Usage(env, ctx, options = {}) {
  const cacheSeconds = numberFromEnv(env.USAGE_CACHE_SECONDS, DEFAULT_CACHE_SECONDS);
  if (!options.forceRefresh && usageMemoryCache?.expiresAt > Date.now()) {
    return usageMemoryCache.value;
  }

  if (!options.forceRefresh && usageRefreshPromise) return usageRefreshPromise;

  const refresh = refreshR2Usage(env, ctx, options).then((usage) => {
    usageMemoryCache = {
      value: usage,
      expiresAt: Date.now() + cacheSeconds * 1000,
    };
    return usage;
  });

  if (options.forceRefresh) return refresh;

  usageRefreshPromise = refresh;
  try {
    return await refresh;
  } finally {
    usageRefreshPromise = null;
  }
}

async function refreshR2Usage(env, ctx, options = {}) {
  assertRequiredEnv(env);

  const cacheSeconds = numberFromEnv(env.USAGE_CACHE_SECONDS, DEFAULT_CACHE_SECONDS);
  const cacheKey = new Request(
    `https://r2-limit-guard.local/usage-v2/${env.CF_ACCOUNT_ID}/${bucketNameForAnalytics(env)}`,
  );

  if (!options.forceRefresh && cacheSeconds > 0) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      return cached.json();
    }
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await queryR2Operations(env, start, now);
  let classARequests = 0;
  let classBRequests = 0;

  for (const row of rows) {
    const actionType = row.dimensions?.actionType;
    const statusCode = Number(row.dimensions?.responseStatusCode || 0);
    const requests = Number(row.sum?.requests || 0);

    // Cloudflare does not charge unauthorized requests. Excluding them also
    // prevents repeated 401 responses from activating the guard.
    if (statusCode === 401) {
      continue;
    }

    if (CLASS_A_ACTION_TYPES.has(actionType)) {
      classARequests += requests;
    } else if (CLASS_B_ACTION_TYPES.has(actionType)) {
      classBRequests += requests;
    }
  }

  const classA = buildClassUsage(
    classARequests,
    numberFromEnv(env.CLASS_A_MONTHLY_LIMIT, DEFAULT_CLASS_A_MONTHLY_LIMIT),
    ratioFromEnv(env.CLASS_A_BLOCK_RATIO, DEFAULT_BLOCK_RATIO),
  );
  const classB = buildClassUsage(
    classBRequests,
    numberFromEnv(env.CLASS_B_MONTHLY_LIMIT, DEFAULT_CLASS_B_MONTHLY_LIMIT),
    ratioFromEnv(env.CLASS_B_BLOCK_RATIO, DEFAULT_BLOCK_RATIO),
  );
  const blockedClasses = [];

  if (classA.blocked) blockedClasses.push("A");
  if (classB.blocked) blockedClasses.push("B");

  const usage = {
    ok: true,
    bucket: bucketNameForAnalytics(env),
    periodStart: start.toISOString(),
    periodEnd: now.toISOString(),
    classARequests,
    classBRequests,
    classA,
    classB,
    blocked: blockedClasses.length > 0,
    blockedClasses,
    cacheSeconds,
    note: "GraphQL analytics are delayed product analytics, so this is a practical guard rather than an exact real-time billing cap.",
  };

  if (cacheSeconds > 0) {
    const response = json(usage, env);
    response.headers.set("cache-control", `max-age=${cacheSeconds}`);
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
  }

  return usage;
}

function buildClassUsage(requests, monthlyLimit, blockRatio) {
  const blockAt = Math.floor(monthlyLimit * blockRatio);

  return {
    requests,
    monthlyLimit,
    blockRatio,
    blockAt,
    remainingBeforeBlock: Math.max(blockAt - requests, 0),
    percentOfLimit: monthlyLimit > 0 ? requests / monthlyLimit : 1,
    blocked: requests >= blockAt,
  };
}

async function queryR2Operations(env, startDate, endDate) {
  const query = `
    query R2OperationUsage(
      $accountTag: string!
      $startDate: Time
      $endDate: Time
      $bucketName: string
    ) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            limit: 10000
            filter: {
              datetime_geq: $startDate
              datetime_leq: $endDate
              bucketName: $bucketName
            }
          ) {
            sum {
              requests
            }
            dimensions {
              actionType
              responseStatusCode
            }
          }
        }
      }
    }
  `;

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: env.CF_ACCOUNT_ID,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        bucketName: bucketNameForAnalytics(env),
      },
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(
      `Cloudflare GraphQL usage query failed: ${JSON.stringify(payload.errors || payload)}`,
    );
  }

  return payload.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups || [];
}

function bucketNameForAnalytics(env) {
  if (!env.R2_BUCKET_JURISDICTION) {
    return env.R2_BUCKET_NAME;
  }

  return `${env.R2_BUCKET_JURISDICTION}_${env.R2_BUCKET_NAME}`;
}

function assertRequiredEnv(env) {
  const missing = ["DATA_BUCKET", "CF_ACCOUNT_ID", "CF_API_TOKEN", "R2_BUCKET_NAME"].filter(
    (key) => !env[key],
  );

  if (missing.length) {
    throw new Error(`Missing Worker binding or variable: ${missing.join(", ")}`);
  }
}

function numberFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function ratioFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}

function json(data, env, status = 200, request = null) {
  return withCors(
    new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
    env,
    request,
  );
}

function withCors(response, env, request = null) {
  const headers = new Headers(response.headers);
  const requestOrigin = request?.headers.get("origin");
  const allowedOrigin = getAllowedOrigin(env, requestOrigin);

  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("access-control-allow-methods", "GET, HEAD, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-expose-headers", "cache-control, content-length, content-type, etag");
  headers.set("vary", "Origin, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getAllowedOrigin(env, requestOrigin) {
  const rawOrigins = env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || "*";
  if (rawOrigins === "*") return "*";

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
  const allowedOrigins = rawOrigins
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);

  return allowedOrigins.includes(normalizedRequestOrigin)
    ? normalizedRequestOrigin
    : allowedOrigins[0] || "*";
}

function normalizeOrigin(origin) {
  return (origin || "").trim().replace(/\/+$/, "");
}
