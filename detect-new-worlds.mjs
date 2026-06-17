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
import { readFileSync, appendFileSync } from 'node:fs';

const API = 'https://boundlessinfo-api.niccolo-sabato.workers.dev/api/v2/worlds?limit=500';
const out = process.env.GITHUB_OUTPUT;

function emit(ids) {
  if (out) {
    appendFileSync(out, `ids=${ids.join(' ')}\n`);
    appendFileSync(out, `has_new=${ids.length > 0}\n`);
  }
  console.log(`sov/exo without distance (reachable): ${ids.length}${ids.length ? ' -> ' + ids.join(',') : ''}`);
}

try {
  // Reachability is mandatory, or we churn forever: the API's sovereign set
  // accumulates STALE sovereigns (expired, no longer in the live universe) that
  // a distance scan can never resolve, so flagging them re-runs a Steam login +
  // scan + a `distances` KV read/write on every 10-minute poll for nothing.
  //   - sovereigns: keep only those still in the live DS discovery (worlds.json)
  //   - exos: are reachable but ABSENT from /list-gameservers, so accept them
  //     from the API directly, but only while still active (end in the future).
  const disc = JSON.parse(readFileSync('worlds.json', 'utf8'));
  const liveSov = new Set(
    (Array.isArray(disc) ? disc : [])
      .filter((w) => w && typeof w.id === 'number' && (w.sovereign === true || Array.isArray(w.lifetime)))
      .map((w) => w.id)
  );

  const res = await fetch(API);
  const j = res.ok ? await res.json() : { results: [] };
  const now = Date.now();
  const ids = (j.results || [])
    .filter((w) => w && typeof w.id === 'number' && w.distance == null)
    .filter((w) =>
      w.is_exo
        ? !w.end || new Date(w.end).getTime() > now // active exo
        : w.is_sovereign && liveSov.has(w.id) // sovereign still live in discovery
    )
    .map((w) => w.id)
    .slice(0, 25);
  emit(ids);
} catch (e) {
  console.error('detect failed (non-fatal):', e?.message ?? e);
  emit([]);
}
