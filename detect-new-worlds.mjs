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
  console.log(`sov/exo without distance (reachable): ${ids.length}${ids.length ? ' -> ' + ids.join(',') : ''}`);
}

try {
  // Source candidates from our own API, which returns only worlds still in the live
  // universe (loadWorlds drops expired exos / de-rented sovereigns). So a distance-less
  // sovereign or active exo in the API is genuinely reachable - no need to cross-check
  // public discovery, which would wrongly exclude PRIVATE sovereigns (never in worlds.json).
  const res = await fetch(API);
  const j = res.ok ? await res.json() : { results: [] };
  const now = Date.now();
  const ids = (j.results || [])
    .filter((w) => w && typeof w.id === 'number' && w.distance == null)
    .filter((w) =>
      w.is_exo
        ? !w.end || new Date(w.end).getTime() > now // active exo
        // Any sovereign the live API returns is reachable: the API already drops worlds
        // that have left the universe, so we no longer require public-discovery membership
        // (that wrongly excluded PRIVATE sovereigns, which never appear in worlds.json).
        // The liveSov set is still used as a cheap freshness hint for logging only.
        : w.is_sovereign
    )
    .map((w) => w.id)
    .slice(0, 25);
  emit(ids);
} catch (e) {
  console.error('detect failed (non-fatal):', e?.message ?? e);
  emit([]);
}
