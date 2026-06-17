/**
 * Each live world's orbited ("closest") world + the distance to it in blinksecs.
 *
 * The orbited world id (`assignment`) is only present in the public discovery for
 * SOME worlds (mostly sovereigns) - for exos it is missing there but IS returned by
 * the authenticated /gameserver world-config. The blinksec distance is not in any
 * payload and has no local formula, so it is queried per pair from the authenticated
 * DS /distance endpoint (the same official endpoint community bots use). Both calls
 * use the ACCOUNT username in the path, like /gameserver.
 */
import { getQueryToken, type QueryToken } from "./auth.ts";
import { buildPlainBody, authenticatedPost } from "./protocol.ts";
import { config } from "./config.ts";

export { getQueryToken };

export interface WorldDistanceInfo {
  /** The orbited (closest) world id. */
  assignment: number;
  /** Distance to it in blinksecs. */
  distance: number;
}

/** Authenticated /gameserver -> the world's orbited (assignment) world id, or null. */
export async function getAssignment(token: QueryToken, worldId: number): Promise<number | null> {
  const path = `/gameserver/${token.username}/${worldId}/${token.player.id}`;
  const res = await authenticatedPost(`${config.dsBase}${path}`, buildPlainBody(path, token));
  if (!res.ok) return null;
  const data = (await res.json()) as { worldData?: { assignment?: number | null } };
  const a = data.worldData?.assignment;
  return typeof a === "number" ? a : null;
}

/** Authenticated DS /distance -> blinksecs, or null when unavailable (400/404/410). */
export async function getWorldDistance(
  token: QueryToken,
  fromId: number,
  toId: number,
): Promise<number | null> {
  const path = `/distance/${token.username}/${fromId}/${toId}/${token.player.id}`;
  const res = await authenticatedPost(`${config.dsBase}${path}`, buildPlainBody(path, token));
  if (!res.ok) return null;
  const data = (await res.json()) as { distance?: number };
  return typeof data.distance === "number" ? data.distance : null;
}

/** POST a { worldId: {assignment, distance} } map to the Worker ingest (Bearer). */
export async function ingestDistances(distances: Record<string, WorldDistanceInfo>): Promise<boolean> {
  const res = await fetch(`${config.apiBase}/api/ingest-distances`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.ingestToken}`, "content-type": "application/json" },
    body: JSON.stringify({ distances }),
  });
  return res.ok;
}
