/**
 * Shopping capture CLI.
 *
 *   npm run shopping                 # mode from SHOP_MODE (default: hot)
 *   npm run shopping -- --mode=hot        # re-check only what is known to be traded
 *   npm run shopping -- --mode=discover   # rotating item shard across every world
 *   npm run shopping -- --mode=full       # everything (long; manual use)
 *   npm run shopping -- --rollup          # also snapshot today's price bands
 *   npm run shopping -- --worlds=1,31 --items=32805   # targeted, for testing
 *
 * The two scheduled modes complement each other:
 *  - "hot" keeps prices fresh cheaply (only (world,item,type) triples that hold listings).
 *  - "discover" finds NEW listings by rotating through item shards, so the whole catalogue
 *    is covered over a day while every single run stays time-bounded.
 * A fresh/empty database makes "hot" find nothing, so it automatically falls back to a
 * discovery sweep: the system bootstraps itself with no extra state to maintain.
 */

import { config } from "./config.ts";
import { captureShopping, ShopKeyError, type CaptureWorld } from "./shopping.ts";

const SITE_DATA = process.env.SITE_DATA_BASE ?? "https://boundlessinfo.pages.dev/data";

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Live worlds with an apiURL, from our own public API (single source of truth). */
async function loadWorlds(): Promise<CaptureWorld[]> {
  const data = await getJson<{ results: { id: number; api_url: string | null; display_name: string | null }[] }>(
    `${config.apiBase}/api/v2/worlds?limit=500`,
  );
  return data.results
    .filter((w) => typeof w.api_url === "string" && w.api_url)
    .map((w) => ({ id: w.id, apiUrl: w.api_url as string, name: w.display_name }));
}

/** Item game ids from the site's static catalogue (stays in sync with the site itself). */
async function loadItemIds(): Promise<number[]> {
  const items = await getJson<{ game_id: number }[]>(`${SITE_DATA}/items.json`);
  return items.map((i) => i.game_id).filter((n) => Number.isFinite(n));
}

async function main(): Promise<void> {
  const mode = (arg("mode") ?? process.env.SHOP_MODE ?? "hot") as "hot" | "discover" | "full";
  if (!["hot", "discover", "full"].includes(mode)) throw new Error(`unknown mode ${mode}`);

  const worldFilter = arg("worlds")?.split(",").map(Number).filter(Number.isFinite);
  const itemFilter = arg("items")?.split(",").map(Number).filter(Number.isFinite);

  let worlds = await loadWorlds();
  if (worldFilter?.length) worlds = worlds.filter((w) => worldFilter.includes(w.id));
  const itemIds = itemFilter?.length ? itemFilter : await loadItemIds();

  const shards = config.shopShards;
  // Rotate the discovery shard by wall-clock hour so consecutive scheduled runs cover
  // different slices of the catalogue without any stored cursor.
  const shard = Number(arg("shard") ?? process.env.SHOP_SHARD ?? NaN);
  const effectiveShard = Number.isFinite(shard)
    ? shard
    : Math.floor(new Date().getUTCHours() / (24 / shards)) % shards;

  // Items already proven non-tradeable (403). Skipping them keeps every sweep cheaper and
  // is the mechanism that makes the catalogue self-maintaining.
  let skipItems: number[] = [];
  try {
    skipItems = (await getJson<{ items: number[] }>(`${config.apiBase}/api/v2/shopping/skip-items`)).items ?? [];
  } catch {
    // Best-effort: without the list we simply re-learn the 403s during this run.
  }

  let active: Record<string, { S: number[]; B: number[] }> | undefined;
  let effectiveMode = mode;
  if (mode === "hot") {
    const res = await getJson<{ worlds: Record<string, { S: number[]; B: number[] }> }>(
      `${config.apiBase}/api/v2/shopping/active`,
    );
    active = res.worlds;
    const pairs = Object.values(active).reduce((n, a) => n + a.S.length + a.B.length, 0);
    if (pairs === 0) {
      console.log("hot sweep: nothing known yet, falling back to a discovery sweep");
      effectiveMode = "discover";
    }
  }

  console.log(
    `worlds ${worlds.length} | items ${itemIds.length} | mode ${effectiveMode}` +
      (effectiveMode === "discover" ? ` | shard ${effectiveShard}/${shards}` : "") +
      (skipItems.length ? ` | skipping ${skipItems.length} non-tradeable items` : ""),
  );

  // Open an audit row so a run that dies is still visible in the admin dashboard.
  let runId = 0;
  try {
    const res = await fetch(`${config.apiBase}/api/ingest/shopping/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
      body: JSON.stringify({ action: "start", mode: effectiveMode }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) runId = ((await res.json()) as { id?: number }).id ?? 0;
  } catch {
    // Auditing is best-effort: never block a capture because the bookkeeping call failed.
  }

  const started = Date.now();
  let note = "";
  try {
    const stats = await captureShopping({
      mode: effectiveMode,
      worlds,
      itemIds,
      active,
      skipItems,
      shard: effectiveShard,
      shards,
    });
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(
      `done in ${mins} min: ${stats.requests} requests, ${stats.listings} listings seen, ` +
        `${stats.rowsWritten} rows written, ${stats.worldsDone} worlds, ${stats.errors} errors, ` +
        `${stats.skippedItems} items marked not-tradeable` +
        (stats.truncated ? " (time budget reached, remainder next run)" : ""),
    );
    note = stats.truncated ? "time budget reached" : "ok";
    if (runId) {
      await fetch(`${config.apiBase}/api/ingest/shopping/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
        body: JSON.stringify({
          action: "finish", id: runId, worlds: stats.worldsDone, requests: stats.requests,
          listings: stats.listings, rows: stats.rowsWritten, errors: stats.errors, note,
        }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => {});
    }
  } catch (err) {
    if (err instanceof ShopKeyError) {
      console.error(`FATAL: ${err.message}. Aborting so we do not hammer the game servers.`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (hasFlag("rollup")) {
    const res = await fetch(`${config.apiBase}/api/ingest/shopping/rollup`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60_000),
    });
    console.log(`rollup: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
