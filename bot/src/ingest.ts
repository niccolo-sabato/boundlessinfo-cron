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
import { config } from "./config.ts";

export interface IngestResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Send the discovered worlds to the ingest endpoint. Returns the parsed result;
 * throws only on a network/transport failure (HTTP errors are returned so the
 * caller can log + decide). Posts nothing (and returns ok) for an empty list.
 */
export async function ingestWorlds(worlds: DiscoveredWorld[]): Promise<IngestResult> {
  if (worlds.length === 0) {
    return { ok: true, status: 0, body: { skipped: "no worlds to ingest" } };
  }

  const url = `${config.apiBase}/api/ingest/worlds`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ingestToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ worlds }),
      signal: controller.signal,
    });

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => "");
    }

    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}
