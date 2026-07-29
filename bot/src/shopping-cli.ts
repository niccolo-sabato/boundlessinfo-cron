/**
 * Shopping capture CLI.
 *
 *   npm run shopping                 # mode from SHOP_MODE (default: hot)
 *   npm run shopping -- --mode=hot        # re-check only what is known to be traded
 *   npm run shopping -- --mode=discover   # hunt the busiest items not yet found anywhere
 *   npm run shopping -- --mode=full       # everything (long; manual use)
 *   npm run shopping -- --rollup          # also snapshot today's price bands
 *   npm run shopping -- --worlds=1,31 --items=32805   # targeted, for testing
 *
 * The two scheduled modes complement each other:
 *  - "hot" keeps prices fresh cheaply (only (world,item,type) triples that hold listings).
 *  - "discover" walks the trade-volume ranking for items we hold nothing on, so the
 *    catalogue fills busiest-first while every single run stays time-bounded.
 * A fresh/empty database makes "hot" find nothing, so it automatically falls back to a
 * discovery sweep: the system bootstraps itself with no extra state to maintain.
 */

import { config } from "./config.ts";
import { captureShopping, EST_UNIT_MS, ShopKeyError, type CaptureWorld } from "./shopping.ts";

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

/**
 * Item ids ordered by how much they actually trade, busiest first.
 *
 * Derived from the mirrored BUTT snapshot and committed as static data. Only used to decide
 * what discovery looks at first; if it is missing we fall back to catalogue order, which is
 * how the sweep behaved before and is merely slower to find the interesting things.
 */
async function loadPriority(): Promise<number[]> {
  try {
    const ids = await getJson<number[]>(`${SITE_DATA}/shop-priority.json`);
    return Array.isArray(ids) ? ids.filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const mode = (arg("mode") ?? process.env.SHOP_MODE ?? "hot") as "hot" | "discover" | "full";
  if (!["hot", "discover", "full"].includes(mode)) throw new Error(`unknown mode ${mode}`);

  const worldFilter = arg("worlds")?.split(",").map(Number).filter(Number.isFinite);
  const itemFilter = arg("items")?.split(",").map(Number).filter(Number.isFinite);

  let worlds = await loadWorlds();
  if (worldFilter?.length) worlds = worlds.filter((w) => worldFilter.includes(w.id));
  const itemIds = itemFilter?.length ? itemFilter : await loadItemIds();
  const priority = await loadPriority();

  const shards = config.shopShards;
  // Rotate the discovery shard by wall-clock hour so consecutive scheduled runs cover
  // different slices of the catalogue without any stored cursor.
  const shard = Number(arg("shard") ?? process.env.SHOP_SHARD ?? NaN);
  // Advances once per scheduled run (every 2 hours) and keeps advancing across days, so the
  // window walks the whole priority list instead of revisiting the same slice each day.
  const effectiveShard = Number.isFinite(shard)
    ? shard
    : Math.floor(Date.now() / (2 * 60 * 60 * 1000));

  // Always loaded: "hot" scans exactly these keys, and "discover" uses them to visit
  // already-trading worlds first (see captureShopping).
  let active: Record<string, { S: number[]; B: number[] }> = {};
  try {
    active = (
      await getJson<{ worlds: Record<string, { S: number[]; B: number[] }> }>(
        `${config.apiBase}/api/v2/shopping/active`,
      )
    ).worlds ?? {};
  } catch {
    // Without it "hot" simply finds nothing and falls back to discovery below.
  }
  let effectiveMode = mode;
  const pairs = Object.values(active).reduce((n, a) => n + a.S.length + a.B.length, 0);
  if (mode === "hot" && pairs === 0) {
    console.log("hot sweep: nothing known yet, falling back to a discovery sweep");
    effectiveMode = "discover";
  }

  console.log(
    `worlds ${worlds.length} | items ${itemIds.length} | mode ${effectiveMode}` +
      (effectiveMode === "discover" ? ` | shard ${effectiveShard}/${shards}` : ""),
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
    // Sized so a run can actually finish what it plans: the budget in requests, divided by
    // the two shop types and the worlds we will visit. Anything larger is just truncation.
    // Every item we already hold a listing for, anywhere. The hot sweep keeps these fresh, so
    // discovery can stop hunting them and move down the ranking.
    const knownItems = new Set<number>();
    for (const a of Object.values(active)) {
      for (const id of a.S) knownItems.add(id);
      for (const id of a.B) knownItems.add(id);
    }

    // The run's REAL queue is the known-trading worlds plus the explore handful; the engine
    // caps cold worlds to that handful even when the database is empty. Falling back to "all
    // worlds" here (an earlier version did) made this divisor an order of magnitude too big
    // on a bootstrap run, so the window came out tiny and the budget went unused.
    const tradingWorlds =
      Math.max(1, Object.keys(active).length + Number(process.env.SHOP_EXPLORE_WORLDS ?? 8));
    // Units a run can afford: the budget divided by the measured per-unit cost, multiplied
    // by the lanes, then split over the two shop types and the worlds visited.
    const lanes = Math.max(1, config.shopWorldConcurrency);
    const affordable = Math.floor(
      ((config.shopTimeBudgetMs / EST_UNIT_MS) * lanes) / 2 / tradingWorlds,
    );
    const window = config.shopDiscoverWindow > 0 ? config.shopDiscoverWindow : Math.max(10, affordable);
    if (effectiveMode === "discover") {
      console.log(
        `discovery walks ${window} items this run, ${knownItems.size} already found` +
          (priority.length ? `, busiest first (${priority.length} ranked)` : ", catalogue order (no ranking available)"),
      );
    }

    const stats = await captureShopping({
      mode: effectiveMode,
      worlds,
      itemIds,
      active,
      shard: effectiveShard,
      shards,
      priority,
      window,
      exploreColdWorlds: Number(process.env.SHOP_EXPLORE_WORLDS ?? 8),
      knownItems,
    });
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(
      `done in ${mins} min: ${stats.itemsDone}/${stats.itemsDone + stats.errors} units verified, ` +
        `${stats.listings} listings, ${stats.rowsWritten} rows written, ` +
        `${stats.worldsDone} worlds (${stats.worldsSkipped} skipped on 503)` +
        (stats.truncated ? " (time budget reached, remainder next run)" : ""),
    );
    console.log(
      `  responses: ${stats.ok} ok, ${stats.shed} shed(403), ${stats.busy} busy(503), ` +
        `${stats.overrate} overrate(429), ${stats.netErrors} network, of ${stats.requests} requests` +
        (stats.ingestErrors ? `; ${stats.ingestErrors} ingest failures (data retried in-run)` : ""),
    );
    if (stats.overrate > 0) {
      console.warn(
        `  WARNING: ${stats.overrate} responses were 429. The serial lane should make that ` +
          `impossible; if this repeats, something else is using this key concurrently.`,
      );
    }
    note = stats.truncated
      ? "time budget reached"
      : stats.ingestErrors
        ? `ok (${stats.ingestErrors} ingest failures)`
        : "ok";
    if (runId) {
      await fetch(`${config.apiBase}/api/ingest/shopping/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
        body: JSON.stringify({
          action: "finish", id: runId, worlds: stats.worldsDone, requests: stats.requests,
          listings: stats.listings, rows: stats.rowsWritten,
          // errors = units left unverified; ingest failures are a different animal (verified
          // but unwritten) and would otherwise hide behind a green run in the dashboard.
          errors: stats.errors + stats.ingestErrors, note,
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
