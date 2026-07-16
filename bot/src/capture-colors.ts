/**
 * Headless live block-colour capture (no proxy, no game client).
 *
 * Reverse-engineered from a real BoundlessProxyUi capture (boundless-capture.log):
 * the planet websocket speaks the Boundless frame protocol. The CLIENT, on
 * connect, immediately sends a single apiId-0 message whose payload is PLAIN
 * JSON auth (game JWT + character + world + version). The SERVER replies with an
 * apiId-0 JSON world-config carrying `config.world.blockColors` = {blockName:
 * colourId}. Nothing else is needed for the colours.
 *
 * Boundless frame (INSIDE the standard WS binary frame; the WS client masks
 * client->server frames for us, so we only build the inner payload):
 *   [msgCount: uint16 LE (0x8000 bit = flag, masked off on read)]
 *   then per message: [len: uint16 LE (incl. apiId)][apiId: 1 byte][payload]
 *
 * The auth `token` is the GAME JWT (account.playboundless.com game-auth-token),
 * which `auth.getGameJwt()` already produces. `portalRank` is a per-connection
 * client value treated by the server as reported game-state (the JWT is the real
 * auth), so a fixed placeholder is sent; if the server ever rejects it we adapt.
 */

import { getQueryToken } from "./auth.ts";
import { buildPlainBody, authenticatedPost } from "./protocol.ts";
import { config } from "./config.ts";

// Captured constants (update commitId/version on a game update if auth starts failing).
const GAME_VERSION = { buildStamp: "", commitId: "c6936248", major: 1, minor: 18, point: 94 };
const OPTIONS = {
  actionRepeatDelay: 0.0,
  cameraFarPlane: 1024.0,
  cheatGodMode: false,
  chunkLODEndDistances: [8, 16, 32, 48, 64],
  connectionInputProtection: false,
  interactInventoryToggle: true,
};
const PROTOCOL_VERSION = 258;
const PORTAL_RANK_PLACEHOLDER = "A".repeat(118);
const DEBUG = process.env.CAPTURE_DEBUG === "1";

/** Build one Boundless frame payload carrying a single message. */
function encodeFrame(apiId: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt16LE(1, 0); // message count
  head.writeUInt16LE(payload.length + 1, 2); // message length (includes apiId byte)
  head.writeUInt8(apiId, 4);
  return Buffer.concat([head, payload]);
}

/** Parse a Boundless frame payload into its messages. */
function decodeFrame(buf: Buffer): { apiId: number; payload: Buffer }[] {
  const out: { apiId: number; payload: Buffer }[] = [];
  if (buf.length < 2) return out;
  const count = buf.readUInt16LE(0) & 0x7fff;
  let off = 2;
  for (let i = 0; i < count && off + 3 <= buf.length; i++) {
    const len = buf.readUInt16LE(off);
    const apiId = buf[off + 2];
    out.push({ apiId, payload: buf.subarray(off + 3, off + 2 + len) });
    off += 2 + len;
  }
  return out;
}

export interface CaptureResult {
  worldId: number;
  blockColors: Record<string, number>;
}

/**
 * Connect headlessly to one world's planet websocket, send the auth, and return
 * its block colours (or null on failure/timeout). Uses the same /gameserver
 * call the discovery flow already uses to obtain the per-world websocketURL.
 */
export async function captureWorldColours(
  worldId: number,
  timeoutMs = 20000,
): Promise<CaptureResult | null> {
  const token = await getQueryToken();

  const path = `/gameserver/${token.username}/${worldId}/${token.player.id}`;
  const res = await authenticatedPost(`${config.dsBase}${path}`, buildPlainBody(path, token));
  if (!res.ok) {
    console.log(`[capture] /gameserver ${worldId} -> HTTP ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { worldData?: { websocketURL?: string } };
  const wsUrl = data.worldData?.websocketURL;
  if (!wsUrl) {
    console.log(`[capture] world ${worldId}: no websocketURL`);
    return null;
  }
  if (DEBUG) console.error(`[capture] world ${worldId} wsUrl=${wsUrl}`);

  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) throw new Error("global WebSocket missing (need Node 22+)");

  const auth = {
    characterId: token.player.id,
    firstConnection: true,
    gameVersion: GAME_VERSION,
    godMode: false,
    options: OPTIONS,
    portalRank: PORTAL_RANK_PLACEHOLDER,
    token: token.gameToken,
    version: PROTOCOL_VERSION,
    worldId,
  };

  return await new Promise<CaptureResult | null>((resolve) => {
    let done = false;
    const ws = new WS(wsUrl);
    (ws as WebSocket).binaryType = "arraybuffer";
    const finish = (r: CaptureResult | null) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    ws.onopen = () => {
      const frame = encodeFrame(0, Buffer.from(JSON.stringify(auth), "utf8"));
      ws.send(frame);
      if (DEBUG) console.error(`[capture] ws open -> sent auth ${frame.length}B (token ${token.gameToken.length}c, char ${auth.characterId})`);
    };
    ws.onmessage = (ev: MessageEvent) => {
      const buf = Buffer.from(ev.data as ArrayBuffer);
      for (const m of decodeFrame(buf)) {
        if (DEBUG) {
          const prev = m.payload.subarray(0, 200).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
          console.error(`[capture] <- apiId=0x${m.apiId.toString(16)} len=${m.payload.length} ${prev}`);
        }
        if (m.apiId !== 0 || m.payload.length === 0) continue;
        try {
          const o = JSON.parse(m.payload.toString("utf8")) as {
            config?: { world?: { blockColors?: Record<string, number> } };
          };
          const bc = o.config?.world?.blockColors;
          if (bc && Object.keys(bc).length > 0) {
            finish({ worldId, blockColors: bc });
            return;
          }
        } catch {
          /* not the world-config message */
        }
      }
    };
    ws.onerror = (e) => {
      if (DEBUG) console.error("[capture] ws error:", (e as { message?: string })?.message ?? e);
      finish(null);
    };
    ws.onclose = (e) => {
      if (DEBUG) console.error(`[capture] ws close code=${(e as { code?: number })?.code} reason=${(e as { reason?: string })?.reason}`);
      finish(null);
    };
    setTimeout(() => finish(null), timeoutMs);
  });
}

/** POST captured colours to our Worker ingest (Bearer auth). */
export async function ingestColours(r: CaptureResult): Promise<boolean> {
  const res = await fetch(`${config.apiBase}/api/ingest-ws-data`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.ingestToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ world_id: r.worldId, config: { world: { blockColors: r.blockColors } } }),
  });
  return res.ok;
}
