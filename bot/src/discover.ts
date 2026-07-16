/**
 * Discovery: probe a range of world IDs against the authenticated DS, capture
 * each existing world's data and (if not locked) its world poll resources.
 *
 * Ported from Boundlexx `client.py` (get_world_data / get_world_poll) and
 * `tasks/worlds.py` (_scan_worlds / get_worlds). Exoworlds are NOT in the
 * public `list-gameservers`; only authenticated `/gameserver/...` probing of
 * world ids returns them, including their `lifetime` (set) with no owner.
 */

import type { QueryToken } from "./auth.ts";
import { getQueryToken, invalidateQueryToken } from "./auth.ts";
import {
  buildPlainBody,
  buildPollBody,
  authenticatedPost,
  isStaleTokenResponse,
} from "./protocol.ts";
import { config, RESOURCE_MAPPING, isEmbeddedIndex } from "./config.ts";

/** Raw world data dict as returned by the DS `/gameserver/...` endpoint. */
export interface WorldData {
  id: number;
  name?: string;
  displayName?: string;
  region?: string;
  tier?: number;
  worldType?: number;
  specialWorldType?: number;
  worldSize?: number;
  numRegions?: number;
  atmosphereColor?: number[];
  waterColor?: number[];
  /** [startEpoch, endEpoch] for exos/sovereigns; absent for permanent worlds. */
  lifetime?: [number, number] | null;
  sovereign?: boolean | null;
  /** Owner player id: a number for sovereigns (incl. private), null/absent for exos. */
  owner?: number | null;
  locked?: boolean;
  apiURL?: string;
  websocketURL?: string;
  info?: { players?: number; maxPlayers?: number };
  [key: string]: unknown;
}

/** The DS `/gameserver` response wraps worldData + pollData. */
interface GameServerResponse {
  worldData: WorldData;
  /** Opaque poll token, fed back into the /worldpoll request. */
  pollData: string;
}

/** One normalized resource entry for ingest. */
export interface IngestResource {
  itemId: number;
  count: number;
  /** Percentage within its group (embedded vs surface), 0..100. */
  percentage: number;
  isEmbedded: boolean;
}

/** One settlement (from the world poll leaderboard), ranked by prestige. */
export interface IngestSettlement {
  rank: number;
  name: string;
  prestige: number;
  mayorName: string | null;
}

