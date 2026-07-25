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
 *   1. "Each API key is permitted to have 1 request in-flight that hits a given game
 *      server: any attempt to run concurrent requests will return 429 responses."
 *   2. "Responses will be returned up to a rate of 1 response per second for each api-key."
 * Rule 2 is the binding one: it is per KEY across the entire universe, so parallelising
 * across worlds buys no throughput. Measured against the live servers: at concurrency 1
 * every request succeeded, at concurrency 16 roughly one in five came back 403. A 403 here
 * is the server shedding load, NOT a permanent property of the item (the same item answers
 * 200 a second later on another world), so it is retried, never recorded.
 *
 * Everything therefore flows through one shared Pacer at ~1 request/second, which caps our
 * whole footprint no matter how the work is distributed.
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
 * Global request pacer.
 *
 * The binding official rule is "1 response per second for each api-key", across the whole
 * universe, so every outgoing request passes through one shared pacer. Workers may still
 * overlap to hide latency while the aggregate rate stays inside the limit.
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
}

/** Build the per-world work list for the requested mode. */
function buildWork(opts: CaptureOptions, world: CaptureWorld): string[] {
  if (opts.mode === "hot") {
    const a = opts.active?.[String(world.id)];
    if (!a) return [];
    return [...a.S.map((i) => `${i}:S`), ...a.B.map((i) => `${i}:B`)];
  }
  const shards = opts.shards ?? 1;
  const shard = opts.shard ?? 0;
  const items =
    opts.mode === "discover" && shards > 1
      ? opts.itemIds.filter((id) => id % shards === shard)
      : opts.itemIds;
  const work: string[] = [];
  for (const id of items) work.push(`${id}:S`, `${id}:B`);
  return work;
}

/**
 * Run a sweep.
 *
 * Throughput is fixed by the global pacer, so concurrency exists only to keep the pipe full
 * while a response is in flight (a couple of workers is plenty). Worlds are visited from a
 * rotating offset so consecutive runs start somewhere new: with a time budget in play, that
 * is what stops the same first worlds from being the only ones ever scanned.
 */
export async function captureShopping(opts: CaptureOptions): Promise<CaptureStats> {
  const key = config.shopApiKey;
  const deadline = Date.now() + config.shopTimeBudgetMs;
  const stats: CaptureStats = {
    requests: 0, listings: 0, errors: 0, worldsDone: 0, rowsWritten: 0, truncated: false,
    throttled: 0,
  };
  const pacer = new Pacer(config.shopPaceMs);

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
    const offset = cold.length ? new Date().getUTCHours() % cold.length : 0;
    queue = [...hot, ...cold.slice(offset), ...cold.slice(0, offset)];
  }

  const totalReq = queue.reduce((n, t) => n + t.work.length, 0);
  const estMin = Math.round((totalReq * config.shopPaceMs) / 60000);
  console.log(
    `shopping ${opts.mode}: ${queue.length} worlds, ${totalReq} requests planned ` +
      `(~${estMin} min at ${config.shopPaceMs}ms/request), ` +
      `budget ${Math.round(config.shopTimeBudgetMs / 60000)} min`,
  );

  // INTERLEAVE the work across worlds instead of finishing one world at a time.
  // Beyond the per-key response rate there is clearly a per-server component too: pacing at
  // 1600ms while hammering a SINGLE world still drew ~28% rejections, whereas the same pace
  // rotating over six worlds drew none. Round-robin gives each game server a long gap
  // between our requests while the global pacer still caps the overall rate.
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

  const maxLen = queue.reduce((n, t) => Math.max(n, t.work.length), 0);
  const touched = new Set<number>();
  outer: for (let i = 0; i < maxLen; i++) {
    for (let w = 0; w < queue.length; w++) {
      const item = queue[w].work[i];
      if (item === undefined) continue;
      if (Date.now() > deadline) {
        stats.truncated = true;
        break outer;
      }
      const [idStr, type] = item.split(":");
      const itemId = Number(idStr);
      if (!Number.isFinite(itemId) || (type !== "S" && type !== "B")) continue;
      const buf = buffers[w];
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
  }
  for (const buf of buffers) await flush(buf);
  stats.worldsDone = touched.size;
  return stats;
}
