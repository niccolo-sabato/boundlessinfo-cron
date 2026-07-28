/**
 * Beacon capture: every beacon on a world, and the settlements they form.
 *
 * Route `<apiURL>/beacons` with the **lod0** key (not the shopping one, see the post-mortem in
 * docs/BLESSED-API-PLAN.md). GZIP binary, and unlike the LOD0 map it is fast: about 15 seconds
 * for a busy world, so the whole universe fits comfortably in one daily sweep.
 *
 * WHY THIS MATTERS. The only other source of settlement data is the authenticated world poll,
 * and its leaderboard **caps at five per world** - which is why a player reporting a missing
 * settlement was told it was an API limitation. It is, of that endpoint. This one returns
 * everything: 268 beacons on Gellis, each with name, mayor, prestige, plot count and the exact
 * position of its master console, plus a map saying which beacon owns every plot column on the
 * planet.
 *
 * Wire format, from the official docs (little-endian throughout):
 *
 *   u16 beaconCount, u16 worldSizeInPlots
 *   repeated beaconCount times:
 *     u16 zero          - if NOT zero, stop: it says how many beacons went missing mid-request
 *     u8  isCampfire
 *     i16 x, i16 y, i16 z   (block coordinates of the master console / campfire)
 *     u8  mayorNameLen, char[] mayorName (UTF-8)
 *     if not a campfire:
 *       u64 prestige, i8 compactness, u32 plots, u32 plotColumns
 *       u8 nameLen, char[] name (UTF-8)
 *   then worldSize * worldSize times:
 *     u16 beaconIndex (1-based, 0 = nobody owns this column), u8 plotsInThisColumn
 *
 * The column map runs in rows of equal z starting from the most negative plot, which is the
 * same ordering as the LOD0 image, so the two overlay directly.
 */

import { gunzipSync } from "node:zlib";
import { config } from "./config.ts";

/** One beacon exactly as the world reports it. */
export interface Beacon {
  /** 1-based index in the response, which the plot map refers to. Not stable across captures. */
  index: number;
  isCampfire: boolean;
  name: string;
  mayor: string;
  prestige: number;
  compactness: number;
  plots: number;
  plotColumns: number;
  x: number;
  y: number;
  z: number;
}

