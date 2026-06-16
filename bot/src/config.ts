/**
 * Central configuration for the Steam-login discovery bot.
 *
 * All secrets come from the environment (a local `.env` for the first run, or
 * GitHub Actions secrets when running headless on cron). Nothing here is ever
 * hard-coded with a real value. See `.env.example` for the full list.
 *
 * Reads `.env` if present (no dependency: a tiny parser below), so the owner can
 * run `npm run spike` without exporting variables manually.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Minimal .env loader. We avoid the `dotenv` dependency to keep the bot lean.
 * Lines are `KEY=value`; `#` comments and blank lines are ignored; surrounding
 * single/double quotes are stripped. Existing process.env values win (so
 * GitHub Actions secrets are never clobbered by a stray committed file).
 */
function loadDotEnv(): void {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;

  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${v}"`);
  return n;
}

/** Steam application id for Boundless (constant, from Boundlexx settings). */
export const STEAM_APP_ID = 324510;

/**
 * Directory where steam-user persists its machine-auth / sentry data. After the
 * first interactive 2FA, this lets later logins be headless. Gitignored.
 */
export const STEAM_SENTRY_DIR = resolve(ROOT, ".steam");

/** Where the cached DS query token lives (12h TTL, mirrors Boundlexx cache). */
export const QUERY_TOKEN_CACHE_FILE = resolve(ROOT, ".cache", "query-token.json");

/** Lazily-validated config. We only require the secrets a given command needs. */
export const config = {
  root: ROOT,

  // --- Steam (machine ticket) ---
  get steamUsername() {
    return req("STEAM_USERNAME");
  },
  get steamPassword() {
    return req("STEAM_PASSWORD");
  },

  // --- Boundless web / forum account (JWT + DS login) ---
  get boundlessUsername() {
    return req("BOUNDLESS_USERNAME");
  },
  get boundlessPassword() {
    return req("BOUNDLESS_PASSWORD");
  },
  /**
   * The Boundless ACCOUNT username (e.g. "Kanjiro77"), used in the DS /gameserver
   * path segment. Verified to differ from the web-login email AND the character
   * name: only the account username returns 200. Falls back to the web username.
   */
  get boundlessAccountUsername() {
    return process.env.BOUNDLESS_ACCOUNT_USERNAME || req("BOUNDLESS_USERNAME");
  },

  // --- Discovery server base. Boundlexx default for the live universe. ---
  get dsBase() {
    return process.env.DS_BASE ?? "https://ds.playboundless.com:8902";
  },

  // --- Boundless web account base (login + game JWT). Constant in Boundlexx. ---
  accountsBase: "https://account.playboundless.com",

  // --- Our ingest API ---
  get apiBase() {
    return process.env.API_BASE ?? "https://boundlessinfo-api.niccolo-sabato.workers.dev";
  },
  get ingestToken() {
    return req("INGEST_TOKEN");
  },

  // --- Discovery scan window (world id range to probe) ---
  get scanMin() {
    return optInt("SCAN_MIN", 1);
  },
  get scanMax() {
    return optInt("SCAN_MAX", 5000);
  },

  // --- Tuning (seconds / ms), mirrors Boundlexx defaults ---
  /** Pause between DS calls. Boundlexx default 1.0s. Be a good citizen. */
  dsDelayMs: optInt("DS_DELAY_MS", 1000),
  /** Pause between per-world (apiURL) calls. Boundlexx default 1.0s. */
  worldDelayMs: optInt("WORLD_DELAY_MS", 1000),
  /** Per-request timeout. Boundlexx default 5s. */
  requestTimeoutMs: optInt("REQUEST_TIMEOUT_MS", 8000),
} as const;

/**
 * BOUNDLESS_WORLD_POLL_RESOURCE_MAPPING (ported verbatim from Boundlexx,
 * MIT-licensed, config/settings/base.py). The world poll `resources` array is
 * positional: index -> Boundless item game id. Order is load-bearing, do not sort.
 */
export const RESOURCE_MAPPING: readonly number[] = [
  13620, // Rough Amethyst
  13624, // Rough Diamond
  13628, // Rough Emerald
  13632, // Rough Topaz
  13636, // Rough Ruby
  13640, // Rough Sapphire
  13644, // Rough Rift
  13648, // Rough Blink
  13652, // Copper Ore
  13656, // Iron Ore
  13660, // Silver Ore
  13664, // Gold Ore
  13668, // Titanium Ore
  13672, // Soft Coal
  13676, // Medium Coal
  13680, // Hard Coal
  13684, // Small Fossil
  13688, // Medium Fossil
  13692, // Large Fossil
  13696, // Ancient Tech Remnant
  13700, // Ancient Tech Component
  13704, // Ancient Tech Device
  13708, // Rough Umbris
  13712, // Rough Oortstone
  10775, // Trumpet Root
  10774, // Traveller's Perch
  10776, // Rosetta Nox
  10777, // Desert Sword
  10778, // Spineback Plant
  10779, // Twisted Aloba
  10780, // Stardrop Plant
  10781, // Oortian's Staff
  10782, // Basic Boulder
  10783, // Beanstalk Boulder
  10784, // Boulder Tower
  10785, // Boulder Ring
  10786, // Boulder Chip
  10787, // Tapered Boulder
  10788, // Mottled Tar Spot Fungus
  10789, // Clustered Tongue Fungus
  10790, // Branch Funnel Fungus
  10791, // Tinted-Burst Fungus
  10792, // Weeping Waxcap Fungus
  10793, // Glow Cap Fungus
  11632, // Oortian Rice
  11633, // Oorum Wheat
  11634, // Ancient Oat
  11642, // Starberry Vine
  11636, // Waxy Tuber Plant
  11644, // Juicy Starberry Vine
  11641, // Kranut Plant
  11635, // Tuber Plant
  11643, // Glossy Starberry Vine
  11637, // Exotic Tuber Plant
  11645, // Combustion Fraction
  11646, // Kindling Mass
  11647, // Goo
  33561, // Petrolim
  33562, // Primordial Resin
];

/**
 * Set of indices in RESOURCE_MAPPING that are EMBEDDED resources (mined from
 * inside the world: gems, ores, coal, fossils, ancient tech, umbris, oortstone),
 * as opposed to SURFACE resources (plants, fungi, boulders, crops, goo, liquids).
 *
 * In Boundlexx this comes from each item's `resource_data.is_embedded` flag.
 * The split is a fixed game-data fact: the first 24 entries (indices 0..23 =
 * gems through Rough Oortstone) are embedded; index 24 onward are surface.
 * Percentages are computed within each group (embedded total / surface total),
 * exactly as Boundlexx `_create_resource_counts` does.
 */
const EMBEDDED_COUNT = 24;
export function isEmbeddedIndex(index: number): boolean {
  return index < EMBEDDED_COUNT;
}
