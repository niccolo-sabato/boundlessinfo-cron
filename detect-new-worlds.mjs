/**
 * Detect freshly-spawned Sovereign/Exo worlds that do not yet have a closest-world
 * distance, so the 10-minute poll can scan just those right away (instead of waiting
 * for the 6-hour full pass). Reads the discovery payload (worlds.json, already
 * fetched) for the current target set and the live API for which ids already have a
 * distance; emits the new ids to GITHUB_OUTPUT. Never fails the poll.
 */
import { readFileSync, appendFileSync } from 'node:fs';

const API = 'https://boundlessinfo-api.niccolo-sabato.workers.dev/api/v2/worlds?limit=500';
const out = process.env.GITHUB_OUTPUT;

function emit(ids) {
  if (out) {
    appendFileSync(out, `ids=${ids.join(' ')}\n`);
    appendFileSync(out, `has_new=${ids.length > 0}\n`);
  }
  console.log(`new sov/exo without distance: ${ids.length}${ids.length ? ' -> ' + ids.join(',') : ''}`);
}

try {
  const disc = JSON.parse(readFileSync('worlds.json', 'utf8'));
  const targets = disc
    .filter((w) => w && typeof w.id === 'number' && (w.sovereign === true || Array.isArray(w.lifetime)))
    .map((w) => w.id);

  const have = new Set();
  const res = await fetch(API);
  if (res.ok) {
    const j = await res.json();
    for (const w of j.results || []) if (w.distance != null) have.add(w.id);
  }

  // Only worlds present in the CURRENT discovery (so the scan can actually reach
  // them) that still lack a distance. Cap per poll so a backlog cannot blow up one run.
  const ids = targets.filter((id) => !have.has(id)).slice(0, 25);
  emit(ids);
} catch (e) {
  console.error('detect failed (non-fatal):', e?.message ?? e);
  emit([]);
}
