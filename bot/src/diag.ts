/**
 * Diagnostic (`npm run diag`): figure out the exact /gameserver request the DS
 * accepts. Uses the CACHED query token (no Steam login), then POSTs the same
 * q-prefixed body to several URL variants and prints the raw status + body for
 * each. Whichever returns a non-400 (ideally 200 with JSON) is the correct form.
 *
 * This isolates open question #2 (queryToken/username encoding) without the
 * re-auth cascade that masks the real DS response in the normal flow.
 */

import { getQueryToken } from "./auth.ts";
import { config } from "./config.ts";
import { buildPlainBody } from "./protocol.ts";

async function probe(label: string, url: string, body: Buffer, headers: Record<string, string>) {
  console.log(`\n=== ${label} ===`);
  console.log("URL:", url);
  try {
    const res = await fetch(url, { method: "POST", headers, body });
    const text = await res.text();
    console.log("STATUS:", res.status, res.statusText);
    console.log("BODY LEN:", text.length);
    console.log("BODY:", JSON.stringify(text.slice(0, 600)));
  } catch (e) {
    console.log("FETCH ERROR:", (e as Error).message);
  }
}

async function main() {
  const worldId = Number(process.env.SPIKE_WORLD_ID || "10");

  // Cached token from bootstrap (valid 12h); no Steam login here.
  const token = await getQueryToken();
  console.log("token.username:", JSON.stringify(token.username));
  console.log("token.player.name:", JSON.stringify(token.player.name), "| id:", token.player.id);
  console.log("token.token length:", token.token.length, "| prefix:", token.token.slice(0, 10) + "...");
  console.log("dsBase:", config.dsBase, "| worldId:", worldId);

  // The q-prefixed octet-stream body is identical for every URL variant.
  const { body, headers } = buildPlainBody("/gameserver/", token);
  console.log("request body len:", body.length, "| starts with 'q':", body[0] === 0x71);

  const base = config.dsBase;
  // Candidate usernames for the /gameserver path segment (the unknown). The DS
  // wants the Boundless ACCOUNT username here, which differs from the web-login
  // email and from the character name.
  const usernames: [string, string][] = [
    ["account-username ExampleUser", "ExampleUser"],
    ["steam-username Ignifer77", "Ignifer77"],
    ["character-name from token", token.player.name],
    ["boundless-username/email from token", token.username]
  ];

  for (const [label, uname] of usernames) {
    const url = `${base}/gameserver/${uname}/${worldId}/${token.player.id}`;
    await probe(label, url, body, headers);
  }

  console.log("\nDone. The variant that returns 200 (JSON worldData) is the correct URL form.");
}

main().catch((e) => {
  console.error("[diag] fatal:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
