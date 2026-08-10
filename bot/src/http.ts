/**
 * Talking to our own API, once, properly.
 *
 * WHY THIS EXISTS. Every job in this bot ends the same way: it spends minutes gathering
 * something (a frontier scan, a colour capture, a distance sweep) and then POSTs the result to
 * the Worker. Until this module each of those POSTs was a bare `fetch` with no retry, so a
 * single transient blip threw away the whole run's work, failed the job and sent an alert.
 * Two of them (colours, distances) had no timeout at all, so a hung connection could only end
 * when the workflow's own clock ran out.
 *
 * That was survivable while the Worker only touched KV, which is why it went unnoticed for
 * months: KV writes are fast and the endpoint answered in about a second. The world history
 * moved to D1 and the shape of the tail changed. Measured on 2026-08-10 across the poll job:
 * seven runs answered in 0.42 to 0.72 seconds and one took longer than the client's eight-second
 * timeout, a sixteen-fold outlier on a payload of five worlds. Nothing was wrong with the
 * request; it simply hung. One run in seventy-seven, and it cost a whole cycle and a
 * notification, because the last call of the job was the only one in the workflow with no
 * retry: the discovery fetch has "curl --retry 3" and the install has three attempts.
 *
 * RETRYING IS SAFE HERE, AND THAT IS NOT AN ASSUMPTION. Every ingest endpoint on the Worker
 * upserts by id: worlds merge field-wise into the hot blob, departures upsert on world_id,
 * colours upsert on (world, block, colour), distances and beacons replace by key, a shopping
 * chunk deletes exactly the keys it re-verifies. Posting the same body twice therefore lands
 * the same state as posting it once. That matters most in the case this module exists for,
 * because a request that times out on the CLIENT may well have been applied on the server:
 * with an idempotent endpoint the retry is a no-op rather than a duplicate.
 *
 * THE ONE EXCEPTION is "action: start" on the three run-audit endpoints, which INSERTs a row
 * and hands back its id. Retrying that can leave a second row that nobody will ever close, so
 * those calls pass attempts: 1 and keep only the timeout. They are bookkeeping: a missing
 * audit row is a smaller lie than a duplicate one, and neither is worth a retry.
 *
 * WHAT IS NOT RETRIED. A 4xx other than the three below is an answer, not a failure: 401 means
 * the token is wrong and 400 means the body is. Repeating those three times only delays an
 * honest failure by a few seconds and buries the real cause under two more log lines.
 */

import { config } from "./config.ts";

/** What a POST to our own API ended up doing. */
export interface PostResult {
  ok: boolean;
  /** HTTP status, or 0 when no response was ever received. */
  status: number;
  /** Parsed JSON when the response was JSON, the raw text when it was not, null when empty. */
  body: unknown;
  /** How many attempts it took, so a job can log that it recovered rather than sailing on. */
  attempts: number;
  /** Set when the final attempt failed at the transport level (timeout, DNS, reset). */
  error?: string;
}

export interface PostOptions {
  /** Total attempts, the first one included. 1 disables retrying without disabling the timeout. */
  attempts?: number;
  /** Per-attempt timeout. Generous by default: see the note on the default below. */
  timeoutMs?: number;
  /** Waits between attempts, in order. The last value repeats if attempts outrun it. */
  backoffMs?: number[];
  /** Which HTTP statuses are worth another attempt. Defaults to `retryableStatus`. */
  retryStatus?: (status: number) => boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Somewhere to report a retry. Defaults to console.warn; tests pass their own. */
  onRetry?: (attempt: number, reason: string, waitMs: number) => void;
}

