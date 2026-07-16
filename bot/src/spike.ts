/**
 * Spike (`npm run spike`): prove the full auth + discovery chain works by
 * fetching ONE specific world by id (SPIKE_WORLD_ID) and printing its data and
 * resources. Does NOT ingest. This is the smallest end-to-end verification:
 *   - Steam ticket (headless, using the bootstrap sentry)
 *   - Boundless web session -> game JWT
 *   - DS /login -> query token
 *   - DS /gameserver/... -> worldData + pollData
 *   - world apiURL /worldpoll -> resources
 *
 * Pick a known-live id. A permanent homeworld (e.g. a capital) is the safest
 * proof. Set SPIKE_WORLD_ID in your environment or .env.
 */

import { getQueryToken } from "./auth.ts";
import { getWorldData, getWorldPoll, parseResources, toDiscoveredWorld } from "./discover.ts";

async function main(): Promise<void> {
  const idRaw = process.env.SPIKE_WORLD_ID;
  if (!idRaw) {
    throw new Error("Set SPIKE_WORLD_ID to the world id you want to probe (e.g. a known live world).");
  }
  const worldId = Number(idRaw);
  if (!Number.isInteger(worldId)) {
    throw new Error(`SPIKE_WORLD_ID must be an integer, got "${idRaw}"`);
  }

  console.log("[spike] minting query token (full auth chain)...");
  const token = await getQueryToken();
  console.log(`[spike] authenticated as character ${token.player.name} (id ${token.player.id})`);

  console.log(`[spike] fetching world ${worldId} via DS /gameserver...`);
  const response = await getWorldData(worldId, token);
  if (response === null) {
    console.log(`[spike] world ${worldId} does not exist (404/410). Try another id.`);
    return;
  }

  const data = response.worldData;
  const kind = data.sovereign ? "sovereign" : data.lifetime ? "exo" : "perm";
  console.log(
    `[spike] worldData: id=${data.id} name="${data.displayName ?? data.name}" ` +
      `region=${data.region} tier=${data.tier} type=${data.worldType} ` +
      `kind=${kind} locked=${data.locked ?? false} apiURL=${data.apiURL}`,
  );

  if (data.locked || !data.apiURL) {
    console.log("[spike] world is locked or has no apiURL: no poll to fetch.");
    console.log("[spike] ingest shape:", JSON.stringify(toDiscoveredWorld(data, []), null, 2));
    return;
  }

  console.log("[spike] fetching world poll via apiURL /worldpoll...");
  try {
    const poll = await getWorldPoll(data.apiURL, token, response.pollData);
    const resources = parseResources(poll.resources ?? []);
    console.log(`[spike] poll ok: ${resources.length} non-zero resource(s)`);
    for (const r of resources) {
      console.log(
        `    item ${r.itemId}: count=${r.count} ` +
          `pct=${r.percentage.toFixed(2)}% ${r.isEmbedded ? "embedded" : "surface"}`,
      );
    }
    console.log("[spike] full ingest shape for this world:");
    console.log(JSON.stringify(toDiscoveredWorld(data, resources), null, 2));
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (data.sovereign && status === 400) {
      console.log("[spike] sovereign world returned poll 400 (expected). No resources.");
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error("[spike] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
