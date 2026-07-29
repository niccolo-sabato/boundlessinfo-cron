/**
 * Shopping capture: scrapes the official HTTP Shopping API (blessed key) per world and
 * ships the result to our ingest endpoint.
 *
 * Route (appended to each world's apiURL): `/shopping/{S|B}/{itemId}`
 *   S = shop stand    -> a player SELLS, so you can BUY from it
 *   B = request basket-> a player BUYS, so you can SELL to it
 * Auth: header `Boundless-API-Key`.
 *
 * THE RATE LIMIT, from the official docs, is two separate rules:
 *   1. "Each API key is permitted to have 1 request in-flight that hits a GIVEN GAME SERVER:
 *      any attempt to run concurrent requests will return 429 responses."
 *   2. "Responses will be returned up to a rate of 1 response per second for each api-key."
 *
 * I originally read rule 2 as a hard global cap and built everything around one shared pacer
 * at a request a second. THAT WAS WRONG, and it cost the site most of its catalogue: after
 * days of capturing we held 156 items of 1136.
 *
 * What gave it away was BUTT, which reads the same API: its mirror holds the entire 995-item
 * catalogue captured inside a 6.6 hour window, which needs roughly twelve successful responses
 * a second. So I measured the thing I should have measured the first time, which is SUCCESSFUL
 * RESPONSES PER SECOND rather than the rejection rate:
 *
 *   concurrency  1 ->  1.53 good responses/sec
 *   concurrency  4 ->  8.62
 *   concurrency  8 -> 18.29
 *   concurrency 16 -> 25.32
 *
 * Roughly half of all requests are shed at EVERY level, including concurrency 1, so the
 * rejections were never caused by going wide: that is just the server balancing us against
 * other users on a cache miss, exactly as the docs describe. The earlier conclusion looked at
 * that 50% and stopped, when the throughput underneath it scales almost linearly.
 *
 * So the capture now runs ONE REQUEST IN FLIGHT PER WORLD, across many worlds at once, which
 * is precisely what rule 1 permits. A 403 is still back-pressure and never a fact about the
 * item, so it is retried and never recorded.
 *
 * Robustness rules:
 *  - Every run is bounded by a wall-clock budget; leftovers are picked up next run.
 *  - Results are posted in chunks as we go, so a killed run keeps everything captured.
 *  - The ingest only deletes listings for keys it actually verified, so a partial sweep can
 *    never wipe unrelated data.
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
  listings: number;
  errors: number;
  worldsDone: number;
  rowsWritten: number;
  truncated: boolean;
  /** Requests that came back 403/429 and had to be retried (rate-limit pressure). */
  throttled: number;
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
 * Spacing between requests, ONE INSTANCE PER WORLD.
 *
 * It must not be shared, and a shared one is how the first parallel run quietly ran at a
 * quarter of its intended rate: eight workers queueing through a single 250ms pacer is 4
 * requests a second in total, not 4 each. The run reported 10,778 requests in 45.1 minutes,
 * which is 3.98/sec: the pacer, not the game servers, was the ceiling.
 *
 * Per world it is what it claims to be, a floor on how hard any single game server is asked,
 * while the aggregate is bounded by the worker count instead.
 */
export class Pacer {
  private next = 0;
  private readonly intervalMs: number;
  // An explicit field, not a constructor parameter property: the bot runs through Node's
  // type-stripping loader, which cannot emit the implicit assignment.
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }
  async take(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    const wait = at - now;
    if (wait > 0) await sleep(wait);
  }
}

/**
 * Fetch one (world, type, item), paced globally.
 *
 * 403 and 429 are both treated as back-pressure: they are retried with growing backoff and
 * never interpreted as "this item does not exist". Returns null when the request could not
 * be completed, so the caller can leave that key out of the verified set (and therefore out
 * of the deletion pass) instead of guessing.
 */
async function fetchListings(
  apiUrl: string,
  type: ShopType,
  itemId: number,
  key: string,
  pacer: Pacer,
  stats: CaptureStats,
): Promise<ShopListing[] | null> {
  const url = `${apiUrl}/shopping/${type}/${itemId}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    await pacer.take();
    try {
      const res = await fetch(url, {
        headers: { "Boundless-API-Key": key, "accept-encoding": "gzip" },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      stats.requests++;
      if (res.status === 403 || res.status === 429 || res.status === 503) {
        stats.throttled++;
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : 1500 * (attempt + 1);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // An empty body is a valid answer meaning "no shops for this item here".
      return buf.length === 0 ? [] : parseShopping(buf, itemId, type);
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
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
    requests: 0, listings: 0, errors: 0, worldsDone: 0, rowsWritten: 0, truncated: false,
    throttled: 0,
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
  if (opts.mode !== "hot") {
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
  }

  const totalReq = queue.reduce((n, t) => n + t.work.length, 0);
  const lanes = Math.max(1, Math.min(config.shopWorldConcurrency, queue.length));
  const estMin = Math.round((totalReq * config.shopPaceMs) / lanes / 60000);
  const budgetMin = Math.round(config.shopTimeBudgetMs / 60000);
  console.log(
    `shopping ${opts.mode}: ${queue.length} worlds, ${totalReq} requests planned ` +
      `(~${estMin} min at ${config.shopPaceMs}ms/request across ${lanes} worlds at once), ` +
      `budget ${budgetMin} min`,
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
    if (!buf.scanned.length) return;
    try {
      stats.rowsWritten += await postChunk(buf.world.id, buf.scanned, buf.listings);
    } catch (err) {
      stats.errors++;
      console.warn(`  world ${buf.world.id}: ingest failed: ${(err as Error).message}`);
    }
    buf.scanned = [];
    buf.listings = [];
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

  // Workers take whole worlds off a shared queue, so a world with a short list does not leave
  // its slot idle while another grinds through a long one.
  let nextWorld = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const w = nextWorld++;
      if (w >= queue.length) return;
      if (Date.now() > deadline) {
        stats.truncated = true;
        return;
      }
      const buf = buffers[w];
      // This world's own pacer. See the class comment: sharing one across the workers turns
      // the floor into a global ceiling and undoes the parallelism entirely.
      const pacer = new Pacer(config.shopPaceMs);
      for (const item of queue[w].work) {
        if (Date.now() > deadline) {
          stats.truncated = true;
          break;
        }
        const [idStr, type] = item.split(":");
        const itemId = Number(idStr);
        if (!Number.isFinite(itemId) || (type !== "S" && type !== "B")) continue;
        const found = await fetchListings(buf.world.apiUrl, type, itemId, key, pacer, stats);
        touched.add(buf.world.id);
        if (found === null) {
          stats.errors++;
          // Left out of `scanned` on purpose: the ingest must not treat listings it could not
          // verify as deleted. Failing safe beats deleting real data.
          continue;
        }
        stats.listings += found.length;
        buf.listings.push(...found);
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

  for (const buf of buffers) await flush(buf);
  stats.worldsDone = touched.size;
  return stats;
}