/*
  TWENTY SECONDS, not the eight the rest of the bot uses, and the difference is deliberate.

  `config.requestTimeoutMs` is tuned for the per-world probes of the frontier scan, where a slow
  world must be abandoned quickly so the sweep can go on: there, giving up fast is the right
  behaviour and there are hundreds of calls. This is the opposite situation. It is ONE call, it
  carries the entire result of a job that has already run for minutes, and there is nothing after
  it. Waiting twenty seconds for it costs nothing anybody notices; abandoning it at eight throws
  the work away. The measured server side of this call is around half a second, so the timeout is
  not a performance budget, it is the point at which we conclude the connection is dead.
*/
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [1_000, 3_000];

/**
 * Statuses worth trying again: the server said "not now" rather than "no".
 *
 * 507 is deliberately excluded even though it is a 5xx. It is the map ingest saying the storage
 * cap is reached, which is a decision, not a hiccup: posting the same image again cannot make
 * room, and the caller turns it into a MapCapError that stops the run on purpose.
 */
export function retryableStatus(status: number): boolean {
  if (status === 507) return false;
  // 408 request timeout, 425 too early, 429 rate limited, and anything the server broke on.
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The parsed JSON object of a successful call, or null when there is not one.
 *
 * Callers used to write `(res.body ?? {}) as Something`, which silently turns a 200 carrying an
 * error page into an empty result: every field reads undefined and the code takes the "nothing
 * to report" branch. That is the exact silence this module exists to remove, so the two states
 * are separated here and each caller decides what a missing body means to it.
 */
export function jsonObject<T>(r: PostResult): T | null {
  return r.ok && r.body !== null && typeof r.body === "object" ? (r.body as T) : null;
}

/** Body text as far as it is worth putting in a log line. */
export function describeFailure(r: PostResult): string {
  if (r.error) return r.error;
  // An absent body must read as `HTTP 404`, not `HTTP 404: ""`. JSON.stringify(null ?? "")
  // is the string '""', which is perfectly truthy and was being appended.
  if (r.body === null || r.body === undefined) return `HTTP ${r.status}`;
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return body ? `HTTP ${r.status}: ${body.slice(0, 200)}` : `HTTP ${r.status}`;
}

/**
 * One request, with a timeout, retried within the bounds the caller set.
 *
 * Returns a result rather than throwing, because every caller wants to decide for itself
 * whether a failed ingest should fail its job, and because a thrown transport error was exactly
 * what used to turn a network blip into a dead run. The only things that reach a caller as an
 * exception are a malformed path and a missing INGEST_TOKEN, both of which are bugs, not weather.
 */
async function request(
  method: "GET" | "POST",
  /** Fully resolved by the wrappers below, so only they decide what host a token can reach. */
  url: string,
  // Only what can be sent MORE THAN ONCE. A stream cannot, and typing this as the wider
  // BodyInit would quietly allow one, which is precisely the bug a retry loop must not have.
  payload: string | Uint8Array | undefined,
  headers: Record<string, string>,
  opts: PostOptions,
): Promise<PostResult> {
  // Number.isFinite first: Math.max(1, Math.floor(NaN)) is NaN, and `attempt <= NaN` is false,
  // so a NaN here would skip the loop entirely and report a failure that never left the process.
  const wanted = Math.floor(opts.attempts ?? DEFAULT_ATTEMPTS);
  const attempts = Number.isFinite(wanted) ? Math.max(1, wanted) : DEFAULT_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // An EXPLICIT empty array means "retry with no wait", which is not the same as passing
  // nothing; only an absent option takes the default. This is what makes the `?? 0` below live.
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const shouldRetry = opts.retryStatus ?? retryableStatus;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const onRetry =
    opts.onRetry ??
    ((attempt, reason, waitMs) =>
      console.warn(`[http] ${url} attempt ${attempt} failed (${reason}); retrying in ${waitMs}ms`));

  let last: PostResult = { ok: false, status: 0, body: null, attempts: 0, error: "not attempted" };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A fresh controller per attempt: an AbortController that has already fired stays fired, so
    // reusing one would abort every retry the instant it was created.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { method, headers, body: payload, signal: controller.signal });
      // Read the body ONCE. Calling res.json() and falling back to res.text() cannot work: the
      // first read consumes the stream, so the fallback throws and the error body is lost
      // exactly when it is the only clue about what went wrong.
      const text = await res.text();
      let parsed: unknown = text.length ? text : null;
      if (text.length) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON: keep the text, it is usually an error page or a plain message */
        }
      }
      last = { ok: res.ok, status: res.status, body: parsed, attempts: attempt };
      if (res.ok || !shouldRetry(res.status)) return last;
    } catch (e) {
      // Transport: DNS, reset, a truncated body, or our own timeout firing. The timeout covers
      // reading the body too, which is the point: a response that stops half way is not a
      // success, and the retry is safe because the endpoint is idempotent.
      last = {
        ok: false,
        status: 0,
        body: null,
        attempts: attempt,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      };
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts) {
      const waitMs = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;
      onRetry(attempt, describeFailure(last), waitMs);
      await sleep(waitMs);
    }
  }
  return last;
}

