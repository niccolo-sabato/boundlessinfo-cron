/**
 * Planet map capture CLI.
 *
 *   npm run maps                        # mode from MAP_MODE (default: auto)
 *   npm run maps -- --mode=cdn          # free frozen images only: fast, no key, no waiting
 *   npm run maps -- --mode=lod0         # generate current maps from the game servers (slow)
 *   npm run maps -- --worlds=36 --mode=lod0   # one world, for testing
 *   npm run maps -- --dry-run           # print the plan and stop
 *
 * The two modes complement each other exactly as the shopping modes do: "cdn" gives every
 * permanent world a picture within one short run, while "lod0" spends its whole budget
 * replacing those with current terrain and covering the sovereign and exo worlds the frozen
 * mirror never had. Both are bounded by wall-clock time, so an interrupted run simply leaves
 * work for the next one.
 */

import { config } from "./config.ts";
import { captureMaps, planMapWork, type MapWorld } from "./maps.ts";

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

interface WorldRow {
  id: number;
  name: string;
  display_name: string;
  world_size: number;
  api_url: string | null;
  is_perm: boolean;
}

async function main(): Promise<void> {
  const mode = (arg("mode") ?? process.env.MAP_MODE ?? "auto") as "cdn" | "lod0" | "auto";
  if (!["cdn", "lod0", "auto"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const worldFilter = arg("worlds")?.split(",").map(Number).filter(Number.isFinite);
  const maxWorlds = Number(arg("max") ?? config.mapMaxPerRun);

  const worldRows = (await getJson<{ results: WorldRow[] }>(`${config.apiBase}/api/v2/worlds?limit=500`)).results;
  let worlds: MapWorld[] = worldRows.map((w) => ({
    id: w.id,
    name: w.name,
    displayName: w.display_name || w.name,
    worldSize: w.world_size,
    apiUrl: w.api_url,
    isPerm: Boolean(w.is_perm),
  }));
  if (worldFilter?.length) worlds = worlds.filter((w) => worldFilter.includes(w.id));

  const cov = await getJson<{
    worlds: Record<string, { at: number; source: string }>;
    budget: { worlds: number; bytes: number; capWorlds: number; capBytes: number; full: boolean };
  }>(`${config.apiBase}/api/v2/maps/coverage`);

  console.log(
    `storage: ${cov.budget.worlds}/${cov.budget.capWorlds} worlds, ` +
      `${(cov.budget.bytes / 1048576).toFixed(0)} MB of ${(cov.budget.capBytes / 1048576).toFixed(0)} MB allowed`,
  );
  if (cov.budget.full) {
    // The cap is a deliberate stop, so it is reported as a clean exit rather than an error.
    console.log("storage cap reached: nothing will be captured until maps are pruned or the cap is raised");
    return;
  }

  // Shops are why the maps exist, so worlds that trade are captured first.
  let shopWorlds = new Set<number>();
  try {
    const active = await getJson<{ worlds: Record<string, unknown> }>(`${config.apiBase}/api/v2/shopping/active`);
    shopWorlds = new Set(Object.keys(active.worlds ?? {}).map(Number));
  } catch {
    // Only affects ordering, never correctness.
  }

  const opts = { mode, worlds, coverage: cov.worlds, shopWorlds, maxWorlds };

  if (hasFlag("dry-run")) {
    const jobs = planMapWork(opts);
    console.log(`\nplan (${jobs.length} worlds, would take the first ${maxWorlds}):`);
    for (const [i, j] of jobs.entries()) {
      console.log(`  ${String(i + 1).padStart(3)}. ${j.world.displayName.padEnd(20)} ${j.source.padEnd(5)} ${j.why}`);
    }
    return;
  }

  let runId = 0;
  try {
    const res = await fetch(`${config.apiBase}/api/ingest/map/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
      body: JSON.stringify({ action: "start", mode }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) runId = ((await res.json()) as { id?: number }).id ?? 0;
  } catch {
    // Auditing is best-effort: never block a capture because the bookkeeping call failed.
  }

  const started = Date.now();
  const stats = await captureMaps(opts);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(
    `\ndone in ${mins} min: ${stats.worldsDone} worlds mapped, ` +
      `${(stats.bytesWritten / 1048576).toFixed(1)} MB written, ${stats.skipped} skipped, ${stats.errors} errors` +
      (stats.capped ? " (STOPPED: storage cap)" : "") +
      (stats.truncated ? " (time budget reached, remainder next run)" : ""),
  );

  if (runId) {
    const note = stats.capped ? "storage cap reached" : stats.truncated ? "time budget reached" : "ok";
    await fetch(`${config.apiBase}/api/ingest/map/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ingestToken}` },
      body: JSON.stringify({
        action: "finish", id: runId, worlds: stats.worldsDone, bytes: stats.bytesWritten,
        errors: stats.errors, note,
      }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {});
  }

  // A capture that stopped on the cap is a condition the owner should see in the job status,
  // not something to swallow: exit non-zero so the workflow alerts.
  if (stats.capped) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
