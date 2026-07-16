/**
 * Detect freshly-spawned Sovereign/Exo worlds the 10-minute poll should scan right
 * away (instead of waiting for the 6-hour full pass). Two reasons to target a world:
 *
 *  1. No closest-world distance yet (never fully refreshed).
 *  2. Young (< RES_GRACE_MS old) AND still has no resources. A world's FIRST poll can
 *     land before its game server serves resources (spawn rush): the block colours come
 *     from the websocket and succeed immediately, but the resource worldpoll returns
 *     empty, and because the distance step still succeeds the world drops out of case 1
 *     with an empty Resources tab until the 6-hour backstop. We re-target such worlds
 *     each cycle until resources arrive or they age past the grace window, so resources
 *     appear within ~10 min of spawn like the colours do. We read the /resources endpoint
 *     directly rather than trusting the `resourcesScanned` flag, which a premature empty
 *     poll sets (that flag is meant to stop re-probing genuinely unfillable locked worlds
 *     forever; the age window keeps that convergence for old empties).
 *
 * Reads the live API for the current Sovereign/Exo set; emits the ids to GITHUB_OUTPUT.
 * Never fails the poll.
 */
import { appendFileSync } from 'node:fs';

const API_BASE = 'https://boundlessinfo-api.niccolo-sabato.workers.dev';
const API = `${API_BASE}/api/v2/worlds?limit=500`;
const RES_GRACE_MS = 6 * 60 * 60 * 1000; // keep retrying a young world's resources this long
const out = process.env.GITHUB_OUTPUT;

function emit(ids) {
  if (out) {
    appendFileSync(out, `ids=${ids.join(' ')}\n`);
    appendFileSync(out, `has_new=${ids.length > 0}\n`);
  }
  console.log(`sov/exo to refresh: ${ids.length}${ids.length ? ' -> ' + ids.join(',') : ''}`);
}

const isReachable = (w, now) =>
  w.is_exo ? !w.end || new Date(w.end).getTime() > now : w.is_sovereign;

try {
  const res = await fetch(API);
  const j = res.ok ? await res.json() : { results: [] };
  const now = Date.now();
  const worlds = (j.results || []).filter((w) => w && typeof w.id === 'number' && isReachable(w, now));

  // Case 1: no closest-world distance yet.
  const distanceLess = worlds.filter((w) => w.distance == null).map((w) => w.id);

  // Case 2: young worlds still missing resources (check the endpoint, not resourcesScanned).
  const young = worlds.filter(
    (w) => (w.is_sovereign || w.is_exo) && w.start && now - new Date(w.start).getTime() < RES_GRACE_MS,
  );
  const missingRes = (
    await Promise.all(
      young.map(async (w) => {
        try {
          const r = await fetch(`${API_BASE}/api/v2/worlds/${w.id}/resources`);
          if (!r.ok) return null;
          const rj = await r.json();
          return rj.embedded?.length || rj.surface?.length ? null : w.id;
        } catch {
          return null;
        }
      }),
    )
  ).filter((id) => id != null);

  const ids = [...new Set([...distanceLess, ...missingRes])].slice(0, 25);
  emit(ids);
} catch (e) {
  console.error('detect failed (non-fatal):', e?.message ?? e);
  emit([]);
}
