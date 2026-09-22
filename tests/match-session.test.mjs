import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LeaderboardStore, MatchSession } from "../worker/worker.js";

class MemoryStorage {
  values = new Map();
  alarm = null;

  async get(key) {
    return structuredClone(this.values.get(key));
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(timestamp) {
    this.alarm = timestamp;
  }

  async deleteAll() {
    this.values.clear();
  }
}

function jsonRequest(path, subject, body = {}) {
  return new Request(`https://match.internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(subject ? { "x-player-sub": subject } : {})
    },
    body: JSON.stringify(body)
  });
}

class MemoryBucket {
  objects = new Map();

  async get(key) {
    const value = this.objects.get(key);
    if (!value) return null;
    return { json: async () => structuredClone(value) };
  }

  async put(key, value) {
    this.objects.set(key, JSON.parse(value));
  }
}

function leaderboardRequest(path, method = "GET", body) {
  return new Request(`https://leaderboard.internal${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
}

test("match state reveals an answer once and rejects replay", async () => {
  const storage = new MemoryStorage();
  const session = new MatchSession({ storage });
  const now = Date.now();
  const match = {
    playerSubject: "auth0|player-1",
    profileId: "0123456789abcdef01234567",
    playerName: "Test Player",
    createdAt: now,
    expiresAt: now + 60_000,
    startedAt: null,
    currentRoundIndex: 0,
    totalScore: 0,
    rounds: [
      {
        assetId: "testasset0000001",
        title: "Test Location",
        province: "Test Province",
        lat: 10,
        lng: 100,
        images: { "1280": "private/a.webp", "1920": "private/b.webp" }
      }
    ]
  };

  const initialized = await session.fetch(jsonRequest("/init", null, match));
  assert.equal(initialized.status, 200);

  const ready = await session.fetch(jsonRequest("/ready", "auth0|player-1"));
  assert.equal(ready.status, 200);

  const guessed = await session.fetch(
    jsonRequest("/rounds/0/guess", "auth0|player-1", {
      guess: { lat: 10, lng: 100 }
    })
  );
  const result = await guessed.json();
  assert.equal(guessed.status, 200);
  assert.equal(result.result.title, "Test Location");
  assert.equal(result.result.roundScore, 5000);
  assert.equal(result.finished, true);
  assert.equal(result.completion.profileId, "0123456789abcdef01234567");
  assert.equal(result.completion.points, 5000);

  const replay = await session.fetch(
    jsonRequest("/rounds/0/guess", "auth0|player-1", {
      guess: { lat: 10, lng: 100 }
    })
  );
  assert.equal(replay.status, 409);
});

test("leaderboard sorts by points then time and stores its R2 snapshot", async () => {
  const storage = new MemoryStorage();
  const bucket = new MemoryBucket();
  const leaderboard = new LeaderboardStore(
    { storage },
    { DATA_BUCKET: bucket, STANDARD_LEADERBOARD_KEY: "leaderboard/standard_mode/entries.json" }
  );
  const completedAt = Date.now();
  const results = [
    {
      profileId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      playerName: "An",
      points: 12000,
      timeMs: 90000,
      completedAt
    },
    {
      profileId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      playerName: "Binh",
      points: 15000,
      timeMs: 120000,
      completedAt
    },
    {
      profileId: "cccccccccccccccccccccccc",
      playerName: "Chi",
      points: 15000,
      timeMs: 80000,
      completedAt
    }
  ];

  for (const result of results) {
    const response = await leaderboard.fetch(leaderboardRequest("/record", "POST", result));
    assert.equal(response.status, 200);
  }

  const response = await leaderboard.fetch(leaderboardRequest("/entries"));
  const payload = await response.json();
  assert.deepEqual(
    payload.snapshot.entries.map((entry) => entry.name),
    ["Chi", "Binh", "An"]
  );
  assert.equal(
    bucket.objects.get("leaderboard/standard_mode/entries.json").entries[0].name,
    "Chi"
  );
});

test("match state rejects another Auth0 subject", async () => {
  const storage = new MemoryStorage();
  const session = new MatchSession({ storage });
  const now = Date.now();
  await session.fetch(
    jsonRequest("/init", null, {
      playerSubject: "auth0|owner",
      createdAt: now,
      expiresAt: now + 60_000,
      startedAt: null,
      currentRoundIndex: 0,
      totalScore: 0,
      rounds: [{ title: "Hidden" }]
    })
  );

  const response = await session.fetch(jsonRequest("/ready", "auth0|other"));
  assert.equal(response.status, 403);
});

test("public frontend contains no answer catalog", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

  assert.doesNotMatch(html, /locations\.js/);
  assert.doesNotMatch(app, /GEOGUESSER_ROUNDS/);
  assert.doesNotMatch(app, /haversineDistance/);
});