/**
 * Our own API, and nothing else, may be given the ingest token.
 *
 * The POST helpers take a root-relative path for exactly this reason: an absolute URL here
 * would be a bearer token pointed at whatever host the caller passed. The GET helper is free
 * to take one, because it sends no credentials.
 */
function ingestUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`ingest path must be root-relative, got "${path}"`);
  }
  return `${config.apiBase}${path}`;
}

/** POST a JSON body to our own API. See `request`. */
export async function postIngest(path: string, body: unknown, opts: PostOptions = {}): Promise<PostResult> {
  return request(
    "POST",
    ingestUrl(path),
    JSON.stringify(body),
    { authorization: `Bearer ${config.ingestToken}`, "content-type": "application/json" },
    opts,
  );
}

/**
 * POST a non-JSON body (today: one map PNG) to our own API.
 *
 * The payload has to be something that can be sent more than once, which a Uint8Array is and a
 * stream is not; that is why the signature refuses the latter.
 */
export async function postIngestBinary(
  path: string,
  body: Uint8Array,
  contentType: string,
  opts: PostOptions = {},
): Promise<PostResult> {
  return request(
    "POST",
    ingestUrl(path),
    body,
    { authorization: `Bearer ${config.ingestToken}`, "content-type": contentType },
    opts,
  );
}

/**
 * GET JSON from our own API, with the same timeout and retries, and throw when it fails.
 *
 * EVERY job starts by asking our API what to work on, and until this existed each of them did
 * it with a bare fetch through its own copy of this helper. A blip there killed the job before
 * it had done anything at all, which is the same defect as the ingest one and even easier to
 * hit: it is the first request after a cold start. Retrying a GET needs no argument at all.
 *
 * Throws rather than returning a result, unlike the POSTs: a job that cannot read its work
 * list has nothing to do, and every call site was already written around a throw.
 *
 * Takes a root-relative path OR an absolute URL: the shopping job also reads the site's static
 * data files, which live on another host. Safe here and not on the POSTs, because this sends
 * no credentials to anybody.
 */
export async function getJson<T>(pathOrUrl: string, opts: PostOptions = {}): Promise<T> {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : ingestUrl(pathOrUrl);
  const r = await request("GET", url, undefined, { accept: "application/json" }, {
    timeoutMs: 30_000,
    ...opts,
  });
  if (!r.ok) throw new Error(`GET ${url} -> ${describeFailure(r)}`);
  // A 200 carrying an error page or an empty body used to be cast straight to T, so the failure
  // surfaced a frame later as "Cannot read properties of null" at the call site. The four
  // helpers this replaced all threw here, and so does this one.
  if (r.body === null || typeof r.body !== "object") {
    const shape = r.body === null ? "an empty body" : `a ${typeof r.body}`;
    throw new Error(`GET ${url} -> HTTP ${r.status} with ${shape}, not JSON`);
  }
  return r.body as T;
}
