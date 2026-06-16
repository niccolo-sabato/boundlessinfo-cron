/**
 * Step 5 wire protocol: build the exact request bodies the authenticated DS /
 * world-poll endpoints expect. Ported verbatim from Boundlexx `client.py`
 * `_authentiated_post` (MIT). Two distinct body shapes:
 *
 *  A) PLAIN authenticated POST (get_world_data via /gameserver/..., and any DS
 *     path). Body = the queryToken string, optionally prefixed with a literal
 *     'q' when the path contains one of the PREFIXED_URLS. Content-Type is
 *     application/octet-stream.
 *
 *  B) WORLD-POLL POST (/worldpoll on the world's own apiURL). Body is a packed
 *     struct, NO 'q' prefix, NO explicit Content-Type:
 *        <b>  len(username)            (1 byte, signed)  + username utf8 bytes
 *        <I>  player id                (4 bytes, unsigned LE)
 *             poll_token utf8 bytes
 *     where username is the player's name lowercased and poll_token is the
 *     `pollData` string from the world data response.
 *
 * NOTE the asymmetry, faithfully reproduced from Boundlexx:
 *   - the 'q' prefix is applied to BOTH "/worldpoll" and "/gameserver/" paths
 *     ONLY in the plain (non-poll-token) branch. In practice get_world_poll
 *     always supplies a poll_token, so /worldpoll takes the packed-struct
 *     branch (no 'q'); /gameserver always takes the plain branch (gets 'q').
 */

import type { QueryToken } from "./auth.ts";
import { config } from "./config.ts";

/** Paths that get the literal 'q' prefix in the plain-token branch. */
const PREFIXED_URLS = ["/worldpoll", "/gameserver/"];

/** Result of building an authenticated request: body bytes + headers. */
export interface AuthRequest {
  body: Buffer;
  headers: Record<string, string>;
}

/**
 * Build the PLAIN authenticated POST body (branch A). Used for DS calls like
 * `/gameserver/<user>/<worldId>/<accountId>`.
 */
export function buildPlainBody(path: string, queryToken: QueryToken): AuthRequest {
  let data = queryToken.token;
  for (const url of PREFIXED_URLS) {
    if (path.includes(url)) {
      data = `q${data}`;
      break;
    }
  }
  return {
    body: Buffer.from(data, "utf8"),
    headers: { "content-type": "application/octet-stream" },
  };
}

/**
 * Build the WORLD-POLL POST body (branch B). Used for `/worldpoll` on a world's
 * own apiURL. `pollToken` is the `pollData` string from the world data response.
 *
 * Packing (little-endian, matching Python struct '<b' + '<I'):
 *   [0]        : len(username)  as signed int8
 *   [1..n]     : username utf8 bytes (player name, lowercased)
 *   [n+1..n+4] : player id as uint32 LE
 *   [n+5..]    : pollToken utf8 bytes
 */
export function buildPollBody(queryToken: QueryToken, pollToken: string): AuthRequest {
  // Verified against the live DS: /worldpoll wants the Boundless ACCOUNT username
  // (e.g. "Kanjiro77"), same as the /gameserver path, NOT the lowercased character
  // name. Boundlexx used player.name because for that account the two coincided.
  const username = queryToken.username;
  const nameBytes = Buffer.from(username, "utf8");
  const tokenBytes = Buffer.from(pollToken, "utf8");

  const lenByte = Buffer.alloc(1);
  lenByte.writeInt8(nameBytes.length, 0); // '<b'

  const idBytes = Buffer.alloc(4);
  idBytes.writeUInt32LE(queryToken.player.id >>> 0, 0); // '<I'

  return {
    body: Buffer.concat([lenByte, nameBytes, idBytes, tokenBytes]),
    // Boundlexx sends NO Content-Type for the poll-token branch.
    headers: {},
  };
}

/**
 * Perform an authenticated POST with a timeout. Mirrors `_authentiated_post`:
 * on an empty-body HTTP 400 the token is considered stale; the caller (auth
 * layer) handles re-mint + retry, so here we just surface the response.
 */
export async function authenticatedPost(url: string, reqShape: AuthRequest): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: reqShape.headers,
      body: reqShape.body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** True when a response is the DS "stale token" signal (empty-body 400). */
export async function isStaleTokenResponse(res: Response): Promise<boolean> {
  if (res.status !== 400) return false;
  try {
    const text = await res.clone().text();
    return text === "";
  } catch {
    return false;
  }
}
