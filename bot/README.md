# Boundless Info - Steam-login discovery bot

Discovers live **exoworlds** (which are NOT in the public `list-gameservers`)
and their world-poll **resources** by authenticating with the owner's own Steam
+ Boundless player account, probing world IDs against the universe discovery
server, and POSTing the results to the Boundless Info ingest API.

Runs locally for the first run (one-time Steam Guard 2FA), then headless on a
GitHub Actions cron.

The auth + discovery flow is a faithful port of the MIT-licensed
[Boundlexx](https://github.com/AngellusMortis/boundlexx) game client
(`boundlexx/boundless/game/client.py`, `tasks/worlds.py`, `game/models.py`).
Attribution is preserved in the source comments.

---

## How it works (the verified auth chain)

1. **Steam ticket** (`src/steam.ts`): log in to Steam via the `steam-user`
   library (app id `324510` = Boundless), then `getAuthSessionTicket(324510)`
   -> a hex ticket string. The first login prompts a one-time Steam Guard code
   and persists a machine-auth sentry under `.steam/`, so later logins are
   headless.
2. **Boundless web session** (`src/auth.ts`): POST form-urlencoded
   `{login, password}` to `https://account.playboundless.com/dynamic/login`
   -> a session cookie.
3. **Game JWT** (`src/auth.ts`): GET
   `https://account.playboundless.com/api/v1/game-auth-token/boundless` with
   that cookie -> `response.data` is the game JWT.
4. **Query token** (`src/auth.ts`): POST JSON
   `{authToken: <gameJWT>, steamTicket: <hexTicket>, vcplatform: 1}` to
   `${DS_BASE}/login` -> `{characters, queryToken}`. Cached on disk for 12h.
5. **Authenticated calls** (`src/protocol.ts`, `src/discover.ts`):
   - `get_world_data` -> DS `POST /gameserver/<user>/<id>/<accountId>`, body is
     the query token prefixed with a literal `q` (Content-Type
     `application/octet-stream`).
   - `get_world_poll` -> the world's own `apiURL` `POST /worldpoll`, body is a
     packed struct: `int8 len(name)` + `name` (lowercased) + `uint32LE playerId`
     + `pollToken` (no `q` prefix, no Content-Type).

**Discovery** (`src/discover.ts`): probe `[SCAN_MIN, SCAN_MAX]`. For each world
that exists, capture `worldData` (incl. exos: `lifetime` set, no owner) and, if
not locked, its world poll resources (embedded + surface, with count +
percentage + item id). Missing ids (404/410) are skipped; a 400 poll on a
sovereign world is expected and skipped.

**Ingest** (`src/ingest.ts`): `POST ${API_BASE}/api/ingest/worlds` with
`Authorization: Bearer ${INGEST_TOKEN}` and body `{ worlds: [...] }`.

### Ingest body shape

```jsonc
{
  "worlds": [
    {
      "id": 250,
      "name": "world_name_internal",
      "displayName": "Display Name",
      "region": "use",
      "tier": 4,
      "worldType": 3,
      "specialWorldType": 0,
      "worldSize": 192,
      "numRegions": 49,
      "atmosphereColor": [0.5, 0.6, 0.7],   // linear RGB floats, or null
      "waterColor": [0.1, 0.2, 0.3],        // linear RGB floats, or null
      "lifetime": [1700000000, 1700600000], // [startEpoch, endEpoch] or null (perm)
      "sovereign": false,
      "apiURL": "https://...",
      "websocketURL": "wss://...",
      "resources": [
        { "itemId": 13624, "count": 12345, "percentage": 8.2, "isEmbedded": true },
        { "itemId": 10775, "count": 6789,  "percentage": 4.1, "isEmbedded": false }
      ]
    }
  ]
}
```

`percentage` is computed within each group (embedded total vs surface total),
matching Boundlexx `_create_resource_counts`. `lifetime` present + not sovereign
marks an exoworld; absent marks a permanent world.

---

## Setup (exact commands)

Requires **Node >= 22** (uses native `--experimental-strip-types` to run TS; no
build step). Node 24 is fine.

```bash
cd "projects/boundless-api/bot"

# 1. Install dependencies (run ONCE).
npm install

# 2. Create your local secrets file and fill it in (NEVER commit it).
cp .env.example .env
#   edit .env: STEAM_USERNAME/PASSWORD, BOUNDLESS_USERNAME/PASSWORD,
#   INGEST_TOKEN, and SPIKE_WORLD_ID (a known-live world id).

# 3. One-time Steam Guard login. Enter the 2FA code when prompted.
#    This persists the machine-auth sentry under .steam/ so later runs are headless.
npm run bootstrap

# 4. Verify the whole chain on a single world (prints its data + resources).
npm run spike

# 5. Full discovery + ingest (scans SCAN_MIN..SCAN_MAX, POSTs to the API).
npm run run
```

`npm run poll-once` is an alias of `npm run run` for the cron entrypoint.

Start with a narrow `SCAN_MIN`/`SCAN_MAX` window while verifying, then widen.

---

## Security note

- Credentials live **only** in a local `.env` (gitignored) or in **GitHub
  Secrets**. They are NEVER committed and NEVER printed.
- `.steam/` (the Steam machine-auth sentry) and `.cache/` (the 12h query token)
  are gitignored. The sentry is account-bound and sensitive: treat it like a
  credential.
- `.gitignore` already excludes `node_modules/`, `.env`, `.steam/`, `.cache/`,
  and `*.log`. Double-check `git status` before committing.

---

## Running on GitHub Actions cron (later)

The workflow file is **not** in this folder. It will live in the public
`boundlessinfo-cron` repo (so the schedule + logs are public, but the secrets
are not). Outline of what it will do:

- Schedule: `cron` (e.g. every 30-60 min).
- Secrets (repo settings -> Secrets and variables -> Actions):
  `STEAM_USERNAME`, `STEAM_PASSWORD`, `BOUNDLESS_USERNAME`,
  `BOUNDLESS_PASSWORD`, `INGEST_TOKEN`, and optionally `API_BASE`, `DS_BASE`,
  `SCAN_MIN`, `SCAN_MAX`.
- The **headless catch**: `steam-user` needs the persisted `.steam/` sentry to
  log in without a 2FA prompt. CI has no terminal to type the code into. So the
  sentry produced locally by `npm run bootstrap` must be made available to the
  runner. Options (decide at workflow-build time):
  1. Base64-encode the `.steam/` contents into a secret and restore it at the
     start of the job (simplest; rotate if Steam invalidates it).
  2. Cache it as an encrypted artifact between runs.
  - Either way, if Steam ever forces a re-auth, re-run `npm run bootstrap`
    locally and refresh the secret/artifact.
- The job then runs `npm ci && npm run run`.

---

## GAPS / things only a real-credential spike can confirm

These are the assumptions ported from Boundlexx that a single authenticated run
should validate. Until then, treat them as unverified:

1. **Exact `DS_BASE` for `/login` + `/gameserver`.** Boundlexx points
   `BOUNDLESS_API_URL_BASE` at a local sandbox by default; the live universe DS
   is `https://ds.playboundless.com:8902` (same host as the public
   `list-gameservers`). The default here assumes `/login`, `/gameserver/...`,
   and `/distance/...` all share that base. If `/login` lives on a different
   host/port than `/gameserver`, split them into two settings. **Confirm with
   the spike.**
2. **The `queryToken` body encoding.** We send the token as raw UTF-8 bytes
   (with the `q` prefix for `/gameserver`), Content-Type
   `application/octet-stream`, exactly as `client.py`. If the DS rejects this
   with an empty-body 400 even on a fresh token, the encoding assumption is
   wrong (e.g. the token may already be hex/base64 that needs decoding before
   sending). The code auto-retries once on a stale-token 400; persistent 400s
   point here. **Confirm with the spike.**
3. **The `/worldpoll` packed-struct body.** `int8 len(name)` +
   `name.lower()` utf8 + `uint32LE playerId` + `pollToken` utf8, no Content-Type.
   Faithful to `client.py`, but the player `name` casing / encoding and the
   `pollData` token format are only verifiable against a live world poll.
   **Confirm with the spike on a known-live, unlocked world.**
4. **Whether headless probing actually returns exos.** The whole premise is that
   authenticated `/gameserver/<id>` probing surfaces exoworlds absent from
   `list-gameservers`. The spike on a known-exo id (or a `run` over the exo id
   window) is what proves it. If exos do NOT appear via this auth flow, the
   discovery strategy (id range, or the need for a specific universe/character)
   needs rethinking.
5. **Resource embedded/surface split + percentages.** The embedded set is the
   first 24 entries of `RESOURCE_MAPPING` (gems/ores/coal/fossils/ancient
   tech/umbris/oortstone); the rest are surface. This mirrors Boundlexx's
   per-item `resource_data.is_embedded`. If a future game update reorders or
   extends the poll `resources` array, `RESOURCE_MAPPING` (in `src/config.ts`)
   must be updated to match. **Sanity-check the spike's resource list against a
   known world.**
6. **`steam-user` version + ticket validity window.** Boundlexx pinned
   `steam-user@4.19.x`, whose method was `getAuthSessionTicket(appid, cb)` with
   a raw-Buffer callback. This port targets `steam-user@5.x` (installed 5.3.0),
   where the method is `createAuthSessionTicket(appid, cb)` and the callback
   resolves `{ sessionTicket: Buffer }`. The code uses the v5 surface (verified
   against the installed library at build time). Both produce the same
   on-the-wire ticket bytes, but if the DS rejects the v5 ticket, try pinning
   `steam-user@4.19.12` and reverting `src/steam.ts` to `getAuthSessionTicket`.
   Steam tickets are also short-lived: the 12h query-token cache assumes one
   ticket per token mint, which the spike validates.
7. **Transitive `protobufjs` advisory.** `steam-user` pulls in a `protobufjs`
   version with a published advisory (arbitrary code execution via crafted
   protobuf field names/defaults). In this bot all protobuf is exchanged with
   Steam's own servers (a trusted peer), so it is not exploitable here, and
   `npm audit fix --force` would break `steam-user`. Revisit if `steam-user`
   ships a patched release.

---

## File map

| File | Responsibility |
|------|----------------|
| `src/config.ts`    | Env loading, constants, `RESOURCE_MAPPING`, embedded/surface split |
| `src/steam.ts`     | Steam ticket + sentry persistence + one-time 2FA |
| `src/auth.ts`      | Boundless web session -> game JWT -> DS query token (12h cache) |
| `src/protocol.ts`  | Authenticated POST body construction (`q` prefix + poll struct) |
| `src/discover.ts`  | ID probing -> worlds + resources |
| `src/ingest.ts`    | POST to `/api/ingest/worlds` |
| `src/index.ts`     | Orchestrate the full run (`run` / `poll-once`) |
| `src/bootstrap.ts` | One-time interactive Steam Guard setup |
| `src/spike.ts`     | Single-world end-to-end proof |
