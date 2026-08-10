/**
 * Closest permanent world to each Sovereign / Exo world, in blinksecs.
 *
 * The "closest world" players care about (especially for exos) is the nearest
 * PERMANENT world - the one to portal from. The game's `assignment` field is just
 * the adjacent gate (distance ~1), not the nearest perm, so we instead query the
 * authenticated DS /distance endpoint (the official endpoint community bots use)
 * for the target against every perm in its region and keep the minimum. The path
 * uses the ACCOUNT username, like /gameserver.
 */
import { getQueryToken, type QueryToken } from "./auth.ts";
import { buildPlainBody, authenticatedPost } from "./protocol.ts";
import { config } from "./config.ts";
import { postIngest, type PostResult } from "./http.ts";

export { getQueryToken };

export interface WorldDistanceInfo {
  /** The closest permanent world id. */
  assignment: number;
  /** Distance to it in blinksecs. */
  distance: number;
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

/**
 * POST a { worldId: {assignment, distance} } map to the Worker ingest.
 *
 * Like the colour ingest, this had no timeout and no retry, so a hung connection ended the job
 * only when the workflow's clock ran out and threw away a sweep that costs one DS request per
 * (target, perm) pair. Repeating is safe: the endpoint replaces by world id.
 */
export async function ingestDistances(
  distances: Record<string, WorldDistanceInfo>,
): Promise<PostResult> {
  return postIngest("/api/ingest-distances", { distances });
}
