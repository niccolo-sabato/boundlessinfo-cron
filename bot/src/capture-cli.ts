/**
 * CLI: capture live block colours for worlds and ingest them.
 *   npm run capture 6096 7891 ...   capture specific world ids
 *   npm run capture -- --all         capture EVERY world (perms + sovereigns + exos)
 * Headless: uses the persisted Steam refresh token (no game / no proxy).
 */
import { captureWorldColours, ingestColours } from "./capture-colors.ts";
import { config } from "./config.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Every world id to capture: the public discovery (reliable list of perms +
 * public sovereigns) UNION our API (adds exos + private sovereigns). The API can
 * transiently return a degenerate 1-world response, so we only trust it when it
 * lists more than one and always fall back to the discovery.
 */
async function getAllWorldIds(): Promise<number[]> {
  const ids = new Set<number>();

  try {
    const r = await fetch(`${config.dsBase}/list-gameservers`);
    if (r.ok) {
      for (const w of (await r.json()) as { id?: number }[]) {
        if (Number.isFinite(w.id)) ids.add(w.id as number);
      }
    }
  } catch {
    /* discovery unreachable; rely on the API */
  }

  try {
    const r = await fetch(`${config.apiBase}/api/v2/worlds`);
    if (r.ok) {
      const list = ((await r.json()) as { results?: { id?: number }[] }).results ?? [];
      if (list.length > 1) {
        for (const w of list) if (Number.isFinite(w.id)) ids.add(w.id as number);
      }
    }
  } catch {
    /* API unreachable; rely on the discovery */
  }

  return [...ids];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let ids: number[];
  if (args.includes("--all")) {
    ids = await getAllWorldIds();
    console.log(`[capture] --all: ${ids.length} worlds from /api/v2/worlds`);
  } else {
    ids = args.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  }
  if (ids.length === 0) {
    console.error("usage: npm run capture <worldId ...>   |   npm run capture -- --all");
    process.exit(1);
  }

  let ok = 0;
  let fail = 0;
  for (const id of ids) {
    try {
      const r = await captureWorldColours(id);
      if (r && (await ingestColours(r))) {
        ok++;
        console.log(`[capture] world ${id}: ${Object.keys(r.blockColors).length} colours -> OK`);
      } else {
        fail++;
        console.log(`[capture] world ${id}: ${r ? "ingest FAILED" : "no world-config"}`);
      }
    } catch (e) {
      fail++;
      console.log(`[capture] world ${id}: ERROR ${e instanceof Error ? e.message : e}`);
    }
    await sleep(1200); // be a good citizen between worlds
  }
  console.log(`[capture] done: ${ok} ok, ${fail} failed`);
}

main().catch((e) => {
  console.error("[capture] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
