/**
 * The bot's first tests, and they are for the one piece of it that decides whether a job
 * survives a bad minute on the network.
 *
 * WHY HERE AND NOT ELSEWHERE. Almost everything else in this bot talks to a live game server
 * or to Steam, and a test of that is a test of somebody else's uptime. `postIngest` is the
 * opposite: pure control flow around an injected fetch, so every branch that matters (retry,
 * give up, do not retry, wait this long, abort at this point) can be pinned exactly.
 *
 * The fake fetch returns REAL Response objects on purpose. A hand-rolled stub with its own
 * json()/text() would not have caught the double-read bug that this module was written with:
 * a body can only be consumed once, so calling res.json() and falling back to res.text()
 * loses the error page exactly when it is the only clue.
 *
 * Run with: npm test  (node --test, no dependencies)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// The module reads config at call time, and config reads the environment. Set both BEFORE the
// import so the real .env (which has the owner's live ingest token) can never be the thing
// under test: config's loader leaves an existing process.env value alone.
process.env.API_BASE = "https://api.test.invalid";
process.env.INGEST_TOKEN = "test-token";

const { postIngest, postIngestBinary, getJson, jsonObject, retryableStatus, describeFailure } =
  await import("../src/http.ts");

/** One recorded call to the fake fetch. */
interface Call {
  url: string;
  init: RequestInit;
  /** Whether the signal handed to THIS attempt was already aborted when the call was made. */
  abortedOnEntry: boolean;
}

/**
 * A fetch that plays a script: each entry is either a Response to return or an Error to throw.
 * Everything the tests assert about (urls, headers, bodies, signals) is recorded.
 */
function fakeFetch(script: Array<Response | Error | (() => Response | Error)>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal | undefined;
    calls.push({ url: String(url), init, abortedOnEntry: signal?.aborted ?? false });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    const value = typeof step === "function" ? step() : step;
    if (value instanceof Error) throw value;
    // A body can be read once. The script may repeat its last entry, so hand back a clone and
    // never touch the original, or the second attempt would fail on an exhausted stream.
    return value.clone();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A sleep that records what it was asked to wait for and returns at once. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, impl: async (ms: number) => void waits.push(ms) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A fetch that never answers, exactly like the request that failed the poll on 2026-08-10:
 * it neither resolved nor errored, it just sat there until something else gave up.
 *
 * The already-aborted check at the top is not decoration. Without it, a regression that shares
 * one AbortController across attempts makes this HANG rather than fail, because the listener is
 * registered on a signal that has already fired: the suite would wedge instead of going red,
 * which in CI is a twenty-minute job timeout and a misleading alert.
 */
const hangUntilAborted = (async (_url: string, init: RequestInit = {}) => {
  const signal = init.signal as AbortSignal;
  const aborted = () => {
    const e = new Error("This operation was aborted");
    e.name = "AbortError";
    return e;
  };
  if (signal.aborted) throw aborted();
  return await new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(aborted()));
  });
}) as unknown as typeof fetch;

test("a first-try success reports one attempt and the parsed body", async () => {
  const f = fakeFetch([json({ ok: true, written: 3 })]);
  const s = fakeSleep();
  const r = await postIngest("/api/ingest/worlds", { worlds: [] }, { fetchImpl: f.impl, sleepImpl: s.impl });

  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.attempts, 1);
  assert.deepEqual(r.body, { ok: true, written: 3 });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(s.waits, [], "a success must not wait for anything");
});

test("the request carries the bearer token, the JSON content type and the configured base", async () => {
  const f = fakeFetch([json({})]);
  await postIngest("/api/ingest/worlds", { a: 1 }, { fetchImpl: f.impl, sleepImpl: fakeSleep().impl });

  const { url, init } = f.calls[0];
  assert.equal(url, "https://api.test.invalid/api/ingest/worlds");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer test-token");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(init.body, JSON.stringify({ a: 1 }));
});

test("a transport failure is retried and the recovery is reported in the attempt count", async () => {
  const f = fakeFetch([new Error("socket hang up"), json({ ok: true })]);
  const s = fakeSleep();
  const r = await postIngest("/x", {}, { fetchImpl: f.impl, sleepImpl: s.impl, onRetry: () => {} });

  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(r.error, undefined, "a recovered call must not carry the earlier error");
  assert.deepEqual(s.waits, [1_000]);
});

