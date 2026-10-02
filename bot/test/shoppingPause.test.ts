/**
 * The shopping sweep stopping on the API's D1-budget refusal, and only on that.
 *
 * WHY THIS FILE EXISTS. Since 2026-10-02 the Worker answers a capture chunk with 507 and
 * `budget: true` once the account has read 97% of its daily D1 allowance. The sweep used to
 * treat any failed chunk as a blip: keep the data buffered, try again in a minute, carry on
 * scanning. Against a budget refusal that is the worst possible reaction, because every later
 * chunk is refused the same way until 00:00 UTC, so the lanes would keep asking the game
 * servers for an hour's worth of data that nobody can store. The pause has to stop every lane,
 * and a normal sweep must be left exactly as it was.
 *
 * The game servers and our API are both faked through the global fetch, which is what the
 * engine and the HTTP helper call; nothing here reaches the network.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Before the import: config reads some of these when the module loads, and an existing value
// always wins over the bot's own .env, which holds live keys.
process.env.API_BASE = "https://api.test.invalid";
process.env.INGEST_TOKEN = "test-token";
process.env.BOUNDLESS_API_KEY = "test-key";
process.env.SHOP_WORLD_CONCURRENCY = "2";
process.env.SHOP_PACE_MS = "0";
process.env.SHOP_TIME_BUDGET_MS = String(10 * 60 * 1000);

const { captureShopping } = await import("../src/shopping.ts");

/** Game servers answer "no shops here" to everything; our API answers with `ingest()`. */
function install(ingest: () => Response) {
  const calls = { game: 0, ingest: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith("https://api.test.invalid/")) {
      calls.ingest++;
      return ingest();
    }
    calls.game++;
    return new Response(new Uint8Array(0), { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

const worlds = [1, 2, 3].map((id) => ({ id, apiUrl: `https://w${id}.test`, name: `W${id}` }));
// 250 items x 2 shop types = 500 units a world, so each world fills a 200-key chunk early.
const itemIds = Array.from({ length: 250 }, (_, i) => i + 1);
const UNITS = worlds.length * itemIds.length * 2;

test("a budget refusal stops every lane, posts nothing after it, and is not an ingest failure", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const f = install(() => Response.json({ detail: "D1 daily budget nearly used", budget: true }, { status: 507 }));
  try {
    const stats = await captureShopping({ mode: "full", worlds, itemIds });
    assert.equal(stats.paused, true);
    assert.ok(f.calls.ingest <= 2, `at most one refused chunk per lane, got ${f.calls.ingest}`);
    assert.ok(f.calls.game < UNITS / 2, `the lanes stopped early, but ${f.calls.game} of ${UNITS} units were asked for`);
    assert.ok(stats.unsent >= 200, "what was verified but never written is reported");
    assert.equal(stats.ingestErrors, 0);
  } finally {
    f.restore();
  }
});

test("without a refusal the same sweep runs to the end and writes everything", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const f = install(() => Response.json({ inserted: 0, updated: 0, deleted: 0 }));
  try {
    const stats = await captureShopping({ mode: "full", worlds, itemIds });
    assert.equal(stats.paused, false);
    assert.equal(stats.unsent, 0);
    assert.equal(stats.itemsDone, UNITS);
    assert.equal(f.calls.game, UNITS);
    assert.ok(f.calls.ingest >= worlds.length);
  } finally {
    f.restore();
  }
});

test("an ordinary ingest failure is still a blip: the sweep carries on and keeps the data", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const f = install(() => Response.json({ detail: "storage limit reached" }, { status: 507 }));
  try {
    const stats = await captureShopping({ mode: "full", worlds, itemIds });
    assert.equal(stats.paused, false, "only the budget refusal pauses");
    assert.equal(f.calls.game, UNITS);
    assert.ok(stats.ingestErrors > 0);
  } finally {
    f.restore();
  }
});
