/**
 * Planet map capture: turns a world into a stored image, 1 pixel per block.
 *
 * ONE source: `<apiURL>/lod0` with the blessed key. The response is a GZIP TGA streamed back
 * over 9 to 13 minutes, because the server paces itself so the request cannot disturb play.
 * That slowness is why capture starts early and runs unattended while the rest of the release
 * is being built.
 *
 * WHY NOT THE FREE MIRROR. `maps.playboundless.com/<date>/<internal>.png` is public, needs no
 * key and answers in seconds, and the plan was to use it as an instant baseline for permanent
 * worlds. It was measured before being trusted, and it fails: today's Gellis and the mirror's
 * `euc3_t0_2` are different terrain. Their coastlines do not line up under any rotation, flip
 * or transpose (water-mask agreement sits at chance, about 17%, for all eight), and comparing
 * our capture against EVERY frozen image of the same size found no match anywhere, so it is
 * not a naming drift either. The mirror's newest directory is 2020-06-14 and the permanent
 * worlds were regenerated since. A map of a planet that no longer exists would put every shop
 * marker on meaningless ground, which is worse for a player trying to reach a shop than
 * showing no map at all. It is therefore not used at any priority, and not as a fallback.
 *
 * The politeness rules are the shopping ones: one request at a time, honour `Retry-After`,
 * bound the run by wall-clock time and let the remainder wait for the next run.
 *
 * The storage cap is enforced by the ingest endpoint, which is where it cannot be bypassed,
 * and mirrored here so a run stops early rather than making a doomed round trip per world.
 */

import { config } from "./config.ts";
import { decodePng, decodeTga, downscale, encodePng, type Raster } from "./image.ts";
import { gunzipSync } from "node:zlib";

export interface MapWorld {
  id: number;
  /** Internal name, e.g. "euc3_t0_2". */
  name: string;
  displayName: string;
  /** World side in CHUNKS; a block is 1/16th of a chunk on each axis. */
  worldSize: number;
  apiUrl: string | null;
  isPerm: boolean;
}

export interface MapCaptureStats {
  worldsDone: number;
  bytesWritten: number;
  errors: number;
  truncated: boolean;
  /** Set when the server refused an upload because the storage cap was reached. */
  capped: boolean;
}

export interface MapCaptureOptions {
  /** 'new' only maps worlds we hold nothing for; 'refresh' also re-captures stale ones. */
  mode: "new" | "refresh";
  worlds: MapWorld[];
  /** world id -> what we already hold, from /api/v2/maps/coverage. */
  coverage: Record<string, { at: number; source: string; thumb?: boolean }>;
  /** World ids known to have shops. Maps exist to make shops findable, so these come first. */
  shopWorlds: Set<number>;
  /** Stop before starting another world once this many are done. */
  maxWorlds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when the storage cap was hit: the run ends, it does not retry. */
export class MapCapError extends Error {}

/* ----------------------------- Source ----------------------------- */

/**
 * Fetch and decode a world's current map from the game server.
 *
 * 503 means the world is locked, starting, shutting down, or already answering a LOD0
 * request; the header says roughly how long to wait, and waiting is the correct response.
 * 403 means the key was refused, which retrying cannot fix.
 */
async function fetchLod0(world: MapWorld): Promise<Raster> {
  if (!world.apiUrl) throw new Error("world has no apiUrl");
  const url = `${world.apiUrl}/lod0`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { "Boundless-API-Key": config.mapApiKey },
      signal: AbortSignal.timeout(config.mapRequestTimeoutMs),
    });
    if (res.status === 503) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 120_000) : 30_000;
      console.log(`    world busy (503), waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 403) throw new Error("LOD0 key rejected (403)");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0) throw new Error("empty response");
    // The endpoint advertises GZIP, but fetch transparently decompresses when the server also
    // sets Content-Encoding, so accept either and let the magic bytes decide.
    const tga = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
    return decodeTga(tga);
  }
  throw new Error("world stayed busy across every attempt");
}

/* ----------------------------- Upload ----------------------------- */

async function putBlob(
  worldId: number,
  variant: "full" | "overview" | "thumb",
  png: Buffer,
): Promise<number> {
  const res = await fetch(`${config.apiBase}/api/ingest/map/blob?world=${worldId}&variant=${variant}`, {
    method: "POST",
    headers: { "content-type": "image/png", authorization: `Bearer ${config.ingestToken}` },
    body: png,
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status === 507) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new MapCapError(`storage cap reached: ${body.detail ?? "no detail"}`);
  }
  if (!res.ok) throw new Error(`blob upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return png.length;
}

