/**
 * Shopping capture: scrapes the official HTTP Shopping API (blessed key) per world and
 * ships the result to our ingest endpoint.
 *
 * Route (appended to each world's apiURL): `/shopping/{S|B}/{itemId}`
 *   S = shop stand    -> a player SELLS, so you can BUY from it
 *   B = request basket-> a player BUYS, so you can SELL to it
 * Auth: header `Boundless-API-Key`.
 *
 * RATE LIMITING, from `reference/boundless.docs/modding/http-shopping.rst`, which is the
 * contract this engine is built against. The docs state ONE rule and two reassurances,
 * quoted verbatim because earlier versions of this file paraphrased them into a design that
 * was wrong three different ways:
 *
 *   "this rate-limiting has only one rule that users should follow: Each API key is
 *    permitted to have 1 request in-flight that hits a given game server: any attempt to
 *    run concurrent requests will return 429 responses."
 *
 *   "rate-limiting is handled by the server queueing incoming responses so that your
 *    response simply takes longer to come back ... there is no need to handle delaying
 *    requests or retrying on the user-side."
 *
 *   "Responses will be returned up to a rate of 1 response per second for each api-key ...
 *    but you do not need to delay your next request."
 *
 * So the engine is shaped as: ONE SERIAL LANE PER WORLD (which satisfies the only rule by
 * construction, no timer involved), several lanes at once, and NO CLIENT-SIDE PACING,
 * because the server is the regulator and says so explicitly.
 *
 * WHERE THE DOCS ARE SILENT, we measured against the live servers (2026-07-29):
 *  - A cache miss is often SHED as a bare 403 (empty body, `cache-control: no-cache`).
 *    This status is not documented for the shopping route at all; on the beacons/lod0
 *    routes 403 means "bad key", so a run that sees ONLY 403s must abort as a key failure
 *    (circuit breaker below) rather than grind its budget out.
 *  - The shed is deterministic, not probabilistic: a cold (world,item) turned 200 after
 *    exactly 3 immediate retries in 12 cases out of 12. Retrying is what warms the cache.
 *    Once warm, the same query answers 200 back-to-back with no delay.
 *  - No shed response ever carried a `retry-after` header (0 of 44), so any client-side
 *    backoff for 403 would be invented, and an earlier version of this file lost ~70% of a
 *    run's wall clock to exactly that invention.
 *  - Sustained throughput, measured over 4 minutes (bursts lie; a 1.3s sample once said
 *    "18/sec" for what is really ~5/sec): ~0.87 verified (world,item,type) units per lane
 *    per second, ~2.6 requests per unit. That is EST_UNIT_MS below, and it prices a full
 *    pass (995 items x 2 types x 39 trading worlds ~ 78k units) at about three hours on
 *    eight lanes. BUTT, reading the same API, cycles its catalogue in 6.6 hours: same
 *    physics, more conservative settings.
 *
 * STATUS HANDLING, each per its documented meaning:
 *   200  parse; an EMPTY body is a valid "no shops here".
 *   403  undocumented cache-miss shed: up to 5 immediate retries, then the unit stays
 *        unverified. Never recorded as an absence.
 *   429  we broke the one-in-flight rule. With serial lanes this must never happen, so it
 *        is counted separately and logged loudly: it means a bug, not bad luck.
 *   503  the world is not in a serving state (starting, stopping, locked). Documented on
 *        the sibling routes as a WORLD condition, so the lane skips the world for this run
 *        instead of hammering the next item into the same wall.
 *   net  our side or the wire in between: two attempts with a short pause, then unverified.
 *
 * Robustness rules:
 *  - Every run is bounded by a wall-clock budget; leftovers are picked up next run, and the
 *    world order rotates between runs so a truncated tail is not always the same worlds.
 *  - Results are posted in chunks as we go, so a killed run keeps everything captured.
 *  - The ingest only deletes listings for keys it actually verified, so a partial sweep can
 *    never wipe unrelated data.
 *  - A run whose first 30 requests are ALL shed with zero 200s aborts as a key failure.
 */

