/**
 * Shopping capture: scrapes the official HTTP Shopping API (blessed key) per world and
 * ships the result to our ingest endpoint.
 *
 * Route (appended to each world's apiURL): `/shopping/{S|B}/{itemId}`
 *   S = shop stand    -> a player SELLS, so you can BUY from it
 *   B = request basket-> a player BUYS, so you can SELL to it
 * Auth: header `Boundless-API-Key`.
 *
 * Documented server behaviour we are built around:
 *  - ONE in-flight request per key per game server (concurrent -> 429), ~1 response/second.
 *    Every world is its own game server, so we run worlds in parallel but stay strictly
 *    serial inside a world.
 *  - Responses are cached server-side for 30 minutes, so sweeping a world more often than
 *    that only re-reads the same cache.
 *  - 403 means the key is not accepted (fatal, we abort rather than hammer).
 *  - 503 (+ Retry-After) means busy/locked: back off and retry.
 *
 * Robustness rules:
 *  - Every run is bounded by a wall-clock budget; leftovers are picked up next run.
 *  - Results are posted in chunks as we go, so a killed run keeps everything already
 *    captured. The ingest only deletes listings for keys it actually verified, so a partial
 *    sweep can never wipe unrelated data.
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
  /** Items found to be non-tradeable (403) and recorded so they are never asked again. */
  skippedItems: number;
}

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
 * Thrown when the API answers 403 for a specific item.
 *
 * Verified against the live servers: a 403 here is an ITEM property, not a key problem.
 * Tradeable items answer 200 with the same key, while items that cannot be traded at all
 * (seasonal decorations and similar) answer 403 on every world. So we record the item as
 * not-shoppable and never spend a request on it again, instead of aborting the sweep.
 */
export class ShopItemUnavailable extends Error {}

/** Item shoppability learned during a run, shared by every world worker. */
export interface LearnedItems {
  shoppable: Set<number>;
  notShoppable: Set<number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one (world, type, item). Retries transient conditions (429/503/network) with
 * backoff, honours Retry-After, and surfaces a 403 as fatal.
 */
async function fetchListings(
  apiUrl: string,
  type: ShopType,
  itemId: number,
  key: string,
): Promise<ShopListing[]> {
  const url = `${apiUrl}/shopping/${type}/${itemId}`;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "Boundless-API-Key": key, "accept-encoding": "gzip" },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (res.status === 403) throw new ShopItemUnavailable(`item ${itemId} is not tradeable`);
      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000, 30_000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // An empty body is a valid answer meaning "no shops for this item here".
      return buf.length === 0 ? [] : parseShopping(buf, itemId, type);
    } catch (err) {
      if (err instanceof ShopKeyError || err instanceof ShopItemUnavailable) throw err;
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("shopping fetch failed");
}