test("every attempt gets a FRESH AbortController", { timeout: 5_000 }, async () => {
  // The bug this pins: an AbortController that has fired stays fired. Reusing one across
  // attempts aborts every retry the instant it is created, so the retry loop would look
  // present and do nothing.
  //
  // The first two attempts must be REAL timeouts, not fakes that reject at once. With a fake
  // that settles immediately no controller is ever aborted, so `abortedOnEntry` would read
  // false even with one shared controller and this test would pass while the bug was present.
  const seen: Array<{ aborted: boolean; signal: unknown }> = [];
  let calls = 0;
  const impl = (async (_url: string, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal;
    seen.push({ aborted: signal.aborted, signal });
    if (++calls <= 2) return hangUntilAborted(_url as never, init as never);
    return json({ ok: true });
  }) as unknown as typeof fetch;

  const r = await postIngest("/x", {}, {
    timeoutMs: 20, fetchImpl: impl, sleepImpl: fakeSleep().impl, onRetry: () => {},
  });

  assert.equal(r.ok, true);
  assert.equal(seen.length, 3);
  for (const [i, c] of seen.entries()) {
    assert.equal(c.aborted, false, `attempt ${i + 1} was handed an already-aborted signal`);
  }
  assert.equal(new Set(seen.map((c) => c.signal)).size, 3, "each attempt must have its own signal");
});

test("giving up returns the last transport error rather than throwing", async () => {
  const f = fakeFetch([new Error("ECONNRESET")]);
  const s = fakeSleep();
  const r = await postIngest("/x", {}, { fetchImpl: f.impl, sleepImpl: s.impl, onRetry: () => {} });

  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.attempts, 3);
  assert.match(r.error ?? "", /ECONNRESET/);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(s.waits, [1_000, 3_000], "the default backoff, in order");
});

test("a 500 is retried; a 401 and a 400 are not", async () => {
  const retried = fakeFetch([json({ detail: "boom" }, 500), json({ ok: true })]);
  const r1 = await postIngest("/x", {}, { fetchImpl: retried.impl, sleepImpl: fakeSleep().impl, onRetry: () => {} });
  assert.equal(r1.ok, true);
  assert.equal(r1.attempts, 2);

  for (const status of [400, 401, 403, 404, 422]) {
    const f = fakeFetch([json({ detail: "no" }, status)]);
    const r = await postIngest("/x", {}, { fetchImpl: f.impl, sleepImpl: fakeSleep().impl });
    assert.equal(r.ok, false);
    assert.equal(r.status, status);
    assert.equal(f.calls.length, 1, `HTTP ${status} must not be retried`);
  }
});

test("429 and 408 are retried: the server said not now, not no", async () => {
  for (const status of [408, 425, 429, 502, 503]) {
    const f = fakeFetch([json({}, status), json({ ok: true })]);
    const r = await postIngest("/x", {}, { fetchImpl: f.impl, sleepImpl: fakeSleep().impl, onRetry: () => {} });
    assert.equal(r.ok, true, `HTTP ${status} should have been retried`);
    assert.equal(f.calls.length, 2);
  }
});

test("507 is NOT retried even though it is a 5xx: the storage cap is a decision", async () => {
  const f = fakeFetch([json({ detail: "cap reached" }, 507)]);
  const r = await postIngest("/x", {}, { fetchImpl: f.impl, sleepImpl: fakeSleep().impl });

  assert.equal(r.ok, false);
  assert.equal(r.status, 507);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(r.body, { detail: "cap reached" });
  assert.equal(retryableStatus(507), false);
});

test("attempts: 1 disables retrying without disabling anything else", async () => {
  const f = fakeFetch([json({}, 503)]);
  const s = fakeSleep();
  const r = await postIngest("/api/ingest/map/run", { action: "start" }, {
    attempts: 1, fetchImpl: f.impl, sleepImpl: s.impl,
  });

  assert.equal(f.calls.length, 1, "the run-start INSERT must never be repeated");
  assert.equal(r.attempts, 1);
  assert.deepEqual(s.waits, []);
});

test("the backoff repeats its last value when the attempts outrun it", async () => {
  const f = fakeFetch([new Error("nope")]);
  const s = fakeSleep();
  await postIngest("/x", {}, {
    attempts: 5, backoffMs: [10, 20], fetchImpl: f.impl, sleepImpl: s.impl, onRetry: () => {},
  });
  assert.deepEqual(s.waits, [10, 20, 20, 20]);
});

