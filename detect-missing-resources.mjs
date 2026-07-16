/**
 * Detect CURRENTLY-LIVE worlds that have no captured resources yet, so the poller can
 * scan exactly those and backfill them. This self-heals the legacy gap where public
 * sovereigns below the resource-scan frontier (ids < 6000) were never resource-scanned:
 * they appear in the discovery + got a distance, but their resources stayed empty
 * (e.g. Hyrule 1864). World resources are fixed at spawn, so once filled they persist
 * and the change-aware ingest never rewrites them - this step then becomes a no-op.
 *
 * Reads our own API (which knows exactly which live worlds lack resources) and emits
 * the ids to GITHUB_OUTPUT. Capped so a single run stays well within the job timeout;
 * any remainder is picked up on the next run. Never fails the workflow.
 */
import { appendFileSync } from 'node:fs';

const API = 'https://boundlessinfo-api.niccolo-sabato.workers.dev/api/v2/worlds/missing-resources';
const MAX = 60; // bound the per-run DS probe budget
const out = process.env.GITHUB_OUTPUT;

function emit(ids) {
  if (out) {
    appendFileSync(out, `ids=${ids.join(' ')}\n`);
    appendFileSync(out, `has_missing=${ids.length > 0}\n`);
  }
  console.log(`live worlds missing resources: ${ids.length}${ids.length ? ' -> ' + ids.join(',') : ''}`);
}

try {
  const res = await fetch(API);
  const j = res.ok ? await res.json() : { ids: [] };
  const ids = (Array.isArray(j.ids) ? j.ids : []).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX);
  emit(ids);
} catch (e) {
  console.error('detect-missing-resources failed (non-fatal):', e?.message ?? e);
  emit([]);
}