/** POST one chunk of a world's scan to the ingest endpoint. Returns rows written. */
async function postChunk(
  worldId: number,
  scanned: string[],
  listings: ShopListing[],
  shoppable: number[] = [],
  notShoppable: number[] = [],
): Promise<number> {
  if (scanned.length === 0 && notShoppable.length === 0) return 0;
  const res = await fetch(`${config.apiBase}/api/ingest/shopping`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ingestToken}`,
    },
    body: JSON.stringify({ worldId, scanned, listings, shoppable, notShoppable }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ingest HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { inserted?: number; updated?: number; deleted?: number };
  return (data.inserted ?? 0) + (data.updated ?? 0) + (data.deleted ?? 0);
}

/** Post at most this many scanned keys per ingest call (keeps request bodies modest). */
const POST_CHUNK = 200;

/**
 * Scan one world's work list serially, posting progress in chunks.
 * `work` is the list of "<itemId>:<type>" keys to query.
 */
async function captureWorld(
  world: CaptureWorld,
  work: string[],
  key: string,
  deadline: number,
  stats: CaptureStats,
  learned: LearnedItems,
): Promise<void> {
  let scanned: string[] = [];
  let listings: ShopListing[] = [];
  let newShoppable: number[] = [];
  let newNotShoppable: number[] = [];

  const flush = async () => {
    if (!scanned.length && !newNotShoppable.length) return;
    try {
      stats.rowsWritten += await postChunk(
        world.id, scanned, listings, newShoppable, newNotShoppable,
      );
    } catch (err) {
      stats.errors++;
      console.warn(`  world ${world.id}: ingest failed: ${(err as Error).message}`);
    }
    scanned = [];
    listings = [];
    newShoppable = [];
    newNotShoppable = [];
  };

  for (const item of work) {
    if (Date.now() > deadline) {
      stats.truncated = true;
      break;
    }
    const [idStr, type] = item.split(":");
    const itemId = Number(idStr);
    if (!Number.isFinite(itemId) || (type !== "S" && type !== "B")) continue;
    // Another worker already proved this item is not tradeable: skip without a request.
    if (learned.notShoppable.has(itemId)) continue;
    try {
      const found = await fetchListings(world.apiUrl, type, itemId, key);
      stats.requests++;
      stats.listings += found.length;
      listings.push(...found);
      scanned.push(item);
      if (!learned.shoppable.has(itemId)) {
        learned.shoppable.add(itemId);
        newShoppable.push(itemId);
      }
    } catch (err) {
      if (err instanceof ShopItemUnavailable) {
        stats.requests++;
        stats.skippedItems++;
        if (!learned.notShoppable.has(itemId)) {
          learned.notShoppable.add(itemId);
          newNotShoppable.push(itemId);
        }
        // Not an error: the item simply cannot be traded. Recorded so no future sweep,
        // on any world, ever asks for it again.
      } else if (err instanceof ShopKeyError) {
        await flush();
        throw err;
      } else {
        stats.errors++;
        // The key stays out of `scanned`, so the ingest will not treat its (possibly still
        // existing) listings as deleted. Failing safe beats deleting real data.
      }
    }
    if (scanned.length >= POST_CHUNK) await flush();
    await sleep(config.shopRequestDelayMs);
  }
  await flush();
  stats.worldsDone++;
}

export interface CaptureOptions {
  mode: "hot" | "discover" | "full";
  worlds: CaptureWorld[];
  /** Full catalogue of item game ids (used by discover/full). */
  itemIds: number[];
  /** Active (world -> {S,B} item ids) from our API, used by the "hot" mode. */
  active?: Record<string, { S: number[]; B: number[] }>;
  /** Item ids already known to be non-tradeable: never requested again. */
  skipItems?: number[];
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
  const skip = new Set(opts.skipItems ?? []);
  const items = (
    opts.mode === "discover" && shards > 1
      ? opts.itemIds.filter((id) => id % shards === shard)
      : opts.itemIds
  ).filter((id) => !skip.has(id));
  const work: string[] = [];
  for (const id of items) {
    work.push(`${id}:S`, `${id}:B`);
  }
  return work;
}

/**
 * Run a sweep. Worlds are processed by a fixed-size pool so the concurrency (and therefore
 * the load we put on the game servers) is predictable regardless of how many worlds exist.
 */
export async function captureShopping(opts: CaptureOptions): Promise<CaptureStats> {
  const key = config.shopApiKey;
  const deadline = Date.now() + config.shopTimeBudgetMs;
  const stats: CaptureStats = {
    requests: 0, listings: 0, errors: 0, worldsDone: 0, rowsWritten: 0, truncated: false,
    skippedItems: 0,
  };
  // Shared across workers so an item proved non-tradeable on one world is skipped on all
  // the others immediately, within the same run.
  const learned: LearnedItems = {
    shoppable: new Set<number>(),
    notShoppable: new Set<number>(opts.skipItems ?? []),
  };

  // Skip worlds with nothing to do (very common in "hot" mode) so the pool spends its slots
  // on real work.
  const queue = opts.worlds
    .map((w) => ({ world: w, work: buildWork(opts, w) }))
    .filter((t) => t.work.length > 0);
  const totalReq = queue.reduce((n, t) => n + t.work.length, 0);
  console.log(
    `shopping ${opts.mode}: ${queue.length} worlds, ${totalReq} requests planned, ` +
      `concurrency ${config.shopWorldConcurrency}, budget ${Math.round(config.shopTimeBudgetMs / 60000)} min`,
  );

  let next = 0;
  let fatal: unknown = null;
  const worker = async () => {
    while (next < queue.length && !fatal) {
      if (Date.now() > deadline) {
        stats.truncated = true;
        return;
      }
      const task = queue[next++];
      try {
        await captureWorld(task.world, task.work, key, deadline, stats, learned);
        // Safety net: if a long stretch of requests produced only rejections and never a
        // single success, the key itself is the likely cause. Stop rather than grind on.
        if (stats.requests > 200 && stats.listings === 0 && learned.shoppable.size === 0) {
          fatal = new ShopKeyError("no item accepted after 200+ requests: key likely invalid");
          return;
        }
      } catch (err) {
        if (err instanceof ShopKeyError) {
          fatal = err;
          return;
        }
        stats.errors++;
        console.warn(`world ${task.world.id}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, config.shopWorldConcurrency) }, () => worker()),
  );
  if (fatal) throw fatal;
  return stats;
}
