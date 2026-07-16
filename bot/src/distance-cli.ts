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
type ApiWorld = { id: number; region?: string; is_perm?: boolean; is_sovereign?: boolean; is_exo?: boolean; distance?: number | null };

async function main() {
  const token = await getQueryToken();

  const idArgs = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);

  // Source live worlds from OUR OWN API: it carries perms + public AND PRIVATE
  // sovereigns + exos (the public /list-gameservers omits exos and private sovereigns),
  // and each world's current `distance` so we can skip ones already resolved.
  let api: ApiWorld[] = [];
  try {
    const ar = await fetch(`${config.apiBase}/api/v2/worlds?limit=500`);
    if (ar.ok) api = ((await ar.json()) as { results?: ApiWorld[] }).results ?? [];
  } catch {
    /* API unreachable: fall back to discovery below */
  }

  let perms: DW[];
  let targets: DW[];
  if (api.length > 1) {
    perms = api.filter((w) => w.is_perm).map((w) => ({ id: w.id, region: w.region }));
    if (idArgs.length) {
      const byId = new Map(api.map((w) => [w.id, w] as const));
      targets = idArgs.map((id) => ({ id, region: byId.get(id)?.region }));
    } else {
      // Distances are STATIC (a world's blinksec distance to its nearest perm does not
      // change), so only compute the ones still MISSING. This bounds the full pass to
      // newly-appeared worlds instead of re-scanning every sovereign/exo every 6h, and
      // it now also covers private sovereigns + exos that public discovery hid.
      targets = api
        .filter((w) => (w.is_sovereign || w.is_exo) && w.distance == null)
        .map((w) => ({ id: w.id, region: w.region }));
    }
  } else {
    // Fallback: our API was unreachable, use the public discovery (perms + public sovs).
    const res = await fetch(`${config.dsBase}/list-gameservers`);
    if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
    const valid = ((await res.json()) as DW[]).filter((w) => typeof w.id === "number");
    perms = valid.filter((w) => !Array.isArray(w.lifetime) && w.sovereign !== true);
    const all = valid.filter((w) => w.sovereign === true || Array.isArray(w.lifetime));
    targets = idArgs.length ? idArgs.map((id) => valid.find((w) => w.id === id) ?? ({ id } as DW)) : all;
  }
  console.log(`[distance] ${targets.length} targets${idArgs.length ? " (specified ids)" : " (missing only)"}, ${perms.length} perms`);

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
