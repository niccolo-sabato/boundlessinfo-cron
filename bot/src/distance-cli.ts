/**
 * `npm run distances` - for every live world, read its orbited world from the
 * authenticated /gameserver world-config and query the blinksec distance to it,
 * then ingest the { worldId: {assignment, distance} } map into our Worker. Works
 * for exos (whose assignment is absent from the public discovery). Run after the
 * colour capture in the same cron job, reusing the already-minted query token.
 */
import { config } from "./config.ts";
import { getQueryToken } from "./auth.ts";
import { getAssignment, getWorldDistance, ingestDistances, type WorldDistanceInfo } from "./distances.ts";

async function main() {
  const token = await getQueryToken();

  const res = await fetch(`${config.dsBase}/list-gameservers`);
  if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
  const worlds = (await res.json()) as { id?: number }[];
  const ids = worlds.filter((w) => typeof w?.id === "number").map((w) => w.id as number);
  console.log(`[distance] ${ids.length} live worlds`);

  const out: Record<string, WorldDistanceInfo> = {};
  let i = 0;
  for (const id of ids) {
    i++;
    try {
      const assignment = await getAssignment(token, id);
      if (assignment != null && assignment !== id) {
        await new Promise((r) => setTimeout(r, 350));
        const distance = await getWorldDistance(token, id, assignment);
        if (distance != null) {
          out[String(id)] = { assignment, distance };
          console.log(`[distance] (${i}/${ids.length}) ${id} -> ${assignment}: ${distance} blinksecs`);
        } else {
          console.log(`[distance] (${i}/${ids.length}) ${id} -> ${assignment}: no distance`);
        }
      } else {
        console.log(`[distance] (${i}/${ids.length}) ${id}: no assignment`);
      }
    } catch (e) {
      console.error(`[distance] ${id} failed:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  const ok = await ingestDistances(out);
  console.log(`[distance] ingested ${Object.keys(out).length} -> ${ok ? "OK" : "FAILED"}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error("[distance] fatal:", e);
  process.exit(1);
});
