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
import { encodePlotRuns, BeaconKeyError, buildSettlements, fetchBeacons } from "./beacons.ts";
import { postIngest, getJson, jsonObject, retryableStatus, describeFailure } from "./http.ts";

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WorldRow {
  id: number;
  display_name: string;
  api_url: string | null;
}

/** What the ingest tells us about a world we just sent. */
interface IngestResult {
  rows: number;
  /**
   * What happened to the plot-ownership grid: 'stored', 'skipped' (we sent none) or 'invalid'
   * (the validator refused it, with the reason in plotsError).
   *
   * The bot used to read `rows` and drop the rest of the response on the floor, so a rejected
   * grid produced no log line, no D1 row and no stats field: the world simply kept whatever
   * boundaries a previous capture had left it, indefinitely, with nothing anywhere saying so.
   */
  plots: "stored" | "skipped" | "invalid";
  plotsError?: string;
}

/**
 * POST one world's sweep, retrying transient failures.
 *
 * Worth it: a capture that already spent its time talking to the game server should not be
 * thrown away by a blip on our own side. Seen for real, a 404 arrived seconds after a Worker
 * deploy because the request reached an edge node still running the previous version, which
 * had no such route yet. Retrying rather than losing the world is obviously right.
 *
 * This job had its own retry loop months before the others did; the loop now lives in
 * http.ts and every job shares it. The one thing kept here is the shape of the answer: this
 * caller wants the parsed rows, and a failure is fatal FOR THIS WORLD, not for the run.
 *
 * A 404 is not in the shared retryable set (it is normally a wrong path, not a hiccup), so it
 * is added back here: the deploy race above is real and specific to this endpoint.
 */
async function postBeacons(payload: unknown): Promise<IngestResult> {
  const res = await postIngest("/api/ingest/beacons", payload, {
    timeoutMs: 60_000,
    backoffMs: [2_000, 4_000],
    retryStatus: (s) => s === 404 || retryableStatus(s),
  });
  if (res.ok) {
    const data = jsonObject<Partial<IngestResult>>(res);
    // A 200 we cannot parse is not "zero rows written": it is a world whose result we do not
    // know, and reporting it as zero would quietly understate the sweep.
    if (!data) throw new Error(`ingest answered HTTP ${res.status} with a body that is not JSON`);
    return { rows: data.rows ?? 0, plots: data.plots ?? "skipped", plotsError: data.plotsError };
  }
  // 401 means the token is wrong. The shared helper never retries it; say so plainly, because
  // it is the one failure here that no amount of waiting fixes.
  if (res.status === 401) throw new Error("ingest rejected the token (401)");
  throw new Error(`ingest failed after ${res.attempts} attempt(s): ${describeFailure(res)}`);
}

