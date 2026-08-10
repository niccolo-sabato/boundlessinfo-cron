/**
 * CLI: capture live block colours for worlds and ingest them.
 *   npm run capture 6096 7891 ...   capture specific world ids
 *   npm run capture -- --all         capture EVERY world (perms + sovereigns + exos)
 *   npm run capture -- --sovereigns  capture ONLY sovereign worlds
 * Headless: uses the persisted Steam refresh token (no game / no proxy).
 *
 * Only SOVEREIGN worlds can change colours after they spawn (the owner re-themes):
 * permanent worlds have fixed colours forever, and an exoworld keeps its spawn colours
 * for its whole life. So the periodic 6-hour refresh only needs `--sovereigns`; new
 * exos are colour-captured once, on discovery, by the 10-minute poll. The colour ingest
 * is already change-aware (it skips the KV write when a world's colours are unchanged).
 */
import { captureWorldColours, ingestColours } from "./capture-colors.ts";
import { describeFailure, getJson } from "./http.ts";
import { config } from "./config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Every world id to capture: the public discovery (reliable list of perms +
 * public sovereigns) UNION our API (adds exos + private sovereigns). The API can
 * transiently return a degenerate 1-world response, so we only trust it when it
 * lists more than one and always fall back to the discovery.
 */
async function getAllWorldIds(): Promise<number[]> {
  const ids = new Set<number>();

  try {
    // Someone else's host, so not through the shared client, but it had no timeout at all:
    // a hang here could only end when the workflow's own clock ran out.
    const r = await fetch(`${config.dsBase}/list-gameservers`, { signal: AbortSignal.timeout(30_000) });
    if (r.ok) {
      for (const w of (await r.json()) as { id?: number }[]) {
        if (Number.isFinite(w.id)) ids.add(w.id as number);
      }
    }
  } catch {
    /* discovery unreachable; rely on the API */
  }

  try {
    const list = (await getJson<{ results?: { id?: number }[] }>("/api/v2/worlds")).results ?? [];
    if (list.length > 1) {
      for (const w of list) if (Number.isFinite(w.id)) ids.add(w.id as number);
    }
  } catch {
    /* API unreachable; rely on the discovery */
  }

  return [...ids];
}

/** Only the Sovereign worlds (the only ones whose colours can change after spawn). */
async function getSovereignIds(): Promise<number[]> {
  try {
    const list =
      (await getJson<{ results?: { id?: number }[] }>("/api/v2/worlds?is_sovereign=true&limit=500")).results ?? [];
    return list.map((w) => w.id).filter((n): n is number => Number.isFinite(n) && (n as number) > 0);
  } catch {
    /* API unreachable */
  }
  return [];
}

/**
 * Worlds with LIVE-captured colours that are worth refreshing: Sovereign (colours can
 * change) + Exo (colours are fixed, but this is a cheap backstop if the 10-min poll's
 * colour capture for a newly-spawned exo ever failed). Permanent worlds are excluded:
 * their colours are fixed and served from the static snapshot, so capturing them is wasted.
 */
async function getNonPermIds(): Promise<number[]> {
  try {
    const list =
      (await getJson<{ results?: { id?: number; is_perm?: boolean }[] }>("/api/v2/worlds?limit=500")).results ?? [];
    return list
      .filter((w) => !w.is_perm)
      .map((w) => w.id)
      .filter((n): n is number => Number.isFinite(n) && (n as number) > 0);
  } catch {
    /* API unreachable */
  }
  return [];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let ids: number[];
  if (args.includes("--all")) {
    ids = await getAllWorldIds();
    console.log(`[capture] --all: ${ids.length} worlds from /api/v2/worlds`);
  } else if (args.includes("--sovereigns")) {
    ids = await getSovereignIds();
    console.log(`[capture] --sovereigns: ${ids.length} sovereign worlds`);
  } else if (args.includes("--non-perm")) {
    ids = await getNonPermIds();
    console.log(`[capture] --non-perm: ${ids.length} sovereign + exo worlds`);
  } else {
    ids = args.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  }
  if (ids.length === 0) {
    console.error("usage: npm run capture <worldId ...>   |   npm run capture -- --all");
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  // Counted apart from `fail` on purpose. A world that answers no world-config is ordinary (it
  // may be starting, or locked) and must not colour the job red. An ingest that failed three
  // attempts is our own side losing a capture we already paid for, and that is worth the job
  // going red: the colours are not lost for good, because the 6-hourly sweep re-captures every
  // sovereign and exo with --non-perm, but that sweep runs under continue-on-error and never
  // alerts, so this is the only place a standing ingest failure is ever visible.
  let ingestFailures = 0;
  for (const id of ids) {
    try {
      const r = await captureWorldColours(id);
      if (!r) {
        fail++;
        console.log(`[capture] world ${id}: no world-config`);
      } else {
        const res = await ingestColours(r);
        if (res.ok) {
          ok++;
          const retried = res.attempts > 1 ? ` (${res.attempts} attempts)` : "";
          console.log(`[capture] world ${id}: ${Object.keys(r.blockColors).length} colours -> OK${retried}`);
        } else {
          fail++;
          ingestFailures++;
          console.log(`[capture] world ${id}: ingest FAILED - ${describeFailure(res)}`);
        }
      }
    } catch (e) {
      fail++;
      console.log(`[capture] world ${id}: ERROR ${e instanceof Error ? e.message : e}`);
    }
    await sleep(1200); // be a good citizen between worlds
  }
  console.log(`[capture] done: ${ok} ok, ${fail} failed` + (ingestFailures ? `, of which ${ingestFailures} ingest failure(s)` : ""));
  if (ingestFailures) {
    console.error(`[capture] ${ingestFailures} capture(s) could not be written to the API; failing the job so it is seen`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[capture] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
