# boundlessinfo-cron

Scheduled data jobs for **Boundless Info** (https://boundlessinfo.pages.dev).

## Why a separate public repo

This repo is **public on purpose**: public repositories get unlimited free GitHub
Actions minutes, so the pollers run without touching any private quota. More
importantly, GitHub runners can do work the Cloudflare Worker cannot: the Worker
has no outbound access to the game's discovery server on port **8902**, while a
GitHub Actions runner reaches it fine. So the scheduled scanning that the Worker
can't perform lives here instead.

No source code or credentials live here in plaintext. Jobs use GitHub **encrypted
secrets** (safe for scheduled workflows; fork pull requests never receive them).
The capture bot is bundled in this repo under `bot/` and is invoked via its npm
scripts (`npm run distances`, `npm run capture`, `npm run run`, `npm run bootstrap`).

The bot logs in with a **dedicated Steam / Boundless account** used only for this
service (credentials stay in secrets, never committed).

## Jobs

### poll-worlds.yml (every 10 minutes)

`cron: */10 * * * *`. The fast public pass plus on-demand scan of new worlds.

1. **Fetch live discovery**: `curl` the public list-gameservers endpoint
   `https://ds.playboundless.com:8902/list-gameservers` into `worlds.json`, then
   sanity-check it is a non-empty array. This payload carries the permanent worlds
   plus public (rented) sovereigns. It does **not** include exoworlds.
2. **Write `worlds:raw` to KV only when the world set changed**: the discovery
   payload carries volatile per-fetch fields (`_lastUpdate` timestamp, `info`
   with live player counts) that differ every time, so a naive compare would never
   skip a write. The job strips those fields and compares the stable per-world
   metadata against the current KV value. Most 10-minute polls are no-ops, so this
   turns roughly 144 writes/day (against the scarce 1k/day KV write quota) into
   roughly 144 cheap reads (against the 100k/day read quota) plus a handful of real
   writes when worlds spawn, expire, or get re-themed. The Worker normalizes the
   raw payload on read.
3. **Frontier exo/sovereign probe** (every cycle): exoworlds and private sovereigns
   are not in the public discovery, so the bot probes a small dynamic id window just
   above the highest id we already know (`compute-frontier.mjs` reads the max id from
   the API; ~46 `/gameserver` probes per cycle, since ids are incremental). The DS
   query token is cached 12h and persisted across runs with `actions/cache` (a
   12h-bucketed key), so the Steam/Boundless login happens ~twice a day, not every
   cycle. `npm run run` then ingests any newly-found worlds + their resources. (The
   bucket-key step uses `10#` to force base-10: `date +%H` is zero-padded, and bash
   would otherwise read `08/09/18/19` as invalid octal and fail those hours.)
4. **Detect new sovereign/exo worlds without a distance** (`detect-new-worlds.mjs`):
   reads the live API for the current sovereign/exo set and finds ids that still
   lack a closest-world distance, capped at 25 reachable ids (active exos + sovereigns
   still in discovery). Non-fatal: any failure emits an empty list and the poll still
   succeeds.
5. **Conditional fast-pass** (runs only when `has_new == 'true'`): for each freshly
   detected id, `npm run run -- <ids>` (resources), `npm run capture -- <ids>` (live
   block colours) and `npm run distances -- <ids>` (closest world). So a new
   exo/sovereign gets its colours, resources and distance within the 10-minute cycle
   instead of waiting for the 6-hour full pass.

### steam-capture.yml (every 6 hours)

`cron: 23 */6 * * *` (off the :00 mark). The full authenticated pass. Installs bot
deps, restores the Steam refresh token from a secret for headless login, then runs
three stages:

1. `npm run run`: discover + ingest (the frontier scan). This reveals current
   exoworlds and private sovereigns that are not in public discovery, refreshes
   resources + settlements, and POSTs them to the ingest API. Scans the configured
   id frontier (`SCAN_MIN` / `SCAN_MAX`, with `DS_DELAY_MS` / `WORLD_DELAY_MS`
   throttling).
2. `npm run capture -- --non-perm`: live block-colour capture for **sovereigns + exos**
   (their colours can change / are captured on spawn). Permanent worlds are skipped:
   their colours are fixed and served from the static snapshot, so re-capturing them is
   wasted work and account load. Connects to each world's game websocket with the
   DS-login JWT, reads the world's block colours, and ingests. No proxy, no game client.
3. `npm run distances`: orbited ("closest") world plus blinksec distance for every
   world, with the exo assignment read from the authenticated world-config.
4. **Self-heal resource coverage** (`detect-missing-resources.mjs` -> `npm run run -- <ids>`):
   asks the API which live worlds still have no captured resources (legacy public
   sovereigns below the scan frontier whose resources were never read, e.g. Hyrule) and
   scans exactly those. World resources are fixed at spawn, so once filled they persist
   and the change-aware ingest skips the KV write; this step then becomes a no-op.

### keepalive.yml (1st and 15th of each month)

`cron: 0 6 1,15 * *`. GitHub disables scheduled workflows after 60 days with no
repository activity. This job makes a tiny empty commit (`git commit --allow-empty`)
twice a month so the pollers never get auto-disabled.

## Required secrets

Add these in **Settings -> Secrets and variables -> Actions** (names only; never
commit the values):

| Secret | Used by | Purpose |
|--------|---------|---------|
| `STEAM_USERNAME` | poll-worlds (conditional), steam-capture | Dedicated Steam account login |
| `STEAM_PASSWORD` | poll-worlds (conditional), steam-capture | Dedicated Steam account login |
| `STEAM_REFRESH_TOKEN` | poll-worlds (conditional), steam-capture | Headless Steam login (no 2FA in CI). Generated locally once via `npm run bootstrap`; restored into `bot/.steam/refresh-token.json` at runtime. Re-run bootstrap and update the secret if it expires |
| `BOUNDLESS_USERNAME` | poll-worlds (conditional), steam-capture | playboundless.com web login (email) |
| `BOUNDLESS_PASSWORD` | poll-worlds (conditional), steam-capture | playboundless.com web login password |
| `BOUNDLESS_ACCOUNT_USERNAME` | poll-worlds (conditional), steam-capture | Boundless account handle |
| `INGEST_TOKEN` | poll-worlds (conditional), steam-capture | Auth for the Worker ingest API (same value as the Worker secret) |
| `CLOUDFLARE_API_TOKEN` | poll-worlds | Token scoped to Account: Workers KV Storage: Edit, for the `worlds:raw` KV write |
| `CLOUDFLARE_ACCOUNT_ID` | poll-worlds | Cloudflare account id for the KV write |

## Notes

The Boundless Info KV namespace id (`WORLDS`) is `dce399dc16a54d1aad5860cf201c41e9`
(used by poll-worlds for the `worlds:raw` key). This repo intentionally contains no
proprietary game data: it only schedules fetches against public endpoints, runs the
bundled bot against the owner's dedicated game account, and writes to the owner's
own Cloudflare and ingest resources.
