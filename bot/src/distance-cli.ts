/**
 * `npm run distances` - for every Sovereign / Exo world, find the closest
 * PERMANENT world (minimum blinksec distance over the perms in its region) and
 * ingest the { worldId: {assignment: closestPermId, distance} } map into our
 * Worker. Run after the colour capture in the same cron job, reusing the token.
 */
import { config } from "./config.ts";
import { getQueryToken } from "./auth.ts";
import { getWorldDistance, ingestDistances, type WorldDistanceInfo } from "./distances.ts";

type DW = { id?: number; region?: string; lifetime?: unknown; sovereign?: boolean };

async function main() {
  const token = await getQueryToken();

  const res = await fetch(`${config.dsBase}/list-gameservers`);
  if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
  const worlds = (await res.json()) as DW[];

  const valid = worlds.filter((w) => typeof w.id === "number");
  // Permanent = no lifetime and not a sovereign; target = sovereign or exo (has lifetime).
  const perms = valid.filter((w) => !Array.isArray(w.lifetime) && w.sovereign !== true);
  let targets = valid.filter((w) => w.sovereign === true || Array.isArray(w.lifetime));

  // Optional CLI ids (e.g. `npm run distances -- 7890 7891`): scan only those
  // targets. Used by the 10-min poll to compute a freshly-spawned world at once.
  const idArgs = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (idArgs.length) targets = targets.filter((t) => idArgs.includes(t.id as number));
  console.log(`[distance] ${targets.length} targets${idArgs.length ? " (specified ids)" : " (sov/exo)"}, ${perms.length} perms`);

  const out: Record<string, WorldDistanceInfo> = {};
  let i = 0;
  for (const t of targets) {
    i++;
    // The nearest perm is essentially always in the same region (blink space is
    // per-region); fall back to all perms if a region somehow has none.
    let cands = perms.filter((p) => p.region === t.region);
    if (cands.length === 0) cands = perms;

    let best: { id: number; dist: number } | null = null;
    for (const p of cands) {
      try {
        const d = await getWorldDistance(token, t.id as number, p.id as number);
        if (d != null && (best === null || d < best.dist)) best = { id: p.id as number, dist: d };
      } catch {
        /* skip this pair */
      }
      await new Promise((r) => setTimeout(r, 220));
    }

    if (best) {
      out[String(t.id)] = { assignment: best.id, distance: best.dist };
      console.log(`[distance] (${i}/${targets.length}) ${t.id}: closest perm ${best.id} @ ${best.dist} blinksecs`);
    } else {
      console.log(`[distance] (${i}/${targets.length}) ${t.id}: no perm distance`);
    }
  }

  const ok = await ingestDistances(out);
  console.log(`[distance] ingested ${Object.keys(out).length} -> ${ok ? "OK" : "FAILED"}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("[distance] fatal:", e);
  process.exit(1);
});
