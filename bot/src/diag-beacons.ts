/**
 * Check our settlement reconstruction against the game's own answer.
 *
 *   npm run diag-beacons -- 36 [more world ids...]
 *
 * The beacons endpoint gives every beacon and a map of which one owns each plot column, but it
 * does NOT say which beacons form a settlement. We reconstruct that by unioning beacons whose
 * plots touch. That is our algorithm, not the game's, so it has to be checked rather than
 * believed.
 *
 * The check: the authenticated world poll DOES report settlements, correctly, for the top five
 * per world. That is exactly the data the whole beacons effort exists to go beyond, which makes
 * it the perfect yardstick. If our clustering reproduces those five by name and prestige, the
 * remaining hundreds are trustworthy too. If it does not, the adjacency rule or the prestige
 * aggregation is wrong and no amount of extra rows will fix it.
 */

import { config } from "./config.ts";
import { buildSettlements, fetchBeacons, type Settlement } from "./beacons.ts";

interface PollSettlement {
  rank: number;
  name: string;
  prestige: number;
  mayorName: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The game's names carry colour and emoji markup; compare on the letters alone. */
function normalise(s: string): string {
  return s
    .replace(/:#[0-9a-fA-F]{6}:/g, "")
    .replace(/:[a-zA-Z0-9_+-]+:/g, "")
    .trim()
    .toLowerCase();
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).map(Number).filter(Number.isFinite);
  if (!ids.length) throw new Error("usage: diag-beacons <worldId> [worldId...]");

  const worlds = (
    await getJson<{ results: { id: number; display_name: string; api_url: string | null }[] }>(
      `${config.apiBase}/api/v2/worlds?limit=500`,
    )
  ).results;

  let checked = 0;
  let nameHits = 0;
  let nameTotal = 0;
  let prestigeHits = 0;

  for (const id of ids) {
    const w = worlds.find((x) => x.id === id);
    if (!w?.api_url) {
      console.log(`world ${id}: not live, skipping`);
      continue;
    }

    const pack = await fetchBeacons(w.api_url);
    if (!pack) {
      console.log(`${w.display_name}: world unavailable, skipping`);
      continue;
    }
    const mine = buildSettlements(pack);
    const poll = (
      await getJson<{ results: PollSettlement[] }>(`${config.apiBase}/api/v2/worlds/${id}/settlements`)
    ).results;

    console.log(`\n=== ${w.display_name} ===`);
    console.log(
      `beacons ${pack.beacons.length}, settlements reconstructed ${mine.length}, ` +
        `world poll reports ${poll.length} (its cap is 5)`,
    );
    if (!poll.length) {
      console.log("  no poll data to compare against");
      continue;
    }
    checked++;

    const byName = new Map<string, Settlement>();
    for (const s of mine) {
      const k = normalise(s.name);
      // Two settlements can share a name; the richer one is the one the poll would list.
      if (!byName.has(k) || byName.get(k)!.prestige < s.prestige) byName.set(k, s);
    }

    console.log("  poll rank | poll prestige | ours       | delta");
    for (const p of poll) {
      nameTotal++;
      const hit = byName.get(normalise(p.name));
      if (!hit) {
        console.log(`  ${String(p.rank).padStart(9)} | ${p.prestige.toLocaleString().padStart(13)} | NOT FOUND`);
        continue;
      }
      nameHits++;
      const delta = hit.prestige - p.prestige;
      const pct = p.prestige ? (delta / p.prestige) * 100 : 0;
      if (Math.abs(pct) < 1) prestigeHits++;
      console.log(
        `  ${String(p.rank).padStart(9)} | ${p.prestige.toLocaleString().padStart(13)} | ` +
          `${hit.prestige.toLocaleString().padStart(10)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% ` +
          `(${hit.beacons} beacons) ${p.name}`,
      );
    }
  }

  if (!checked) throw new Error("nothing could be compared");
  console.log(
    `\n=== ${checked} worlds | names matched ${nameHits}/${nameTotal} | ` +
      `prestige within 1% on ${prestigeHits}/${nameTotal} ===`,
  );
  if (nameHits < nameTotal) {
    console.log("Names missing means the clustering is splitting or merging differently to the game.");
  }
  if (prestigeHits < nameHits) {
    console.log("Prestige off means the aggregation rule (currently: sum the members) is wrong.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