/** One discovered world in the shape our ingest API expects. */
export interface DiscoveredWorld {
  id: number;
  name: string | null;
  displayName: string | null;
  region: string | null;
  tier: number | null;
  worldType: number | null;
  specialWorldType: number | null;
  worldSize: number | null;
  numRegions: number | null;
  atmosphereColor: number[] | null;
  waterColor: number[] | null;
  /** [startEpoch, endEpoch] when present (exos/sovereigns), else null. */
  lifetime: [number, number] | null;
  sovereign: boolean;
  /** Owner player id (sovereign, incl. private) or null (exo). Drives classification. */
  owner: number | null;
  apiURL: string | null;
  websocketURL: string | null;
  // OMITTED (undefined) when the world poll failed/400'd or the world was locked, so the
  // ingest preserves the last good capture instead of wiping it with an empty array.
  // Present (possibly empty) only when the poll succeeded.
  resources?: IngestResource[];
  settlements?: IngestSettlement[];
  /** True once a resource poll was ATTEMPTED (success, empty, 400 or locked-skip). Lets
   * the missing-resources self-heal converge instead of re-probing unfillable worlds. */
  resourcesScanned: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET-style probe for one world via the DS `/gameserver/<user>/<id>/<accountId>`
 * endpoint. Returns null for missing worlds (404/410), exactly like Boundlexx
 * `get_world_data`. Retries once with a fresh token on a stale-token 400.
 */
export async function getWorldData(
  worldId: number,
  token: QueryToken,
  allowReauth = true,
): Promise<GameServerResponse | null> {
  const path = `/gameserver/${token.username}/${worldId}/${token.player.id}`;
  const url = `${config.dsBase}${path}`;
  const res = await authenticatedPost(url, buildPlainBody(path, token));

  if (res.status === 404 || res.status === 410) return null;

  if (allowReauth && (await isStaleTokenResponse(res))) {
    // Token went stale: re-mint and retry once (mirrors _authentiated_post).
    invalidateQueryToken();
    const fresh = await getQueryToken({ forceRefresh: true });
    return getWorldData(worldId, fresh, false);
  }

  if (!res.ok) {
    throw new Error(`get_world_data(${worldId}) HTTP ${res.status}`);
  }
  return (await res.json()) as GameServerResponse;
}

/** Raw world poll dict from the world's own apiURL `/worldpoll`. */
interface WorldPollResponse {
  /** Positional resource counts; index maps via RESOURCE_MAPPING. */
  resources: number[];
  beacons?: number;
  plots?: number;
  /** Settlement leaderboard: [{ name, prestige, mayor: { name } }, ...]. */
  leaderboard?: unknown;
  [key: string]: unknown;
}

/**
 * Fetch the world poll from the world's own apiURL. Ported from
 * `get_world_poll` + `_authenticated_world` (poll_token branch, no reauth).
 */
export async function getWorldPoll(
  apiURL: string,
  token: QueryToken,
  pollToken: string,
): Promise<WorldPollResponse> {
  const url = `${apiURL}/worldpoll`;
  const res = await authenticatedPost(url, buildPollBody(token, pollToken));
  if (!res.ok) {
    const err = new Error(`get_world_poll HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as WorldPollResponse;
}

/**
 * Convert the positional `resources` array into normalized entries with
 * per-group percentages. Mirrors Boundlexx `_create_resource_counts`:
 *   - skip zero counts
 *   - split into embedded vs surface groups
 *   - percentage = count / groupTotal * 100
 */
export function parseResources(resources: number[]): IngestResource[] {
  let embeddedTotal = 0;
  let surfaceTotal = 0;
  const staged: { itemId: number; count: number; isEmbedded: boolean }[] = [];

  for (let i = 0; i < resources.length; i++) {
    const count = resources[i];
    if (!count) continue;
    const itemId = RESOURCE_MAPPING[i];
    if (itemId === undefined) continue; // defensive: longer array than mapping
    const isEmbedded = isEmbeddedIndex(i);
    staged.push({ itemId, count, isEmbedded });
    if (isEmbedded) embeddedTotal += count;
    else surfaceTotal += count;
  }

  return staged.map(({ itemId, count, isEmbedded }) => {
    const total = isEmbedded ? embeddedTotal : surfaceTotal;
    return {
      itemId,
      count,
      percentage: total > 0 ? (count / total) * 100 : 0,
      isEmbedded,
    };
  });
}

/** Convert the world poll `leaderboard` into ranked settlements. */
export function parseSettlements(leaderboard: unknown): IngestSettlement[] {
  if (!Array.isArray(leaderboard)) return [];
  return leaderboard
    .map((e, i) => {
      const entry = e as { name?: unknown; prestige?: unknown; mayor?: { name?: unknown } };
      return {
        rank: i + 1,
        name: typeof entry?.name === "string" ? entry.name : "",
        prestige: typeof entry?.prestige === "number" ? entry.prestige : 0,
        mayorName: typeof entry?.mayor?.name === "string" ? entry.mayor.name : null,
      };
    })
    // Keep real settlements even when unnamed (a beacon cluster with no chosen name):
    // Boundlexx keeps them and the site renders them as "Unnamed settlement". Only drop
    // fully-empty padding rows (no name AND no prestige).
    .filter((s) => s.name.length > 0 || s.prestige > 0);
}

/**
 * Map a raw worldData (+ optional poll result) into the ingest world shape.
 * Pass `resources`/`settlements` ONLY when the poll succeeded; leave them undefined on
 * a failed/400 poll or a locked world so the API ingest preserves the last good capture
 * (an undefined field is omitted from the JSON and never overwrites stored data).
 * `resourcesScanned` is always true: a poll was attempted (or deliberately skipped for a
 * locked world), so the missing-resources self-heal can mark this world as handled.
 */
export function toDiscoveredWorld(
  data: WorldData,
  resources?: IngestResource[],
  settlements?: IngestSettlement[],
): DiscoveredWorld {
  const world: DiscoveredWorld = {
    id: data.id,
    name: data.name ?? null,
    displayName: data.displayName ?? null,
    region: data.region ?? null,
    tier: data.tier ?? null,
    worldType: data.worldType ?? null,
    specialWorldType: data.specialWorldType ?? null,
    worldSize: data.worldSize ?? null,
    numRegions: data.numRegions ?? null,
    atmosphereColor: Array.isArray(data.atmosphereColor) ? data.atmosphereColor : null,
    waterColor: Array.isArray(data.waterColor) ? data.waterColor : null,
    lifetime: Array.isArray(data.lifetime) ? (data.lifetime as [number, number]) : null,
    sovereign: data.sovereign === true,
    owner: typeof data.owner === "number" ? data.owner : null,
    apiURL: data.apiURL ?? null,
    websocketURL: data.websocketURL ?? null,
    resourcesScanned: true,
  };
  if (resources !== undefined) world.resources = resources;
  if (settlements !== undefined) world.settlements = settlements;
  return world;
}

export interface ScanResult {
  worlds: DiscoveredWorld[];
  scanned: number;
  found: number;
}

/**
 * Probe `[scanMin, scanMax]` (inclusive) and return every world that exists,
 * with its resources when available. Faithful port of `_scan_worlds`/`get_worlds`:
 *   - missing ids (404/410) are skipped silently
 *   - locked worlds get no poll (resources empty), matching `is_locked` guard
 *   - sovereign worlds may return a 400 on poll: expected, skipped gracefully
 * Polite delays between calls mirror Boundlexx's per-DS / per-world throttling.
 *
 * @param onProgress optional callback, called once per existing world found.
 */
export async function scanWorlds(
  scanMin: number,
  scanMax: number,
  onProgress?: (world: DiscoveredWorld, index: number) => void,
): Promise<ScanResult> {
  const ids: number[] = [];
  for (let id = scanMin; id <= scanMax; id++) ids.push(id);
  return scanWorldIds(ids, onProgress);
}

/**
 * Probe a SPECIFIC list of world ids (same per-world logic as the range scan).
 * Used by the 10-minute poll to fetch worlds + resources for just the freshly
 * detected new Sovereign/Exo ids, instead of re-sweeping a whole range.
 */
export async function scanWorldIds(
  ids: number[],
  onProgress?: (world: DiscoveredWorld, index: number) => void,
): Promise<ScanResult> {
  let token = await getQueryToken();
  const worlds: DiscoveredWorld[] = [];
  let scanned = 0;

  for (const id of ids) {
    scanned++;
    let response: GameServerResponse | null;
    try {
      response = await getWorldData(id, token);
    } catch (err) {
      // Surface unexpected DS errors but keep scanning the rest of the range.
      console.error(`world ${id}: ${(err as Error).message}`);
      await sleep(config.dsDelayMs);
      continue;
    }

    // Polite delay between DS probes regardless of hit/miss.
    await sleep(config.dsDelayMs);

    if (response === null) continue; // missing id

    const data = response.worldData;
    // Leave these undefined unless the poll SUCCEEDS, so a 400/error/locked world omits
    // them from the ingest and the API preserves the last good capture (no wipe).
    let resources: IngestResource[] | undefined;
    let settlements: IngestSettlement[] | undefined;

    if (!data.locked && data.apiURL) {
      try {
        const poll = await getWorldPoll(data.apiURL, token, response.pollData);
        resources = parseResources(poll.resources ?? []);
        settlements = parseSettlements(poll.leaderboard);
      } catch (err) {
        const status = (err as Error & { status?: number }).status;
        // Sovereign worlds returning 400 on poll is expected: skip the poll. resources/
        // settlements stay undefined -> omitted from the POST -> stored data preserved.
        if (data.sovereign === true && status === 400) {
          console.warn(`world ${id} (sovereign): poll 400, preserving stored resources/settlements`);
        } else {
          console.error(`world ${id} poll: ${(err as Error).message}`);
        }
      }
      await sleep(config.worldDelayMs);
    }

    const world = toDiscoveredWorld(data, resources, settlements);
    worlds.push(world);
    onProgress?.(world, worlds.length - 1);

    // The query token used inside getWorldData may have been refreshed on a
    // stale-token retry; re-read the (possibly new) cached token cheaply.
    token = await getQueryToken();
  }

  return { worlds, scanned, found: worlds.length };
}