test("a custom retryStatus can add a status back: the beacons deploy race on 404", async () => {
  const f = fakeFetch([json({}, 404), json({ rows: 7 })]);
  const r = await postIngest("/api/ingest/beacons", {}, {
    fetchImpl: f.impl, sleepImpl: fakeSleep().impl, onRetry: () => {},
    retryStatus: (s) => s === 404 || retryableStatus(s),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { rows: 7 });
});

test("onRetry is told which attempt failed, why, and how long the wait is", async () => {
  const seen: Array<[number, string, number]> = [];
  const f = fakeFetch([json({ detail: "later" }, 503), new Error("reset"), json({ ok: true })]);
  await postIngest("/x", {}, {
    fetchImpl: f.impl, sleepImpl: fakeSleep().impl,
    onRetry: (attempt, reason, waitMs) => seen.push([attempt, reason, waitMs]),
  });

  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], 1);
  assert.match(seen[0][1], /HTTP 503/);
  assert.equal(seen[0][2], 1_000);
  assert.equal(seen[1][0], 2);
  assert.match(seen[1][1], /reset/);
  assert.equal(seen[1][2], 3_000);
});

test("a non-JSON body survives as text, and an empty body as null", async () => {
  const f = fakeFetch([new Response("<html>gateway</html>", { status: 400 })]);
  const r = await postIngest("/x", {}, { fetchImpl: f.impl, sleepImpl: fakeSleep().impl });
  assert.equal(r.body, "<html>gateway</html>");
  assert.match(describeFailure(r), /HTTP 400: <html>/);

  const empty = fakeFetch([new Response(null, { status: 204 })]);
  const r2 = await postIngest("/x", {}, { fetchImpl: empty.impl, sleepImpl: fakeSleep().impl });
  assert.equal(r2.ok, true);
  assert.equal(r2.body, null);
});

test("the timeout aborts a hung request, and the next attempt still runs", { timeout: 5_000 }, async () => {
  const hang = hangUntilAborted;

  let calls = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls++;
    if (calls === 1) return hang(url, init);
    return json({ ok: true });
  }) as unknown as typeof fetch;

  const r = await postIngest("/x", {}, {
    timeoutMs: 20, fetchImpl: impl, sleepImpl: fakeSleep().impl, onRetry: () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(calls, 2);
});

test("a hang that outlives every attempt ends as an aborted transport failure", { timeout: 5_000 }, async () => {
  const r = await postIngest("/x", {}, {
    attempts: 2, timeoutMs: 15, fetchImpl: hangUntilAborted, sleepImpl: fakeSleep().impl, onRetry: () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.attempts, 2);
  assert.match(r.error ?? "", /AbortError/);
});

test("a binary post keeps its own content type and sends the same bytes on a retry", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const f = fakeFetch([json({}, 500), json({ ok: true })]);
  const r = await postIngestBinary("/api/ingest/map/blob?world=1&variant=full", png, "image/png", {
    fetchImpl: f.impl, sleepImpl: fakeSleep().impl, onRetry: () => {},
  });

  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.equal((c.init.headers as Record<string, string>)["content-type"], "image/png");
    assert.deepEqual(c.init.body, png, "the retry must send the identical bytes");
  }
});

test("describeFailure prefers the transport error and trims a long body", async () => {
  assert.equal(
    describeFailure({ ok: false, status: 0, body: null, attempts: 3, error: "AbortError: timed out" }),
    "AbortError: timed out",
  );
  const long = "x".repeat(500);
  const d = describeFailure({ ok: false, status: 500, body: long, attempts: 1 });
  assert.equal(d.length, "HTTP 500: ".length + 200);
  assert.equal(describeFailure({ ok: false, status: 404, body: null, attempts: 1 }), "HTTP 404");
});

test("getJson resolves a root-relative path against the configured base and retries", async () => {
  const f = fakeFetch([json({}, 503), json({ results: [{ id: 1 }] })]);
  const out = await getJson<{ results: { id: number }[] }>("/api/v2/worlds?limit=500", {
    fetchImpl: f.impl, sleepImpl: fakeSleep().impl, onRetry: () => {},
  });

  assert.deepEqual(out, { results: [{ id: 1 }] });
  assert.equal(f.calls[0].url, "https://api.test.invalid/api/v2/worlds?limit=500");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls.length, 2);
});

test("getJson may be given an absolute URL, and sends no credentials to it", async () => {
  // The shopping job reads the site's static catalogue, which is a different host. That is
  // only safe because a GET carries no token: the POST helpers refuse absolute URLs entirely.
  const f = fakeFetch([json([{ game_id: 9 }])]);
  const out = await getJson<{ game_id: number }[]>("https://elsewhere.test/data/items.json", {
    fetchImpl: f.impl, sleepImpl: fakeSleep().impl,
  });

  assert.deepEqual(out, [{ game_id: 9 }]);
  assert.equal(f.calls[0].url, "https://elsewhere.test/data/items.json");
  const headers = f.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, undefined, "a GET must never carry the ingest token");
});

