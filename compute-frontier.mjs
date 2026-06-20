/**
 * Compute a dynamic, generous frontier scan window for the 10-minute poll.
 *
 * World ids are incremental and exoworlds (plus private sovereigns) are NOT in the
 * public DS /list-gameservers discovery, so the only way to catch a freshly-spawned
 * one is an authenticated /gameserver probe. Sweeping the whole id space every 10
 * minutes would hammer the account, so instead we probe a small window just above
 * the highest id we already know (read from our own API): new spawns land there.
 *
 * Emits scan_min / scan_max to GITHUB_OUTPUT for the discover step.
 */
import { appendFileSync } from 'node:fs';

const API = 'https://boundlessinfo-api.niccolo-sabato.workers.dev/api/v2/worlds?limit=500';
const BACK = 5; // re-check a few ids below max, in case one was just missed
const FORWARD = 40; // generous forward window (far more than spawn in a 10-min cycle)
const FLOOR = 6000; // never probe below the exo/sovereign frontier floor
const FALLBACK = [7850, 8100]; // used only if the API is unreachable

function emit(min, max, note) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `scan_min=${min}\nscan_max=${max}\n`);
  console.log(`[frontier] window ${min}..${max} (${max - min + 1} ids) ${note}`);
}

try {
  const res = await fetch(API);
  const j = res.ok ? await res.json() : { results: [] };
  const ids = (j.results || []).map((w) => w?.id).filter((n) => Number.isInteger(n));
  if (!ids.length) {
    emit(FALLBACK[0], FALLBACK[1], '(API returned no ids, fallback)');
  } else {
    const maxId = Math.max(...ids);
    emit(Math.max(FLOOR, maxId - BACK), maxId + FORWARD, `maxKnownId=${maxId}`);
  }
} catch (e) {
  emit(FALLBACK[0], FALLBACK[1], `(API error: ${e?.message ?? e})`);
}
