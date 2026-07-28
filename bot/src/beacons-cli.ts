/**
 * Beacon capture CLI.
 *
 *   npm run beacons                  # every live world
 *   npm run beacons -- --worlds=36   # specific worlds, for testing
 *   npm run beacons -- --dry-run     # fetch and summarise, ingest nothing
 *
 * Fast enough to sweep the whole universe in one run (about 15 seconds a world), so unlike the
 * map capture there is no queue and no priority order: it just does all of them.
 *
 * WHAT THIS REPLACES. The authenticated world poll reports settlements, but only the top five
 * per world, which is why a player asking why their settlement was missing had to be told it
 * was an API limitation. This endpoint returns every beacon, so the cap disappears.
 *
 * WHAT IT STILL CANNOT DO. The game's SETTLEMENT NAME is not the name of any beacon in it, and
 * is not in this response. Measured on Gellis: the settlement the poll calls "Zeebrugge",
 * mayor Reapers, is exactly one beacon, prestige 6,743,971 to the digit, and that beacon is
 * called "Floating Island" with mayor RedY3. So beacon names here are real and complete, while
 * a cluster is only ever labelled by its largest beacon, and the site must say so rather than
 * pass it off as the settlement's name.
 */

import { config } from "./config.ts";
import { BeaconKeyError, buildSettlements, fetchBeacons } from "./beacons.ts";

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface WorldRow {
  id: number;
  display_name: string;
  api_url: string | null;
}

/**
 * POST one world's sweep, retrying transient failures.
 *
 * Worth the few lines: a capture that already spent its time talking to the game server should
 * not be thrown away by a blip on our own side. Seen for real, a `404` arrived seconds after a
 * Worker deploy because the request reached an edge node still running the previous version,
 * which had no such route yet. Retrying rather than losing the world is obviously right.
 */
async function postIngest(payload: string): Promise<number> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(2000 * attempt);
    try {
      const res = await fetch(`${config.apiBase}/api/ingest/beacons`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return ((await res.json()) as { rows?: number }).rows ?? 0;
      // 401 means the token is wrong; retrying just repeats the mistake.
      if (res.status === 401) throw new Error("ingest rejected the token (401)");
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`;
    } catch (err) {
      if ((err as Error).message.includes("401")) throw err;
      last = (err as Error).message;
    }
  }
  throw new Error(`ingest failed after 3 attempts: ${last}`);
}

async function main(): Promise<void> {
  const filter = arg("worlds")?.split(",").map(Number).filter(Number.isFinite);
  const dryRun = hasFlag("dry-run");
  const deadline = Date.now() + config.beaconTimeBudgetMs;

  const all = (await getJson<{ results: WorldRow[] }>(`${config.apiBase}/api/v2/worlds?limit=500`)).results;
  const worlds = all.filter((w) => w.api_url && (!filter?.length || filter.includes(w.id)));
  console.log(`beacons: ${worlds.length} worlds, budget ${Math.round(config.beaconTimeBudgetMs / 60000)} min`);

  let runId = 0;
  if (!dryRun) {
    try {
      const res = await fetch(`${config.apiBase}/api/ingest/beacons/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
        body: JSON.stringify({ action: "start" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) runId = ((await res.json()) as { id?: number }).id ?? 0;
    } catch {
      // Auditing is best-effort: never block a capture on the bookkeeping call.
    }
  }

  const started = Date.now();
  let done = 0;
  let errors = 0;
  let skipped = 0;
  let rows = 0;
  let totalBeacons = 0;
  let truncated = false;

  for (const w of worlds) {
    if (Date.now() > deadline) {
      truncated = true;
      console.log("time budget reached, the rest waits for the next run");
      break;
    }
    try {
      const pack = await fetchBeacons(w.api_url!);
      if (!pack) {
        skipped++;
        console.log(`  ${w.display_name}: unavailable (503), skipping`);
        continue;
      }
      const settlements = buildSettlements(pack);
      totalBeacons += pack.beacons.length;
      done++;
      console.log(
        `  ${w.display_name.padEnd(20)} ${String(pack.beacons.length).padStart(4)} beacons, ` +
          `${String(settlements.length).padStart(4)} clusters`,
      );

      if (!dryRun) {
        const payload = JSON.stringify({
          worldId: w.id,
          worldSizePlots: pack.worldSizePlots,
          // The plot-column map is deliberately NOT sent. It is a megabyte per world of
          // mostly-empty grid, and everything we currently draw comes from the beacon list
          // and the clustering already computed here.
          beacons: pack.beacons,
          settlements: settlements.map((s) => ({
            name: s.name, mayor: s.mayor, prestige: s.prestige, beacons: s.beacons,
            plots: s.plots, x: s.x, y: s.y, z: s.z,
          })),
        });
        rows += await postIngest(payload);
      }
    } catch (err) {
      if (err instanceof BeaconKeyError) {
        console.error(`FATAL: ${err.message}. Stopping so we do not hammer the servers.`);
        process.exitCode = 1;
        return;
      }
      errors++;
      console.warn(`  ${w.display_name}: ${(err as Error).message}`);
    }
    await sleep(config.beaconDelayMs);
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(
    `\ndone in ${mins} min: ${done} worlds, ${totalBeacons.toLocaleString()} beacons, ` +
      `${rows.toLocaleString()} rows written, ${skipped} skipped, ${errors} errors` +
      (truncated ? " (time budget reached)" : ""),
  );

  if (runId) {
    await fetch(`${config.apiBase}/api/ingest/beacons/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
      body: JSON.stringify({
        action: "finish", id: runId, worlds: done, beacons: totalBeacons, rows, errors,
        note: truncated ? "time budget reached" : "ok",
      }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