test("getJson throws when it finally gives up, with the status in the message", async () => {
  await assert.rejects(
    () => getJson("/api/v2/worlds", { attempts: 2, fetchImpl: fakeFetch([json({}, 500)]).impl, sleepImpl: fakeSleep().impl, onRetry: () => {} }),
    /GET https:\/\/api\.test\.invalid\/api\/v2\/worlds -> HTTP 500/,
  );
});

test("the POST helpers refuse an absolute URL, so the token cannot leave our API", async () => {
  const f = fakeFetch([json({})]);
  await assert.rejects(
    () => postIngest("https://evil.test/collect", { secret: true }, { fetchImpl: f.impl }),
    /root-relative/,
  );
  await assert.rejects(
    () => postIngestBinary("https://evil.test/collect", new Uint8Array([1]), "image/png", { fetchImpl: f.impl }),
    /root-relative/,
  );
  assert.equal(f.calls.length, 0, "nothing may be sent at all");
});

test("a NaN attempt count falls back to the default instead of sending nothing", async () => {
  // Math.max(1, Math.floor(NaN)) is NaN and `attempt <= NaN` is false, so the loop body never
  // ran: the ingest was skipped in silence and reported as a failure that never left the process.
  const f = fakeFetch([json({ ok: true })]);
  const r = await postIngest("/x", {}, {
    attempts: Number("not a number"), fetchImpl: f.impl, sleepImpl: fakeSleep().impl,
  });

  assert.equal(f.calls.length, 1, "something must actually be sent");
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
});

test("an EXPLICIT empty backoff means retry at once, not the default wait", async () => {
  const s = fakeSleep();
  await postIngest("/x", {}, {
    attempts: 3, backoffMs: [], fetchImpl: fakeFetch([new Error("nope")]).impl,
    sleepImpl: s.impl, onRetry: () => {},
  });
  assert.deepEqual(s.waits, [0, 0], "an empty array is a request, not an absence");
});

test("getJson refuses a 200 that is not JSON instead of casting it to T", async () => {
  await assert.rejects(
    () => getJson("/api/v2/worlds", {
      fetchImpl: fakeFetch([new Response("<!doctype html><h1>502</h1>", { status: 200 })]).impl,
      sleepImpl: fakeSleep().impl,
    }),
    /with a string, not JSON/,
  );
  await assert.rejects(
    () => getJson("/api/v2/worlds", {
      fetchImpl: fakeFetch([new Response(null, { status: 204 })]).impl,
      sleepImpl: fakeSleep().impl,
    }),
    /with an empty body, not JSON/,
  );
});

test("jsonObject separates an unreadable answer from an empty one", async () => {
  // The distinction the callers need: `(res.body ?? {}) as T` turns a 200 carrying an error
  // page into an object whose every field is undefined, so "we could not read the answer" and
  // "the answer was nothing to report" become the same silence.
  const okObject = await postIngest("/x", {}, {
    fetchImpl: fakeFetch([json({ pruned: [1, 2] })]).impl, sleepImpl: fakeSleep().impl,
  });
  assert.deepEqual(jsonObject<{ pruned: number[] }>(okObject), { pruned: [1, 2] });

  const okHtml = await postIngest("/x", {}, {
    fetchImpl: fakeFetch([new Response("<h1>502</h1>", { status: 200 })]).impl,
    sleepImpl: fakeSleep().impl,
  });
  assert.equal(okHtml.ok, true);
  assert.equal(jsonObject(okHtml), null, "a 200 we cannot parse is not an empty result");

  const empty = await postIngest("/x", {}, {
    fetchImpl: fakeFetch([new Response(null, { status: 204 })]).impl, sleepImpl: fakeSleep().impl,
  });
  assert.equal(jsonObject(empty), null);

  const failed = await postIngest("/x", {}, {
    fetchImpl: fakeFetch([json({ detail: "no" }, 400)]).impl, sleepImpl: fakeSleep().impl,
  });
  assert.equal(jsonObject(failed), null, "a failed call has no answer to read, whatever it sent");
});

test("retryableStatus draws the line where the comments say it does", () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504, 599]) assert.equal(retryableStatus(s), true, `${s}`);
  for (const s of [200, 201, 400, 401, 403, 404, 409, 422, 507]) assert.equal(retryableStatus(s), false, `${s}`);
});
