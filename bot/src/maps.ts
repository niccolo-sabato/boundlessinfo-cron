/**
 * Planet map capture: turns a world into a stored image, 1 pixel per block.
 *
 * Two sources, deliberately:
 *
 *  - **LOD0** (`<apiURL>/lod0`, blessed key): the current world, GZIP TGA, streamed back over
 *    9 to 10 minutes because the server paces itself so the request cannot disturb play. This
 *    is the real source. It is also the slow one, which is why capture runs early and often
 *    while everything else is being built.
 *  - **The free CDN** (`maps.playboundless.com/<date>/<internal>.png`): the same 1px/block
 *    image, no key, no wait, but frozen in 2020. Good enough to give a permanent world a
 *    baseline picture immediately, and it costs neither key budget nor ten minutes. Every
 *    CDN map is eventually replaced by a LOD0 one.
 *
 * The politeness rules are the shopping ones: one request at a time, honour `Retry-After`,
 * bound the run by wall-clock time and let the remainder wait for the next run.
 *
 * The storage cap is enforced by the ingest endpoint (which is where it cannot be bypassed),
 * and mirrored here so a run stops early rather than making a doomed round trip per world.
 */

import { config } from "./config.ts";
import { decodePng, decodeTga, downscale, encodePng, type Raster } from "./image.ts";
import { gunzipSync } from "node:zlib";

export interface MapWorld {
  id: number;
  /** Internal name, e.g. "euc3_t0_2". Also the file name on the free CDN. */
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
  skipped: number;
  truncated: boolean;
  /** Set when the server refused an upload because the storage cap was reached. */
  capped: boolean;
}

export interface MapCaptureOptions {
  /** 'cdn' takes the free frozen images; 'lod0' generates current ones; 'auto' does both. */
  mode: "cdn" | "lod0" | "auto";
  worlds: MapWorld[];
  /** world id -> what we already hold, from /api/v2/maps/coverage. */
  coverage: Record<string, { at: number; source: string }>;
  /** World ids known to have shops. Maps exist to make shops findable, so these come first. */
  shopWorlds: Set<number>;
  /** Stop before starting another world once this many are done. */
  maxWorlds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when the storage cap was hit: the run ends, it does not retry. */
export class MapCapError extends Error {}

/* ----------------------------- Sources ----------------------------- */

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
    const gz = Buffer.from(await res.arrayBuffer());
    if (gz.length === 0) throw new Error("empty response");
    // The endpoint advertises GZIP, but fetch transparently decompresses when the server
    // also sets Content-Encoding, so accept either and let the magic bytes decide.
    const tga = gz[0] === 0x1f && gz[1] === 0x8b ? gunzipSync(gz) : gz;
    return decodeTga(tga);
  }
  throw new Error("world stayed busy across every attempt");
}

/** Fetch the frozen 2020 image, if one exists for this world. Returns null when it does not. */
async function fetchCdn(world: MapWorld): Promise<Raster | null> {
  const url = `https://maps.playboundless.com/${config.mapCdnDate}/${world.name}.png`;
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`CDN HTTP ${res.status}`);
  return decodePng(Buffer.from(await res.arrayBuffer()));
}

/* ----------------------------- Upload ----------------------------- */