async function main(): Promise<void> {
  const filter = arg("worlds")?.split(",").map(Number).filter(Number.isFinite);
  const dryRun = hasFlag("dry-run");
  const deadline = Date.now() + config.beaconTimeBudgetMs;

  const all = (await getJson<{ results: WorldRow[] }>("/api/v2/worlds?limit=500")).results;
  const worlds = all.filter((w) => w.api_url && (!filter?.length || filter.includes(w.id)));
  console.log(`beacons: ${worlds.length} worlds, budget ${Math.round(config.beaconTimeBudgetMs / 60000)} min`);

  // Auditing is best-effort: never block a capture on the bookkeeping call, and never retry
  // the start, which INSERTs a row and returns its id. A duplicate open run row would sit in
  // the dashboard forever; a missing one costs nothing but the record of this sweep.
  let runId = 0;
  if (!dryRun) {
    const startRes = await postIngest("/api/ingest/beacons/run", { action: "start" }, { attempts: 1 });
    runId = jsonObject<{ id?: number }>(startRes)?.id ?? 0;
  }

  const started = Date.now();
  let done = 0;
  let errors = 0;
  let skipped = 0;
  let rows = 0;
  let totalBeacons = 0;
  let truncated = false;
  // Plot-map outcomes, tallied so a sweep that stops updating boundaries is explainable from
  // the run row rather than only from a log nobody reads.
  let plotsStored = 0;
  let plotsSkipped = 0;
  let plotsInvalid = 0;

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

      /*
       * SEND THE GRID ONLY IF OUR BEACON LIST IS COMPLETE.
       *
       * The run values in the grid are 1-based indices into the world's FULL beacon list. When
       * the world reports beacons that went missing mid-request (pack.skippedBeacons), our
       * list ends early while the grid does not, so it can reference a beacon we are not
       * sending. The ingest builds its owner mapping from the list in the same payload and
       * refuses any run value past its length, so this payload would be rejected with
       * certainty: measured across all 107 stored plot maps, max(run value) === owners.length
       * exactly, in every one, which means a single missing beacon is enough.
       *
       * So skip it, loudly. Sending it is pure waste (a 648 KB grid encoded, serialised and
       * posted to be thrown away) and it buries the reason: the world would keep the
       * boundaries from its last good capture with nothing saying why they stopped moving.
       * The beacons themselves are unaffected and still go, which is the valuable half.
       */
      const plotsUsable = pack.skippedBeacons === 0;
      if (!plotsUsable) {
        console.warn(
          `  ${w.display_name}: plot map skipped, the world dropped ${pack.skippedBeacons} ` +
            `beacon(s) mid-request so the grid indexes ${pack.beacons.length} + ` +
            `${pack.skippedBeacons} beacons and we only hold ${pack.beacons.length}. ` +
            `Beacons still sent; boundaries keep the previous capture until a clean one lands.`,
        );
      }

      if (!dryRun) {
        const payload = {
          worldId: w.id,
          worldSizePlots: pack.worldSizePlots,
          // The plot-ownership map, run-length encoded. It used to be dropped here as "a
          // megabyte per world of mostly-empty grid", which was true of the raw form and
          // false of this one: the grid is ~90% zeros in contiguous blocks, so RLE takes a
          // 648 KB grid to about 7 KB gzipped on the busiest world measured. It is what the
          // map needs to draw beacon boundaries, and there is no other source for it.
          // Omitted entirely (not sent empty) when the beacon list is short: the endpoint
          // treats an absent plotRuns as "this bot has nothing to say about the grid" and
          // leaves the stored one alone, which is the behaviour we want here.
          ...(plotsUsable ? { plotRuns: encodePlotRuns(pack.owner) } : {}),
          beacons: pack.beacons,
          settlements: settlements.map((s) => ({
            name: s.name, mayor: s.mayor, prestige: s.prestige, beacons: s.beacons,
            plots: s.plots, x: s.x, y: s.y, z: s.z,
          })),
        };
        const result = await postBeacons(payload);
        rows += result.rows;
        if (result.plots === "stored") plotsStored++;
        else if (result.plots === "invalid") {
          plotsInvalid++;
          // The one case nobody could see before. It means the grid and the beacon list
          // disagreed for a reason we have NOT accounted for above, so print the validator's
          // own words rather than a guess.
          console.warn(`  ${w.display_name}: plot map REJECTED: ${result.plotsError ?? "no reason given"}`);
        } else plotsSkipped++;
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
  // The plot tally is its own line rather than more commas on the first one: it answers a
  // different question (are the map boundaries still being updated?) from the beacon counts,
  // and it was the question nothing answered at all.
  const plotNote =
    `plot maps: ${plotsStored} stored, ${plotsSkipped} not sent, ${plotsInvalid} rejected`;
  console.log(
    `\ndone in ${mins} min: ${done} worlds, ${totalBeacons.toLocaleString()} beacons, ` +
      `${rows.toLocaleString()} rows written, ${skipped} skipped, ${errors} errors` +
      (truncated ? " (time budget reached)" : ""),
  );
  if (!dryRun) console.log(`  ${plotNote}`);

  if (runId) {
    // Retried, unlike the start: this updates the row by id, so repeating is a no-op.
    await postIngest("/api/ingest/beacons/run", {
      action: "finish", id: runId, worlds: done, beacons: totalBeacons, rows, errors,
      // Folded into the note because `beacon_runs` has no column for it. A rejected or
      // un-sent grid is now visible in the admin dashboard's run list instead of only in a
      // job log that expires.
      note: (truncated ? "time budget reached" : "ok") + `; ${plotNote}`,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
