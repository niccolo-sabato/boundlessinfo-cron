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
import { scanWorlds } from "./discover.ts";
import { ingestWorlds } from "./ingest.ts";

async function main(): Promise<void> {
  const { scanMin, scanMax } = config;
  console.log(
    `[run] scanning world ids ${scanMin}..${scanMax} against ${config.dsBase} ` +
      `(${scanMax - scanMin + 1} ids)`,
  );

  const started = Date.now();
  const { worlds, scanned, found } = await scanWorlds(scanMin, scanMax, (w) => {
    const kind = w.sovereign ? "sovereign" : w.lifetime ? "exo" : "perm";
    console.log(
      `  + world ${w.id} ${w.displayName ?? w.name ?? "?"} ` +
        `[${kind}] resources=${w.resources.length}`,
    );
  });

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
