/**
 * One-time interactive setup (`npm run bootstrap`). Run this LOCALLY once to
 * complete the Steam Guard 2FA and persist the machine-auth sentry under
 * `.steam/`, after which the bot can log in headlessly (e.g. on GitHub Actions).
 *
 * It also mints a fresh DS query token to prove the whole chain works end to
 * end. It does NOT scan or ingest anything.
 *
 * For CI you commit nothing here: the persisted `.steam/` sentry must be copied
 * into the runner via secrets/artifacts (see README, GitHub Actions section).
 */

import { getQueryToken } from "./auth.ts";
import { STEAM_SENTRY_DIR } from "./config.ts";

async function main(): Promise<void> {
  console.log("[bootstrap] Starting one-time Steam Guard login.");
  console.log("[bootstrap] If prompted, enter the code from your Steam Mobile app or email.");

  // interactive:true + forceRefresh:true => always do a live login so the
  // sentry is (re)written, and prompt for the 2FA code if Steam asks.
  const token = await getQueryToken({ interactive: true, forceRefresh: true });

  console.log("[bootstrap] Success.");
  console.log(`[bootstrap] Character: ${token.player.name} (id ${token.player.id})`);
  console.log(`[bootstrap] Steam sentry persisted under: ${STEAM_SENTRY_DIR}`);
  console.log("[bootstrap] Future logins should be headless. Next: `npm run spike`.");
}

main().catch((err) => {
  console.error("[bootstrap] fatal:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
