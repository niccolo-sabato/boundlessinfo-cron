/**
 * Orchestrator for the full discovery + ingest run (the `run` / `poll-once`
 * scripts). Headless-friendly: relies on a pre-persisted Steam sentry, so it
 * never prompts. If the sentry is missing/expired it fails fast asking for a
 * local `npm run bootstrap`.
 *
 *   1. mint/reuse the DS query token (12h cache)
 *   2. probe SCAN_MIN..SCAN_MAX, collecting worlds + resources
 *   3. POST everything to the ingest API
 */

import { config } from "./config.ts";
import { scanWorlds, scanWorldIds, type DiscoveredWorld } from "./discover.ts";
import { ingestWorlds } from "./ingest.ts";

function logWorld(w: DiscoveredWorld): void {
  const kind = w.sovereign ? "sovereign" : w.lifetime ? "exo" : "perm";
  console.log(
    `  + world ${w.id} ${w.displayName ?? w.name ?? "?"} [${kind}] resources=${w.resources.length}`,
  );
}

async function main(): Promise<void> {
  // Optional CLI ids (`npm run run -- 7893 7901`): refresh worlds + resources for
  // just those ids (used by the 10-min poll for freshly detected new worlds).
  const idArgs = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);

  const started = Date.now();
  let scanResult;
  if (idArgs.length) {
    console.log(`[run] scanning ${idArgs.length} specified world id(s): ${idArgs.join(", ")}`);
    scanResult = await scanWorldIds(idArgs, (w) => logWorld(w));
  } else {
    const { scanMin, scanMax } = config;
    console.log(
      `[run] scanning world ids ${scanMin}..${scanMax} against ${config.dsBase} ` +
        `(${scanMax - scanMin + 1} ids)`,
    );
    scanResult = await scanWorlds(scanMin, scanMax, (w) => logWorld(w));
  }
  const { worlds, scanned, found } = scanResult;

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[run] scanned ${scanned} ids, found ${found} world(s) in ${elapsed}s`);

  const exoCount = worlds.filter((w) => w.lifetime && !w.sovereign).length;
  console.log(`[run] of which ${exoCount} look like exoworld(s)`);

  console.log(`[run] posting ${worlds.length} world(s) to ${config.apiBase}/api/ingest/worlds`);
  const result = await ingestWorlds(worlds);
  if (result.ok) {
    console.log(`[run] ingest ok (HTTP ${result.status}):`, JSON.stringify(result.body));
  } else {
    console.error(`[run] ingest FAILED (HTTP ${result.status}):`, JSON.stringify(result.body));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[run] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