async function putBlob(worldId: number, variant: "full" | "overview", png: Buffer): Promise<number> {
  const res = await fetch(
    `${config.apiBase}/api/ingest/map/blob?world=${worldId}&variant=${variant}`,
    {
      method: "POST",
      headers: { "content-type": "image/png", authorization: `Bearer ${config.ingestToken}` },
      body: png,
      signal: AbortSignal.timeout(180_000),
    },
  );
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

interface Job {
  world: MapWorld;
  source: "lod0" | "cdn";
  /** Lower sorts first. */
  priority: number;
  why: string;
}

/**
 * Decide what this run should spend its time on.
 *
 * The ordering is the whole point, because a run only gets through a handful of LOD0 worlds:
 *   1. Worlds with shops and no map at all. This is what the release actually needs.
 *   2. Any other world with no map.
 *   3. Worlds whose only map is a frozen 2020 CDN image, upgraded to a current one.
 *   4. Worlds whose LOD0 map has gone stale.
 * Sovereign and exo worlds never had a 2020 image, so for them LOD0 is the only option.
 */
export function planMapWork(opts: MapCaptureOptions): Job[] {
  const now = Math.floor(Date.now() / 1000);
  const staleAfter = config.mapRefreshDays * 86400;
  const jobs: Job[] = [];

  for (const w of opts.worlds) {
    const side = w.worldSize * 16;
    if (!Number.isFinite(side) || side <= 0 || side > config.mapMaxSideBlocks) continue;
    const held = opts.coverage[String(w.id)];
    const hasShops = opts.shopWorlds.has(w.id);
    const canCdn = w.isPerm; // only worlds that existed in 2020 have a frozen image
    const canLod0 = Boolean(w.apiUrl);

    if (!held) {
      // Nothing at all: take whichever source the mode allows, cheapest first.
      if (opts.mode !== "lod0" && canCdn) {
        jobs.push({ world: w, source: "cdn", priority: hasShops ? 0 : 2, why: "no map yet" });
      } else if (opts.mode !== "cdn" && canLod0) {
        jobs.push({ world: w, source: "lod0", priority: hasShops ? 1 : 3, why: "no map yet" });
      }
      continue;
    }
    if (opts.mode === "cdn") continue; // a CDN sweep never revisits a world it already covered
    if (!canLod0) continue;
    if (held.source === "cdn") {
      jobs.push({ world: w, source: "lod0", priority: hasShops ? 4 : 6, why: "upgrading the 2020 image" });
    } else if (now - held.at > staleAfter) {
      jobs.push({ world: w, source: "lod0", priority: hasShops ? 5 : 7, why: `${Math.round((now - held.at) / 86400)} days old` });
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
    worldsDone: 0, bytesWritten: 0, errors: 0, skipped: 0, truncated: false, capped: false,
  };

  const jobs = planMapWork(opts).slice(0, opts.maxWorlds);
  console.log(`map capture ${opts.mode}: ${jobs.length} worlds planned, budget ${Math.round(config.mapTimeBudgetMs / 60000)} min`);
  for (const j of jobs) console.log(`  - ${j.world.displayName} via ${j.source} (${j.why})`);

  for (const job of jobs) {
    if (Date.now() > deadline) {
      stats.truncated = true;
      console.log("time budget reached, the rest waits for the next run");
      break;
    }
    const { world } = job;
    const side = world.worldSize * 16;
    const started = Date.now();
    console.log(`\n${world.displayName} (${world.name}) via ${job.source}, expecting ${side}x${side}`);

    try {
      const img = job.source === "lod0" ? await fetchLod0(world) : await fetchCdn(world);
      if (!img) {
        // Only reachable on the CDN path, and only when the frozen mirror has no such file.
        console.log("  no image at that source, skipping");
        stats.skipped++;
        continue;
      }
      if (img.width !== side || img.height !== side) {
        // A mismatch means the block/pixel mapping we draw markers with would be wrong, and a
        // map that puts shops in the wrong place is worse than no map at all.
        console.log(`  ! got ${img.width}x${img.height} but the world is ${side} blocks: refusing it`);
        stats.errors++;
        continue;
      }

      const fullPng = encodePng(img);
      const overviewPng = encodePng(downscale(img, config.mapOverviewPx));
      console.log(
        `  encoded: full ${(fullPng.length / 1048576).toFixed(2)} MB, ` +
          `overview ${(overviewPng.length / 1024).toFixed(0)} KB`,
      );

      stats.bytesWritten += await putBlob(world.id, "full", fullPng);
      stats.bytesWritten += await putBlob(world.id, "overview", overviewPng);
      await putRecord({
        world_id: world.id,
        internal_name: world.name,
        display_name: world.displayName,
        size_blocks: side,
        width: img.width,
        height: img.height,
        source: job.source,
        source_ref: job.source === "cdn" ? config.mapCdnDate : "",
        bytes_full: fullPng.length,
        bytes_overview: overviewPng.length,
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