async function putRecord(rec: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${config.apiBase}/api/ingest/map`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
    body: JSON.stringify(rec),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`index upsert HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/* ----------------------------- Planning ----------------------------- */

export interface Job {
  world: MapWorld;
  /** Lower sorts first. */
  priority: number;
  why: string;
}

/**
 * Decide what this run should spend its time on.
 *
 * The ordering is the whole point, because a capture costs about twelve minutes and one run
 * only gets through a dozen or two:
 *   1. Worlds that have shops and no map at all. That is exactly what the release needs.
 *   2. Any other world with no map, permanent ones first: they are where players mostly
 *      trade, and unlike sovereigns and exos they never expire.
 *   3. Worlds whose map has gone stale, oldest first, and only in 'refresh' mode. Trading
 *      worlds go stale sooner than quiet ones (7 days against 30): terrain changes where
 *      people build, and a ten-minute capture of an untouched planet buys nothing.
 *
 * Note that the unmapped bands (0-2) always outrank the stale bands (3-4), which is what
 * lets ONE scheduled mode do both jobs: a new sovereign or a fresh nexus is picked up on the
 * next run ahead of any refresh, and refreshes fill whatever time is left.
 */
export function planMapWork(opts: MapCaptureOptions): Job[] {
  const now = Math.floor(Date.now() / 1000);
  const staleAfter = config.mapRefreshDays * 86400;
  const jobs: Job[] = [];

  for (const w of opts.worlds) {
    const side = w.worldSize * 16;
    if (!Number.isFinite(side) || side <= 0 || side > config.mapMaxSideBlocks) continue;
    if (!w.apiUrl) continue; // no world server to ask
    const held = opts.coverage[String(w.id)];
    const hasShops = opts.shopWorlds.has(w.id);

    if (!held) {
      jobs.push({ world: w, priority: hasShops ? 0 : w.isPerm ? 1 : 2, why: "no map yet" });
      continue;
    }
    if (opts.mode !== "refresh") continue;
    const limit = hasShops ? config.mapRefreshDaysActive * 86400 : staleAfter;
    if (now - held.at > limit) {
      jobs.push({
        world: w,
        priority: hasShops ? 3 : 4,
        why: `${Math.round((now - held.at) / 86400)} days old`,
      });
    }
  }

  // Stable within a priority band: oldest capture first, then by id so a run is reproducible.
  return jobs.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const at = opts.coverage[String(a.world.id)]?.at ?? 0;
    const bt = opts.coverage[String(b.world.id)]?.at ?? 0;
    if (at !== bt) return at - bt;
    return a.world.id - b.world.id;
  });
}

/* ----------------------------- The run ----------------------------- */

