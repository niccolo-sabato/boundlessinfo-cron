/**
 * Detect freshly-spawned Sovereign/Exo worlds that do not yet have a closest-world
 * distance, so the 10-minute poll can scan just those right away (instead of waiting
 * for the 6-hour full pass). Reads the live API directly for the current Sovereign/Exo
 * set and which ids still lack a distance; emits the new ids to GITHUB_OUTPUT.
 *
 * IMPORTANT: exoworlds are NOT in the DS /list-gameservers discovery payload (only
 * perms + rented sovereigns are), so sourcing targets from worlds.json silently
 * dropped every exo and they never got a closest-world distance. Our own API does
 * carry the exos, and distance-cli can scan ids absent from discovery (it looks the
 * region up from the API), so we drive detection off the API here. Never fails the poll.
 */
import { appendFileSync } from 'node:fs';

const API = 'https://boundlessinfo-api.niccolo-sabato.workers.dev/api/v2/worlds?limit=500';
const out = process.env.GITHUB_OUTPUT;

function emit(ids) {
  if (out) {
    appendFileSync(out, `ids=${ids.join(' ')}\n`);
    appendFileSync(out, `has_new=${ids.length > 0}\n`);
  }
  console.log(`sov/exo without distance: ${ids.length}${ids.length ? ' -> ' + ids.join(',') : ''}`);
}

try {
  const res = await fetch(API);
  const j = res.ok ? await res.json() : { results: [] };
  // Any current Sovereign/Exo (exos included) that still lacks a closest-world
  // distance. Cap per poll so a backlog cannot blow up one run.
  const ids = (j.results || [])
    .filter((w) => w && typeof w.id === 'number' && (w.is_sovereign || w.is_exo) && w.distance == null)
    .map((w) => w.id)
    .slice(0, 25);
  emit(ids);
} catch (e) {
  console.error('detect failed (non-fatal):', e?.message ?? e);
  emit([]);
}
