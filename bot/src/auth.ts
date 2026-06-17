/**
 * Steps 2-4 of the auth chain (ported from Boundlexx `client.py`, MIT):
 *
 *   2. BOUNDLESS WEB SESSION
 *      POST x-www-form-urlencoded {login, password} to
 *      `${accountsBase}/dynamic/login`  ->  sets a session cookie.
 *      (`_get_boundless_session`)
 *
 *   3. GAME JWT
 *      GET `${accountsBase}/api/v1/game-auth-token/boundless` with that cookie
 *      ->  response.data is the game JWT.  (`_get_game_jwt`)
 *
 *   4. QUERY TOKEN
 *      POST JSON {authToken: <gameJWT>, steamTicket: <hexTicket>, vcplatform: 1}
 *      to `${dsBase}/login`  ->  {characters, queryToken}.  (`query_token`)
 *      Cached for 12h on disk, keyed by Boundless username.
 *
 * The query token is what authenticates every later DS / world-poll call.
 */

import { config, QUERY_TOKEN_CACHE_FILE } from "./config.ts";
import { getSteamTicket } from "./steam.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A Boundless character as returned by the DS `/login` endpoint. */
export interface BoundlessCharacter {
  id: number;
  name: string;
  /** Other fields (location, etc.) exist but are not needed for discovery. */
  [key: string]: unknown;
}

/** Mirrors Boundlexx's QueryToken namedtuple: (player, token, username). */
export interface QueryToken {
  /** The first character on the account; its id + name sign world-poll calls. */
  player: BoundlessCharacter;
  /** Opaque query token string used as the authenticated POST body. */
  token: string;
  /** Boundless username this token belongs to (cache key). */
  username: string;
  /** Unix ms at which this token was minted (for the 12h TTL). */
  mintedAt: number;
  /** The rich account JWT (DS /login `token` field): the game websocket auth token. */
  gameToken: string;
}

const TWELVE_HOURS_MS = 43_200_000;

/** Fetch with an AbortController timeout (global fetch has no native timeout). */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract Set-Cookie values into a single Cookie header string. The Boundless
 * web login sets a session cookie we must replay on the JWT request. We keep
 * only name=value pairs (drop attributes like Path/HttpOnly/Expires).
 */
function collectCookies(res: Response): string {
  // Node's fetch exposes raw Set-Cookie via getSetCookie() (undici).
  const raw =
    typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);

  const pairs = raw
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.length > 0 && c.includes("="));
  return pairs.join("; ");
}

/**
 * Step 2: log in to the Boundless web/forum account and return the Cookie
 * header to replay. Ported from `_get_boundless_session`.
 */
async function getBoundlessSessionCookie(): Promise<string> {
  const body = new URLSearchParams({
    login: config.boundlessUsername,
    password: config.boundlessPassword,
  }).toString();

  const res = await fetchWithTimeout(`${config.accountsBase}/dynamic/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Boundless web login failed: HTTP ${res.status} ${await safeText(res)}`);
  }

  const cookie = collectCookies(res);
  if (!cookie) {
    throw new Error("Boundless web login returned no session cookie");
  }
  return cookie;
}

/**
 * Step 3: exchange the web session for the game JWT. Ported from
 * `_get_game_jwt`. The JWT is in response.data.
 */
export async function getGameJwt(): Promise<string> {
  const cookie = await getBoundlessSessionCookie();

  const res = await fetchWithTimeout(
    `${config.accountsBase}/api/v1/game-auth-token/boundless`,
    { headers: { cookie, accept: "application/json" } },
  );

  if (!res.ok) {
    throw new Error(`Game JWT request failed: HTTP ${res.status} ${await safeText(res)}`);
  }

  const data = (await res.json()) as { data?: string };
  if (process.env.CAPTURE_DEBUG) {
    console.error("[gamejwt] raw keys:", Object.keys(data), "| data len:", (data.data ?? "").length, "| full:", JSON.stringify(data).slice(0, 400));
  }
  if (!data?.data) {
    throw new Error("Game JWT response missing `data` field");
  }
  return data.data;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** Read a still-valid (< 12h) cached query token, or null. */
function readCachedToken(username: string): QueryToken | null {
  if (!existsSync(QUERY_TOKEN_CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(readFileSync(QUERY_TOKEN_CACHE_FILE, "utf8")) as QueryToken;
    if (cached.username !== username) return null;
    if (Date.now() - cached.mintedAt > TWELVE_HOURS_MS) return null;
    if (!cached.gameToken) return null; // cache from before gameToken existed -> force re-mint
    return cached;
  } catch {
    return null;
  }
}

function writeCachedToken(token: QueryToken): void {
  mkdirSync(dirname(QUERY_TOKEN_CACHE_FILE), { recursive: true });
  writeFileSync(QUERY_TOKEN_CACHE_FILE, JSON.stringify(token, null, 2), "utf8");
}

/** Drop the cached token (e.g. after the DS rejects it with an empty 400). */
export function invalidateQueryToken(): void {
  try {
    if (existsSync(QUERY_TOKEN_CACHE_FILE)) writeFileSync(QUERY_TOKEN_CACHE_FILE, "{}", "utf8");
  } catch {
    /* ignore */
  }
}

/**
 * Step 4: obtain a DS query token. Returns the cached one if still fresh,
 * otherwise runs the full chain (Steam ticket + game JWT -> DS /login) and
 * caches the result for 12h. Ported from the `query_token` cached_property.
 *
 * @param opts.interactive  pass-through to the Steam login (bootstrap = true).
 * @param opts.forceRefresh  ignore the cache and mint a new token.
 */
export async function getQueryToken(
  opts: { interactive?: boolean; forceRefresh?: boolean } = {},
): Promise<QueryToken> {
  // The DS /gameserver path needs the Boundless ACCOUNT username (e.g. Kanjiro77),
  // not the web-login email. The web login itself still uses config.boundlessUsername.
  const username = config.boundlessAccountUsername;

  if (!opts.forceRefresh) {
    const cached = readCachedToken(username);
    if (cached) return cached;
  }

  // Run Steam ticket + game JWT. Order matches Boundlexx (authToken first,
  // steamTicket second in the request body, but both are needed up front).
  const [authToken, steamTicket] = await Promise.all([getGameJwt(), getSteamTicket(opts)]);

  const res = await fetchWithTimeout(`${config.dsBase}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authToken, steamTicket, vcplatform: 1 }),
  });

  if (!res.ok) {
    throw new Error(`DS /login failed: HTTP ${res.status} ${await safeText(res)}`);
  }

  const data = (await res.json()) as {
    characters?: BoundlessCharacter[];
    queryToken?: string;
    token?: string;
  };
  if (!data.characters || data.characters.length === 0) {
    throw new Error("DS /login returned no character on this universe");
  }
  if (!data.queryToken) {
    throw new Error("DS /login response missing queryToken");
  }
  if (!data.token) {
    throw new Error("DS /login response missing the game token (websocket auth JWT)");
  }

  const token: QueryToken = {
    player: data.characters[0],
    token: data.queryToken,
    gameToken: data.token,
    username,
    mintedAt: Date.now(),
  };
  writeCachedToken(token);
  return token;
}
