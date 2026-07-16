/**
 * Poll diagnostic (`npm run diag-poll`): the DS /gameserver call works, but the
 * world's own /worldpoll returns 400. The poll body is a packed struct whose
 * username field is the unknown (Boundlexx used the lowercased CHARACTER name,
 * but /gameserver needed the ACCOUNT username; those differ for this account).
 *
 * For each candidate username we re-fetch a FRESH pollData (it may be single-use)
 * and POST the packed body to {apiURL}/worldpoll, printing the raw status + body.
 */

import { getQueryToken, type QueryToken } from "./auth.ts";
import { config } from "./config.ts";
import { buildPlainBody } from "./protocol.ts";

function packPollBody(username: string, playerId: number, pollToken: string): Buffer {
  const nameBytes = Buffer.from(username, "utf8");
  const len = Buffer.alloc(1);
  len.writeInt8(nameBytes.length, 0); // '<b'
  const id = Buffer.alloc(4);
  id.writeUInt32LE(playerId >>> 0, 0); // '<I'
  return Buffer.concat([len, nameBytes, id, Buffer.from(pollToken, "utf8")]);
}

async function fetchWorld(token: QueryToken, worldId: number) {
  const path = `/gameserver/${token.username}/${worldId}/${token.player.id}`;
  const { body, headers } = buildPlainBody(path, token);
  const res = await fetch(`${config.dsBase}${path}`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`gameserver HTTP ${res.status}`);
  return (await res.json()) as { pollData: string; worldData: { apiURL: string } };
}

async function probePoll(label: string, apiURL: string, body: Buffer, headers: Record<string, string>) {
  console.log(`\n=== ${label} ===`);
  console.log("  headers:", JSON.stringify(headers), "| body len:", body.length);
  try {
    const res = await fetch(`${apiURL}/worldpoll`, { method: "POST", headers, body });
    const text = await res.text();
    console.log("  STATUS:", res.status, "| LEN:", text.length, "| BODY:", JSON.stringify(text.slice(0, 300)));
  } catch (e) {
    console.log("  FETCH ERROR:", (e as Error).message);
  }
}

async function main() {
  const worldId = Number(process.env.SPIKE_WORLD_ID || "10");
  const token = await getQueryToken();
  console.log("account username:", JSON.stringify(token.username));
  console.log("character name:", JSON.stringify(token.player.name), "| id:", token.player.id);

  const accountU = token.username; // ExampleUser
  const charU = token.player.name; // ExamplePlayer

  // [label, username, contentType?]
  const candidates: [string, string, string | null][] = [
    ["char-name lower (Boundlexx default)", charU.toLowerCase(), null],
    ["char-name as-is", charU, null],
    ["account-username as-is", accountU, null],
    ["account-username lower", accountU.toLowerCase(), null],
    ["account-username + octet-stream content-type", accountU, "application/octet-stream"]
  ];

  for (const [label, uname, ct] of candidates) {
    const fresh = await fetchWorld(token, worldId); // fresh pollData per attempt
    const body = packPollBody(uname, token.player.id, fresh.pollData);
    const headers = ct ? { "content-type": ct } : {};
    await probePoll(`${label} (uname="${uname}")`, fresh.worldData.apiURL, body, headers);
  }

  console.log("\nDone. The variant that returns 200 (JSON poll with a resources array) is correct.");
}

main().catch((e) => {
  console.error("[diag-poll] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
