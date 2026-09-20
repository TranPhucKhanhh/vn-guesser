import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MatchSession } from "../worker/worker.js";

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

test("match state reveals an answer once and rejects replay", async () => {
  const storage = new MemoryStorage();
  const session = new MatchSession({ storage });
  const now = Date.now();
  const match = {
    playerSubject: "auth0|player-1",
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

  const replay = await session.fetch(
    jsonRequest("/rounds/0/guess", "auth0|player-1", {
      guess: { lat: 10, lng: 100 }
    })
  );
  assert.equal(replay.status, 409);
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