export async function captureMaps(opts: MapCaptureOptions): Promise<MapCaptureStats> {
  const deadline = Date.now() + config.mapTimeBudgetMs;
  const stats: MapCaptureStats = {
    worldsDone: 0, bytesWritten: 0, errors: 0, truncated: false, capped: false,
  };

  const jobs = planMapWork(opts).slice(0, opts.maxWorlds);
  console.log(
    `map capture ${opts.mode}: ${jobs.length} worlds planned, ` +
      `budget ${Math.round(config.mapTimeBudgetMs / 60000)} min`,
  );
  for (const j of jobs) console.log(`  - ${j.world.displayName} (${j.why})`);

  for (const job of jobs) {
    // Checked before starting rather than after: there is no point beginning a capture that
    // takes twelve minutes when only two are left.
    if (Date.now() + config.mapRequestTimeoutMs / 3 > deadline) {
      stats.truncated = true;
      console.log("\nnot enough time left for another world, the rest waits for the next run");
      break;
    }
    const { world } = job;
    const side = world.worldSize * 16;
    const started = Date.now();
    console.log(`\n${world.displayName} (${world.name}), expecting ${side}x${side}`);

    try {
      const img = await fetchLod0(world);
      if (img.width !== side || img.height !== side) {
        // A mismatch means the block-to-pixel mapping we draw markers with would be wrong, and
        // a map that puts shops in the wrong place is worse than no map at all.
        console.log(`  ! got ${img.width}x${img.height} but the world is ${side} blocks: refusing it`);
        stats.errors++;
        continue;
      }

      const fullPng = encodePng(img);
      const overviewPng = encodePng(downscale(img, config.mapOverviewPx));
      // A third, tiny size for the index grid. Reusing the 1024px overview there would make
      // one page pull tens of megabytes to draw pictures 190 pixels wide.
      const thumbPng = encodePng(downscale(img, config.mapThumbPx));
      console.log(
        `  encoded: full ${(fullPng.length / 1048576).toFixed(2)} MB, ` +
          `overview ${(overviewPng.length / 1024).toFixed(0)} KB, ` +
          `thumb ${(thumbPng.length / 1024).toFixed(0)} KB`,
      );

      stats.bytesWritten += await putBlob(world.id, "full", fullPng);
      stats.bytesWritten += await putBlob(world.id, "overview", overviewPng);
      stats.bytesWritten += await putBlob(world.id, "thumb", thumbPng);
      await putRecord({
        world_id: world.id,
        internal_name: world.name,
        display_name: world.displayName,
        size_blocks: side,
        width: img.width,
        height: img.height,
        source: "lod0",
        source_ref: "",
        bytes_full: fullPng.length,
        bytes_overview: overviewPng.length,
        bytes_thumb: thumbPng.length,
        captured_at: Math.floor(Date.now() / 1000),
        took_ms: Date.now() - started,
      });
      stats.worldsDone++;
      console.log(`  stored in ${((Date.now() - started) / 1000).toFixed(0)}s`);
    } catch (err) {
      if (err instanceof MapCapError) {
        // A self-imposed stop, not a failure to work around.
        console.error(`  ${err.message}`);
        stats.capped = true;
        break;
      }
      stats.errors++;
      console.warn(`  failed: ${(err as Error).message}`);
    }
  }

  return stats;
}

/* ----------------------------- Thumbnail backfill ----------------------------- */

interface StoredMap {
  world_id: number;
  internal_name: string;
  display_name: string;
  size_blocks: number;
  width: number;
  height: number;
  source: "lod0" | "cdn";
  source_ref: string;
  bytes_full: number;
  bytes_overview: number;
  bytes_thumb: number | null;
  captured_at: number;
  took_ms: number;
}

/**
 * Give already-captured worlds their missing thumbnail.
 *
 * Crucially this does NOT go back to the game servers: it downloads the full-resolution PNG we
 * already stored, downscales it and uploads the small one. A LOD0 capture costs twelve minutes
 * of a world server's time; re-fetching two dozen worlds just to produce a smaller copy of
 * something we already hold would be both slow and rude.
 *
 * The index row is re-sent in full, read back from the API rather than reconstructed, because
 * the upsert replaces every column: inventing the byte counts here would corrupt the totals
 * the storage cap is computed from.
 */
export async function backfillThumbs(
  worldIds: number[],
): Promise<{ done: number; skipped: number; errors: number; bytes: number }> {
  const out = { done: 0, skipped: 0, errors: 0, bytes: 0 };
  for (const id of worldIds) {
    try {
      const recRes = await fetch(`${config.apiBase}/api/v2/maps/${id}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!recRes.ok) throw new Error(`record -> HTTP ${recRes.status}`);
      const rec = (await recRes.json()) as StoredMap;
      if (rec.bytes_thumb !== null) {
        out.skipped++;
        continue;
      }

      const imgRes = await fetch(`${config.apiBase}/maps/${id}/full.png?v=${rec.captured_at}`, {
        signal: AbortSignal.timeout(180_000),
      });
      if (!imgRes.ok) throw new Error(`full.png -> HTTP ${imgRes.status}`);
      const img = decodePng(Buffer.from(await imgRes.arrayBuffer()));
      const thumbPng = encodePng(downscale(img, config.mapThumbPx));

      out.bytes += await putBlob(id, "thumb", thumbPng);
      await putRecord({ ...rec, bytes_thumb: thumbPng.length });
      out.done++;
      console.log(`  ${rec.display_name}: thumb ${(thumbPng.length / 1024).toFixed(0)} KB`);
    } catch (err) {
      out.errors++;
      console.warn(`  world ${id}: ${(err as Error).message}`);
    }
  }
  return out;
}
