/**
 * Ingest: POST discovered worlds to the Boundless Info API.
 *
 *   POST ${API_BASE}/api/ingest/worlds
 *   Authorization: Bearer ${INGEST_TOKEN}
 *   Content-Type: application/json
 *   Body: { worlds: DiscoveredWorld[] }
 *
 * The body shape is intentionally clean and stable (see DiscoveredWorld in
 * discover.ts). The API is responsible for normalizing/persisting; the bot only
 * reports what it observed on the universe.
 */

import type { DiscoveredWorld } from "./discover.ts";
import { postIngest, type PostResult } from "./http.ts";

export type IngestResult = PostResult;

/**
 * Send the discovered worlds to the ingest endpoint.
 *
 * Never throws: transport failures come back as `ok: false` with an `error`, so the caller
 * decides whether to fail the job. Retries are handled in `postIngest` and are safe here
 * because the endpoint merges worlds field-wise by id. Posts nothing (and returns ok) for an
 * empty list.
 *
 * This used to be a bare fetch on the eight-second per-probe timeout with no retry, which is
 * what turned a single hung connection on 2026-08-10 into a failed poll and an alert. See the
 * header of http.ts for the measurement.
 */
export async function ingestWorlds(worlds: DiscoveredWorld[]): Promise<IngestResult> {
  if (worlds.length === 0) {
    return { ok: true, status: 0, body: { skipped: "no worlds to ingest" }, attempts: 0 };
  }
  return postIngest("/api/ingest/worlds", { worlds });
}