import { config } from "./config.ts";

export type ShopType = "S" | "B";

export interface ShopListing {
  itemId: number;
  type: ShopType;
  beacon: string;
  guild: string;
  /** Price in cents, exactly as the game returns it. */
  price: number;
  count: number;
  patrons: number;
  x: number;
  y: number;
  z: number;
}

export interface CaptureWorld {
  id: number;
  apiUrl: string;
  name?: string | null;
}

export interface CaptureStats {
  requests: number;
  /** 200 responses. */
  ok: number;
  /** 403: cache-miss sheds (undocumented; retried in place). */
  shed: number;
  /** 503: world not in a serving state (documented; skips the world). */
  busy: number;
  /** 429: one-in-flight violations. Serial lanes make this impossible, so >0 means a bug. */
  overrate: number;
  /** Network / timeout failures on our side of the wire. */
  netErrors: number;
  listings: number;
  /** (world,item,type) units verified this run. */
  itemsDone: number;
  /** Units given up on (left unverified, never treated as absent). */
  errors: number;
  /** Ingest POST failures. Separate from `errors`: these units were verified, then the
   *  write failed; the data stays buffered and the next flush retries it. */
  ingestErrors: number;
  worldsDone: number;
  /** Worlds abandoned mid-run on a 503. */
  worldsSkipped: number;
  rowsWritten: number;
  truncated: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Decode one binary Shopping response. Records repeat until the buffer ends (there is no
 * count header). Layout, little-endian, matching the reference parser in the official docs:
 *   u8 nameLen, u8 tagLen, char[nameLen] beacon, char[tagLen] guild,
 *   u32 count, u32 patrons, i64 price_cents, i16 x, i16 z, u8 y
 * Strings are latin1 (as in the documented Python example), not UTF-8.
 */
export function parseShopping(buf: Buffer, itemId: number, type: ShopType): ShopListing[] {
  const out: ShopListing[] = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const nameLen = buf.readUInt8(o);
    const tagLen = buf.readUInt8(o + 1);
    // 21 fixed bytes follow the two length bytes; bail out on a truncated tail rather than
    // throwing, so one malformed record cannot lose the whole world's capture.
    if (o + 2 + nameLen + tagLen + 21 > buf.length) break;
    let p = o + 2;
    const beacon = buf.toString("latin1", p, p + nameLen);
    p += nameLen;
    const guild = buf.toString("latin1", p, p + tagLen);
    p += tagLen;
    const count = buf.readUInt32LE(p);
    p += 4;
    const patrons = buf.readUInt32LE(p);
    p += 4;
    const price = Number(buf.readBigInt64LE(p));
    p += 8;
    const x = buf.readInt16LE(p);
    p += 2;
    const z = buf.readInt16LE(p);
    p += 2;
    const y = buf.readUInt8(p);
    p += 1;
    out.push({ itemId, type, beacon, guild, price, count, patrons, x, y, z });
    o = p;
  }
  return out;
}

/** Thrown when the key itself is rejected: retrying would just hammer the servers. */
export class ShopKeyError extends Error {}

/**
 * Measured cost of verifying one (world,item,type) unit on one lane, wall-clock.
 *
 * From a 4-minute sustained run with no pacing (bursts overstate by 3-4x, so never re-derive
 * this from a short sample): ~0.87 units per lane per second, ~2.6 requests per unit. Used
 * only for PLANNING (run estimates, discovery window sizing); nothing delays on it.
 */
export const EST_UNIT_MS = 1150;

/** Immediate retries a shed (403) unit gets. Measured: a cold unit answers by the 3rd. */
const SHED_RETRIES = 5;

/**
 * How often a scheduled FULL pass starts, milliseconds.
 *
 * Eight hours: three passes a day, which is what `.github/workflows/shopping-full.yml`
 * schedules and what the D1 row-write allowance affords (the arithmetic lives in that file).
 * Used ONLY to advance the rotation offset below, so if that schedule ever changes this
 * constant has to change with it: too small an interval makes consecutive passes overlap
 * (harmless, just slower to lap), too large makes them skip a segment (not harmless).
 */