export interface BeaconPack {
  /** World side in PLOTS. A plot is 8 blocks on each horizontal axis. */
  worldSizePlots: number;
  beacons: Beacon[];
  /** Length worldSizePlots^2. 1-based beacon index per plot column, 0 where nobody owns it. */
  owner: Uint16Array;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decode the binary pack. Throws rather than half-parsing: a truncated read is a bug. */
export function parseBeacons(buf: Buffer): BeaconPack {
  let o = 0;
  const declared = buf.readUInt16LE(o);
  const worldSizePlots = buf.readUInt16LE(o + 2);
  o += 4;

  const beacons: Beacon[] = [];
  for (let i = 0; i < declared; i++) {
    const skipped = buf.readUInt16LE(o);
    o += 2;
    // Documented edge case: the header count is taken before the walk, so a beacon deleted
    // mid-request shows up here as "this many are missing" and the list simply ends.
    if (skipped !== 0) break;

    const isCampfire = buf.readUInt8(o) !== 0;
    const x = buf.readInt16LE(o + 1);
    const y = buf.readInt16LE(o + 3);
    const z = buf.readInt16LE(o + 5);
    const mayorLen = buf.readUInt8(o + 7);
    o += 8;
    const mayor = buf.toString("utf8", o, o + mayorLen);
    o += mayorLen;

    if (isCampfire) {
      // Campfires carry no prestige block at all. The documented stand-ins are 0 and 2 plots.
      beacons.push({
        index: i + 1, isCampfire: true, name: "", mayor,
        prestige: 0, compactness: 0, plots: 2, plotColumns: 1, x, y, z,
      });
      continue;
    }

    const prestige = Number(buf.readBigUInt64LE(o));
    const compactness = buf.readInt8(o + 8);
    const plots = buf.readUInt32LE(o + 9);
    const plotColumns = buf.readUInt32LE(o + 13);
    const nameLen = buf.readUInt8(o + 17);
    o += 18;
    const name = buf.toString("utf8", o, o + nameLen);
    o += nameLen;

    beacons.push({
      index: i + 1, isCampfire: false, name, mayor,
      prestige, compactness, plots, plotColumns, x, y, z,
    });
  }

  const cells = worldSizePlots * worldSizePlots;
  const need = o + cells * 3;
  if (need > buf.length) {
    throw new Error(`beacon pack truncated: needs ${need} bytes, have ${buf.length}`);
  }
  const owner = new Uint16Array(cells);
  for (let i = 0; i < cells; i++) owner[i] = buf.readUInt16LE(o + i * 3);

  return { worldSizePlots, beacons, owner };
}

/* ----------------------------- Settlements ----------------------------- */

export interface Settlement {
  /** The highest-prestige member's name, which is how the game names a settlement. */
  name: string;
  mayor: string;
  /** Sum over the members. */
  prestige: number;
  beacons: number;
  plots: number;
  /** Position of the highest-prestige member, i.e. where the settlement centres. */
  x: number;
  y: number;
  z: number;
  /** Indices (1-based, matching Beacon.index) of every member. */
  members: number[];
}

/**
 * Group beacons into settlements.
 *
 * A settlement in Boundless is a cluster of beacons whose plots touch. The game computes that
 * itself, but only exposes the answer for the top five per world, so we reconstruct it: union
 * every pair of beacons that own orthogonally adjacent plot columns, then name each component
 * after its highest-prestige member and sum the prestige.
 *
 * This is OUR reconstruction, not the game's algorithm, so it is checked rather than trusted:
 * `npm run diag-beacons` replays it against the five settlements the world poll does report and
 * prints how many match by name and prestige. Treat a drop in that score as a regression.
 *
 * Adjacency is 4-neighbour. Plots are square and share edges; two builds touching only at a
 * corner are neighbours in the colloquial sense but not connected in the game's.
 */
export function buildSettlements(pack: BeaconPack): Settlement[] {
  const { worldSizePlots: size, owner, beacons } = pack;
  const parent = new Int32Array(beacons.length + 1);
  for (let i = 0; i <= beacons.length; i++) parent[i] = i;

  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]; // path halving
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const here = owner[z * size + x];
      if (!here) continue;
      // Only right and down: every pair is still visited once, at half the work.
      if (x + 1 < size) {
        const right = owner[z * size + x + 1];
        if (right && right !== here) union(here, right);
      }
      if (z + 1 < size) {
        const down = owner[(z + 1) * size + x];
        if (down && down !== here) union(here, down);
      }
    }
  }

  const byRoot = new Map<number, Beacon[]>();
  for (const b of beacons) {
    const r = find(b.index);
    byRoot.set(r, [...(byRoot.get(r) ?? []), b]);
  }

  const out: Settlement[] = [];
  for (const members of byRoot.values()) {
    // Campfires are temporary shelters, not settlements. They are kept in the beacon list
    // because they are real, but they must not name or inflate a settlement.
    const real = members.filter((m) => !m.isCampfire);
    if (!real.length) continue;
    const head = real.reduce((a, b) => (b.prestige > a.prestige ? b : a));
    out.push({
      name: head.name,
      mayor: head.mayor,
      prestige: real.reduce((n, m) => n + m.prestige, 0),
      beacons: real.length,
      plots: real.reduce((n, m) => n + m.plots, 0),
      x: head.x,
      y: head.y,
      z: head.z,
      members: real.map((m) => m.index),
    });
  }
  return out.sort((a, b) => b.prestige - a.prestige);
}

/* ----------------------------- Fetch ----------------------------- */

/** Thrown when the key itself is refused: retrying cannot fix it. */
export class BeaconKeyError extends Error {}

/**
 * Fetch and decode one world's beacons.
 *
 * 503 means the world is locked, starting or shutting down, or another beacon request is in
 * flight; the header says roughly how long to wait. Returns null when the world stayed
 * unavailable, so the caller can skip it without treating it as data.
 */
export async function fetchBeacons(apiUrl: string): Promise<BeaconPack | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${apiUrl}/beacons`, {
      headers: { "Boundless-API-Key": config.mapApiKey, "accept-encoding": "gzip" },
      signal: AbortSignal.timeout(config.beaconTimeoutMs),
    });
    if (res.status === 403) throw new BeaconKeyError("beacons key rejected (403)");
    if (res.status === 503) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : 15_000;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length === 0) throw new Error("empty response");
    // fetch decompresses transparently when the server sets Content-Encoding, so accept
    // either form and let the magic bytes decide.
    return parseBeacons(body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body);
  }
  return null;
}

/** Plot coordinates are 0-based from the most negative corner; blocks are signed and centred. */
export function plotToBlock(plot: number, worldSizePlots: number): number {
  return (plot - worldSizePlots / 2) * 8;
}
