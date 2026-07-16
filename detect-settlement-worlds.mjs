/**
 * Emit the world ids whose SETTLEMENTS need a periodic refresh: permanents and
 * sovereigns. Settlements (the prestige leaderboard) are dynamic - players build,
 * grow and abandon them - so unlike resources they must be re-read regularly.
 *
 * The 6-hour frontier scan (`npm run run`, SCAN_MIN..SCAN_MAX) only covers the id
 * window where new exos/sovereigns spawn, so permanents (low ids) and older
 * sovereigns below the window never got their settlements refreshed and went stale
 * (the "initial archive"). This lists every perm + sovereign so the 6-hour job can
 * re-scan them all; the change-aware ingest skips the KV write when nothing changed,
 * and fixed resources are not re-written.
 *
 * Only worlds OUTSIDE the frontier id window (SCAN_MIN..SCAN_MAX) are emitted: the
 * frontier `npm run run` already re-scans everything inside it every 6h (refreshing
 * those settlements), so the gap is permanents and older sovereigns below the window.
 * This avoids re-polling in-range worlds twice (keeps Steam load minimal). Exos are
 * excluded (rarely have settlements, already covered). Capped; never fails the workflow.
 */
import { appendFileSync } from 'node:fs';

const API = 'https://boundlessinfo-api.niccolo-sabato.workers.dev/api/v2/worlds?limit=500';
// Mirror steam-capture.yml's frontier window; worlds inside it are refreshed by `npm run run`.
const SCAN_MIN = Number(process.env.SCAN_MIN || 6000);
const SCAN_MAX = Number(process.env.SCAN_MAX || 8300);
const MAX = 250;
const out = process.env.GITHUB_OUTPUT;

function emit(ids) {
  if (out) {
    appendFileSync(out, `ids=${ids.join(' ')}\n`);
    appendFileSync(out, `has_worlds=${ids.length > 0}\n`);
  }
  console.log(`settlement-refresh worlds (perm + sovereign): ${ids.length}`);
}

try {
  const res = await fetch(API);
  const j = res.ok ? await res.json() : { results: [] };
  const ids = (j.results || [])
    .filter((w) => w && typeof w.id === 'number' && (w.is_perm || w.is_sovereign))
    .filter((w) => w.id < SCAN_MIN || w.id > SCAN_MAX) // outside the frontier window
    .map((w) => w.id)
    .slice(0, MAX);
  emit(ids);
} catch (e) {
  console.error('detect-settlement-worlds failed (non-fatal):', e?.message ?? e);
  emit([]);
}