export const FULL_TURN_MS = 8 * 60 * 60 * 1000;

/**
 * How much of the affordable segment a FULL pass advances by, as a fraction.
 *
 * 0.9 leaves a tenth of a segment of overlap between consecutive passes. The segment size is
 * predicted from EST_UNIT_MS, and a pass that runs slower than that prediction (a burst of
 * sheds, a world that answers 503 late, a slow runner) covers less than predicted. Without
 * the overlap that shortfall is a hole in the ring that nothing ever comes back for, which is
 * precisely the failure this rotation exists to end.
 */
const FULL_STRIDE_OVERLAP = 0.9;

/** How a lane's single fetch resolved; drives what the worker does next. */
type FetchOutcome =
  | { kind: "ok"; listings: ShopListing[] }
  | { kind: "unverified" }
  | { kind: "world-busy" };

/**
 * Fetch one (world, item, type) unit on this world's serial lane.
 *
 * Each status is handled per its documented meaning (see the module header for the map and
 * for the measurements behind the retry counts). The one thing this function must never do
 * is guess: a unit it could not verify comes back `unverified`, which keeps it out of the
 * ingest's deletion pass, rather than being reported as "no shops".
 */
async function fetchListings(
  apiUrl: string,
  type: ShopType,
  itemId: number,
  key: string,
  stats: CaptureStats,
): Promise<FetchOutcome> {
  const url = `${apiUrl}/shopping/${type}/${itemId}`;
  let shedTries = 0;
  let netTries = 0;
  let overrateTries = 0;
  for (;;) {
    try {
      const res = await fetch(url, {
        headers: { "Boundless-API-Key": key, "accept-encoding": "gzip" },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      stats.requests++;
      if (res.status === 200) {
        stats.ok++;
        const buf = Buffer.from(await res.arrayBuffer());
        // An empty body is a valid answer meaning "no shops for this item here".
        return { kind: "ok", listings: buf.length === 0 ? [] : parseShopping(buf, itemId, type) };
      }
      if (res.status === 403) {
        // Cache-miss shed. Immediate retry is what warms the cache; no delay, because no
        // shed response has ever asked for one and the wait would be invented.
        stats.shed++;
        if (++shedTries <= SHED_RETRIES) continue;
        return { kind: "unverified" };
      }
      if (res.status === 503) {
        // The WORLD is not serving (starting, stopping, locked). Retrying the next item
        // into the same wall helps nobody: the caller drops the world for this run.
        stats.busy++;
        return { kind: "world-busy" };
      }
      if (res.status === 429) {
        // The documented penalty for a second in-flight request. Serial lanes make this
        // structurally impossible, so it is a bug indicator, not weather: say so, give the
        // server a beat, and move on. BOUNDED like every other path: an unbounded retry here
        // would trap the lane inside this call, where neither the wall-clock deadline nor the
        // circuit breaker can reach it (both live in the worker loop, which only regains
        // control when this function returns).
        stats.overrate++;
        console.warn(`  429 on ${url}: one-in-flight violated, this should be impossible`);
        if (++overrateTries >= 3) return { kind: "unverified" };
        await sleep(1000);
        continue;
      }
      // Anything else (invalid args, unexpected state): not verifiable, not retryable.
      return { kind: "unverified" };
    } catch {
      // Our side of the wire: timeout, DNS, socket. One measured pause, two chances.
      stats.netErrors++;
      if (++netTries >= 2) return { kind: "unverified" };
      await sleep(1000);
    }
  }
}

/** POST one chunk of a world's scan to the ingest endpoint. Returns rows written. */
async function postChunk(worldId: number, scanned: string[], listings: ShopListing[]): Promise<number> {
  if (scanned.length === 0) return 0;
  const res = await fetch(`${config.apiBase}/api/ingest/shopping`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ingestToken}`,
    },
    body: JSON.stringify({ worldId, scanned, listings }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { inserted?: number; updated?: number; deleted?: number };
  return (data.inserted ?? 0) + (data.updated ?? 0) + (data.deleted ?? 0);
}

/** Post at most this many scanned keys per ingest call (keeps request bodies modest). */
const POST_CHUNK = 200;

/** Per-world buffer of verified results, flushed to the ingest in chunks. */
interface WorldBuffer {
  world: CaptureWorld;
  scanned: string[];
  listings: ShopListing[];
  /** Set after a failed ingest POST: no re-attempt before this time. Without it, a downed
   *  ingest turns every over-threshold unit into a fresh 30s-timeout POST and stalls the
   *  lane; with it, the data waits quietly and the next due flush retries. */
  retryAfter?: number;
  /** The in-flight flush of this buffer, if any. Guarantees single flight per buffer: the
   *  owner's POST_CHUNK trigger and another worker's clock sweep can otherwise flush the
   *  same buffer concurrently, and the slower one's stale-snapshot splice would clamp onto
   *  units pushed after the faster one drained, discarding them unsent. */
  busy?: Promise<void>;
}

export interface CaptureOptions {
  mode: "hot" | "discover" | "full";
  worlds: CaptureWorld[];
  /** Full catalogue of item game ids (used by discover/full). */
  itemIds: number[];
  /** Active (world -> {S,B} item ids) from our API, used by the "hot" mode. */
  active?: Record<string, { S: number[]; B: number[] }>;
  shard?: number;
  shards?: number;
  /**
   * Item ids ordered by how much they actually trade, busiest first. Discovery walks this
   * order rather than an arbitrary one; see buildWork for why that matters so much.
   */
  priority?: number[];
  /** How many items one discovery run walks. See config.shopDiscoverWindow. */
  window?: number;
  /** Never-yet-trading worlds to probe per run, on top of every world known to trade. */
  exploreColdWorlds?: number;
  /** Item ids already known to have listings somewhere. Discovery hunts the ones that are not. */
  knownItems?: Set<number>;
}

/**
 * Build the per-world work list for the requested mode.
 *
 * DISCOVERY ORDER IS THE WHOLE GAME. The API answers one request per second per key, so a
 * scheduled run affords a couple of thousand requests against a catalogue of 1136 items on 39
 * trading worlds: about 88,000 requests for one complete pass, which is a day and a half of
 * uninterrupted asking. Whatever the run does NOT reach simply does not exist on the site
 * until some later run happens to pick it.
 *
 * The first version split items by `id % shards`, which is arbitrary: an item's numeric id
 * says nothing about whether anyone trades it. The result was exactly what you would expect
 * and what the owner spotted straight away: after days of capturing we held 156 of 1136 items,
 * and Rough Oortstone, one of the most traded things in the game, was missing entirely while
 * obscure items had been swept.
 *
 * So discovery now walks items in order of how much they actually trade, taking a window that
 * a run can realistically finish and rotating that window by the clock so the rest follows.
 * The ranking comes from the mirrored BUTT snapshot, which has been capturing this same API
 * for years; it is used only to decide what we look at first, never as data we serve.
 */
function buildWork(opts: CaptureOptions, world: CaptureWorld): string[] {
  if (opts.mode === "hot") {
    const a = opts.active?.[String(world.id)];
    if (!a) return [];
    return [...a.S.map((i) => `${i}:S`), ...a.B.map((i) => `${i}:B`)];
  }

  let items = opts.itemIds;
  if (opts.mode === "discover") {
    const priority = opts.priority?.length ? opts.priority : null;
    if (priority) {
      const rank = new Map(priority.map((id, i) => [id, i]));
      // Items the ranking has never seen go last: nobody has been observed trading them.
      items = [...items].sort(
        (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    const window = opts.window && opts.window > 0 ? opts.window : items.length;
    if (window < items.length) {
      /*
       * Discovery hunts what we have NOT found yet, busiest first.
       *
       * The obvious scheme, a window that rotates with the clock, was wrong in a way that only
       * showed up in the numbers: the turn is derived from the timestamp, so the very first run
       * after the change landed on window 36 of 40 and spent an hour on the 1044th to 1073rd
       * most traded items. 2549 requests returned 148 listings, and Rough Oortstone, ranked
       * 5th, was still missing afterwards.
       *
       * Once an item is found anywhere it moves into the hot sweep, which keeps it fresh
       * cheaply. So discovery should not look at it again: it should always start from the
       * most traded thing we have never seen. That advances on its own, with no stored cursor,
       * because every run shortens the list it draws from.
       *
       * A slice of the run still goes to items we HAVE found, rotating, so a listing appearing
       * on a world we have not checked for that item is eventually noticed too.
       */
      const known = opts.knownItems ?? new Set<number>();
      const unseen = items.filter((id) => !known.has(id));
      const seen = items.filter((id) => known.has(id));
      const hunt = Math.max(1, Math.round(window * 0.75));
      const revisit = Math.max(0, window - hunt);
      const offset = seen.length ? (opts.shard ?? 0) % seen.length : 0;
      items = [
        ...unseen.slice(0, hunt),
        ...[...seen.slice(offset), ...seen.slice(0, offset)].slice(0, revisit),
      ];
      // Everything popular is already found: spend the whole run revisiting instead.
      if (!items.length) items = [...seen.slice(offset), ...seen.slice(0, offset)].slice(0, window);
    }
  }

  const work: string[] = [];
  for (const id of items) work.push(`${id}:S`, `${id}:B`);
  return work;
}

/**
 * Run a sweep.
 *
 * Throughput comes from working several worlds at once with one request in flight per world.
 * Worlds are visited from a rotating offset so consecutive runs start somewhere new: with a
 * time budget in play, that is what stops the same first worlds from being the only ones ever
 * scanned.
 */
export async function captureShopping(opts: CaptureOptions): Promise<CaptureStats> {
  const key = config.shopApiKey;
  const deadline = Date.now() + config.shopTimeBudgetMs;
  const stats: CaptureStats = {
    requests: 0, ok: 0, shed: 0, busy: 0, overrate: 0, netErrors: 0,
    listings: 0, itemsDone: 0, errors: 0, ingestErrors: 0, worldsDone: 0, worldsSkipped: 0,
    rowsWritten: 0, truncated: false,
  };

  const all = opts.worlds
    .map((w) => ({ world: w, work: buildWork(opts, w) }))
    .filter((t) => t.work.length > 0);

  // At ~1 request/second a full universe pass would take days, so WHERE we spend the budget
  // matters more than raw speed. Shops are concentrated in a handful of hub worlds, so a
  // discovery sweep visits worlds already known to trade first (deepening real markets),
  // then everything else from a rotating offset so new shop worlds are still found over
  // time without any stored cursor.
  let queue = all;
  // Each mode orders the queue for itself. "hot" already restricts itself to known triples,
  // so it needs no ordering at all; the other two do, for opposite reasons: DISCOVER has to
  // be stopped from diluting itself across a hundred cold worlds, and FULL has to be stopped
  // from re-scanning the same leading worlds every time. An earlier version applied the
  // discover cap to "full" too, so the one mode whose entire purpose is exhaustive backfill
  // silently skipped most cold worlds; that is fixed, and the rotation below is the other
  // half of the same fix.
  if (opts.mode === "discover") {
    const known = new Set(Object.keys(opts.active ?? {}).map(Number));
    const hot = all.filter((t) => known.has(t.world.id));
    const cold = all.filter((t) => !known.has(t.world.id));
    // Only a handful of never-yet-trading worlds per run. Work is interleaved round-robin
    // across the queue, so including all hundred-odd of them does not merely add work at the
    // end: it dilutes every pass, and the time budget then cuts the sweep off before the
    // worlds that actually trade have been covered. A rotating few still finds new shop
    // worlds over time without starving the ones we know about.
    const explore = Math.max(0, opts.exploreColdWorlds ?? 8);
    const turn = Math.floor(Date.now() / (2 * 60 * 60 * 1000));
    const offset = cold.length ? turn % cold.length : 0;
    const rotated = [...cold.slice(offset), ...cold.slice(0, offset)].slice(0, explore);
    // ROTATE THE HOT WORLDS TOO. Workers now claim a whole world at a time, so a run that hits
    // its deadline stops partway down this list and everything after it gets nothing at all.
    // Left in a fixed order, the tail would never be scanned however many times the job ran.
    // (Under the old interleaved loop every world advanced together, so order did not matter
    // and only the cold ones needed rotating.)
    const hotOff = hot.length ? turn % hot.length : 0;
    queue = [...hot.slice(hotOff), ...hot.slice(0, hotOff), ...rotated];
  } else if (opts.mode === "full") {
    /*
     * FULL means EVERY live world, and no single run can finish that, so it has to rotate.
     *
     * The world set was never the problem: the CLI asks our own API for every live world and
     * keeps the ones with an apiURL, which today is 146 of 146 (50 permanent, 93 sovereign,
     * 3 exo). Nothing is filtered by "has it ever traded". The problem was reachability.
     *
     * Measured: ~1136 catalogue items x 2 sides x 146 worlds = ~331,700 units. At the
     * measured 0.87 units/lane/sec on 8 lanes that is 13.2 hours of capture, against a
     * 5.5-hour budget under GitHub's hard 6-hour cap on a single job. So a pass reaches about
     * 60 worlds and stops. Stopping is safe by design (the ingest only deletes listings for
     * keys it actually verified), but only if the NEXT pass starts where this one gave up.
     *
     * It did not. The queue was the API's own world order, always entered at index 0, so
     * every pass re-scanned the same leading ~60 worlds and the rest of the ring was
     * unreachable by construction: excluded by no rule, simply never got to. That is how 13
     * PERMANENT worlds ended up holding zero listings (Norkyna, Alcyon, Cardass, Shedu Tier,
     * Galan, Malurialakrib, Besevrona, Alnitans, Delta Cancret, Antar VI, Minorengle, Xa
     * Frant, Imdaari) with no way back in: HOT only re-reads triples that ALREADY hold a
     * listing, so it can never reach a world that holds none, and DISCOVER only probes eight
     * cold worlds a run out of ~98 candidates.
     *
     * So the offset advances by one segment per scheduled pass, derived from the clock in
     * exactly the way the discover rotation above already is: no cursor to store, and a run
     * that GitHub drops costs one segment on this lap instead of desynchronising a sequence.
     * Three passes a day of ~60 worlds, less a 10% overlap, lap all 146 in about 0.9 days.
     */
    const unitsPerWorld = Math.max(
      1,
      Math.round(all.reduce((n, t) => n + t.work.length, 0) / Math.max(1, all.length)),
    );
    const fullLanes = Math.max(1, Math.min(config.shopWorldConcurrency, all.length));
    const affordable = Math.max(
      1,
      Math.floor(((config.shopTimeBudgetMs / EST_UNIT_MS) * fullLanes) / unitsPerWorld),
    );
    const stride = Math.max(1, Math.round(affordable * FULL_STRIDE_OVERLAP));
    const offset = all.length ? (Math.floor(Date.now() / FULL_TURN_MS) * stride) % all.length : 0;
    queue = [...all.slice(offset), ...all.slice(0, offset)];
    console.log(
      `full: ${all.length} worlds in the ring, entering at #${offset} ` +
        `(${queue[0]?.world.name ?? "?"}); a pass affords ~${affordable} worlds, stride ${stride}`,
    );
  }

  const totalUnits = queue.reduce((n, t) => n + t.work.length, 0);
  const lanes = Math.max(1, Math.min(config.shopWorldConcurrency, queue.length));
  const estMin = Math.round((totalUnits * EST_UNIT_MS) / lanes / 60000);
  const budgetMin = Math.round(config.shopTimeBudgetMs / 60000);
  console.log(
    `shopping ${opts.mode}: ${queue.length} worlds, ${totalUnits} units planned ` +
      `(~${estMin} min at ${EST_UNIT_MS}ms/unit across ${lanes} lanes), budget ${budgetMin} min`,
  );
  // A plan that cannot finish is not a plan, it is a truncation. Say so, because a silently
  // cut sweep is exactly how the catalogue ended up a seventh covered.
  if (estMin > budgetMin) {
    console.log(
      `  NOTE: this plan needs ${estMin} min but has ${budgetMin}. ` +
        `About ${Math.round((budgetMin / estMin) * 100)}% will be reached; the rest waits for the next run.`,
    );
  }

  // ONE WORKER PER WORLD, several worlds at a time. Each worker owns its world and never has
  // more than one request in flight against it, which is the rule the docs actually state;
  // the parallelism is across game servers, where nothing forbids it.
  const buffers = queue.map<WorldBuffer>((t) => ({ world: t.world, scanned: [], listings: [] }));
  const flush = async (buf: WorldBuffer) => {
    /*
     * SINGLE FLIGHT PER BUFFER. Two call sites can reach the same buffer concurrently (the
     * owner's POST_CHUNK trigger, and the clock sweep run by whichever worker finished a
     * world), and two overlapping flushes corrupt each other: the slower one's splice runs
     * on a stale snapshot and clamps onto units the faster one never sent. Waiting out the
     * in-flight flush and re-checking is correct for every caller: whatever data remains is
     * picked up here or by the next trigger, and at end-of-run all workers have returned so
     * nothing can be in flight.
     *
     * The check-to-assign sequence below is synchronous (no await between the `busy` check
     * and `buf.busy = job`), which is what makes the lock sound in single-threaded JS.
     */
    while (buf.busy) await buf.busy;
    if (!buf.scanned.length) return;
    if (buf.retryAfter && Date.now() < buf.retryAfter) return;
    /*
     * Snapshot the lengths BEFORE the await, and on success remove exactly that many.
     *
     * While this POST is in flight the owning worker can push more units into these same
     * arrays. A wholesale `buf.scanned = []` on success would discard those late arrivals
     * without sending them: counted as done, never written, no error anywhere. Splicing only
     * the sent prefix keeps them for the next flush. The push pairs (listings, then scanned
     * key, no await between) are atomic, so a snapshot can never split a unit's listings
     * from its key across two POSTs.
     */
    const job = (async () => {
      const nScanned = buf.scanned.length;
      const nListings = buf.listings.length;
      try {
        stats.rowsWritten += await postChunk(
          buf.world.id,
          buf.scanned.slice(0, nScanned),
          buf.listings.slice(0, nListings),
        );
        buf.scanned.splice(0, nScanned);
        buf.listings.splice(0, nListings);
        buf.retryAfter = undefined;
      } catch (err) {
        stats.ingestErrors++;
        buf.retryAfter = Date.now() + 60_000;
        console.warn(`  world ${buf.world.id}: ingest failed, kept ${buf.scanned.length} units buffered: ${(err as Error).message}`);
      }
    })();
    buf.busy = job;
    try {
      await job;
    } finally {
      buf.busy = undefined;
    }
  };

  const touched = new Set<number>();
  /*
   * Flush everything periodically, not only at the end.
   *
   * POST_CHUNK alone does not deliver on its promise that an interrupted run keeps what it
   * captured: a discovery run walks a few dozen items per world, so no single buffer reaches
   * 200 keys. Time is the thing that actually divides a run, so results go out every few
   * minutes and an interruption costs at most that.
   */
  const FLUSH_EVERY_MS = 3 * 60 * 1000;
  let lastFlush = Date.now();
  let flushing: Promise<void> | null = null;
  const flushAllDue = async () => {
    if (Date.now() - lastFlush < FLUSH_EVERY_MS || flushing) return;
    flushing = (async () => {
      for (const b of buffers) await flush(b);
      lastFlush = Date.now();
    })();
    await flushing;
    flushing = null;
  };

  /**
   * Circuit breaker for a dead key.
   *
   * On the sibling routes a 403 is documented as "the API key was not acceptable", and a
   * rejected key sheds EVERY request. A healthy run cannot look like that: measured, a cold
   * unit answers 200 within 3 retries, so 30 requests with zero 200s is not a cold cache,
   * it is a key that no longer works. Aborting beats spending the whole budget confirming it.
   */
  let abort: ShopKeyError | null = null;
  const breakerTripped = () => stats.requests >= 30 && stats.ok === 0;

  // Workers take whole worlds off a shared queue, so a world with a short list does not leave
  // its slot idle while another grinds through a long one. Each lane is strictly serial,
  // which satisfies the documented one-in-flight-per-game-server rule BY CONSTRUCTION; there
  // is deliberately no client-side pacing anywhere, because the docs say the server is the
  // regulator ("there is no need to handle delaying requests ... on the user-side").
  let nextWorld = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const w = nextWorld++;
      if (w >= queue.length || abort) return;
      if (Date.now() > deadline) {
        stats.truncated = true;
        return;
      }
      const buf = buffers[w];
      for (const item of queue[w].work) {
        if (abort) return;
        if (Date.now() > deadline) {
          stats.truncated = true;
          break;
        }
        // Emergency brake only: 0 in normal operation, because the docs say client-side
        // delays are not needed. See config.shopPaceMs.
        if (config.shopPaceMs > 0) await sleep(config.shopPaceMs);
        const [idStr, type] = item.split(":");
        const itemId = Number(idStr);
        if (!Number.isFinite(itemId) || (type !== "S" && type !== "B")) continue;
        const outcome = await fetchListings(buf.world.apiUrl, type, itemId, key, stats);
        touched.add(buf.world.id);
        if (breakerTripped()) {
          abort = new ShopKeyError(
            `${stats.requests} requests, zero 200s: the key is being rejected, not throttled`,
          );
          return;
        }
        if (outcome.kind === "world-busy") {
          // Documented world condition. Keep what we verified, drop the rest of this world
          // for the run; the between-run rotation brings it back around.
          stats.worldsSkipped++;
          console.log(`  world ${buf.world.id} (${buf.world.name ?? "?"}): 503, skipping for this run`);
          break;
        }
        if (outcome.kind === "unverified") {
          stats.errors++;
          // Left out of `scanned` on purpose: the ingest must not treat listings it could not
          // verify as deleted. Failing safe beats deleting real data.
          continue;
        }
        stats.itemsDone++;
        stats.listings += outcome.listings.length;
        buf.listings.push(...outcome.listings);
        buf.scanned.push(item);
        if (buf.scanned.length >= POST_CHUNK) await flush(buf);
      }
      // This world is finished, so its results can go out now rather than at the end of the
      // whole run. With one worker per world this is a real boundary, unlike the interleaved
      // version where every world finished on the same final index.
      await flush(buf);
      await flushAllDue();
    }
  };

  const workers = Math.max(1, Math.min(config.shopWorldConcurrency, queue.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  for (const buf of buffers) {
    buf.retryAfter = undefined; // the end of the run is this data's last chance: always try
    await flush(buf);
  }
  stats.worldsDone = touched.size;
  if (abort) throw abort;

  // Plan versus reality, so the next person tuning this reads measurements instead of hopes.
  const elapsedMin = (config.shopTimeBudgetMs - Math.max(0, deadline - Date.now())) / 60000;
  const unitRate = elapsedMin > 0 ? stats.itemsDone / (elapsedMin * 60) : 0;
  console.log(
    `  sustained: ${unitRate.toFixed(2)} units/sec on ${workers} lanes ` +
      `(${(stats.requests / Math.max(1, stats.itemsDone)).toFixed(2)} requests/unit; ` +
      `estimate constant says ${(1000 / EST_UNIT_MS * workers).toFixed(2)})`,
  );
  return stats;
}
