# Boundless Info - Steam-login discovery and capture bot

A headless Node bot that logs into Steam and Boundless with a **dedicated
Boundless player account** (not the owner's main account) to reveal universe
data the public discovery server hides, and to read per-world live block
colours straight off each planet's game websocket.

What it surfaces that the public `list-gameservers` does not:

- **Exoworlds** (temporary worlds): absent from the public list; only an
  authenticated `/gameserver/<id>` probe returns them, with their `lifetime`.
- **Private sovereigns**: visible to an authenticated session via the same
  probe.
- **Per-world block colours**: read live from each world's planet websocket,
  not exposed by any HTTP endpoint.

It runs locally for the first setup (one-time Steam Guard 2FA), then headless on
a GitHub Actions cron using a persisted Steam refresh token (no further 2FA).

The auth + discovery flow is a faithful port of the MIT-licensed
[Boundlexx](https://github.com/AngellusMortis/boundlexx) game client
(`boundlexx/boundless/game/client.py`, `tasks/worlds.py`, `game/models.py`).
The block-colour capture was reverse-engineered from a real BoundlessProxyUi
session log. Attribution is preserved in the source comments.

---

## The auth chain (`src/steam.ts` + `src/auth.ts`)

Every authenticated call to the discovery server (DS) needs a **query token**.
Minting one is a four-step chain; the result is cached on disk for 12h.

1. **Steam auth session ticket** (`src/steam.ts`): log on to Steam via the
   `steam-user` library, confirm app ownership of Boundless (app id `324510`),
   and call `createAuthSessionTicket(324510)` a few seconds after `loggedOn` (a
   settle delay lets the game-connect token arrive). The ticket is returned as a
   lowercase hex string.
   - The first login triggers a one-time Steam Guard 2FA. With the mobile
     authenticator you must **type the rotating 5-character code** from the
     Steam Guard tab; tapping "Approve" alone is not enough (`steam-user`
     cancels the device-approval flow and demands a typed code).
   - On success a **refresh token** is persisted under `.steam/`
     (`refresh-token.json`). Later logins log on with that refresh token and
     need no 2FA. `rememberPassword:true` also persists the machine-auth sentry
     in the same directory.

2. **Boundless web session** (`src/auth.ts`): POST form-urlencoded
   `{login, password}` to `https://account.playboundless.com/dynamic/login`,
   keeping the returned session cookie.

3. **Game JWT** (`src/auth.ts`): GET
   `https://account.playboundless.com/api/v1/game-auth-token/boundless` with that
   cookie. `response.data` is the **game JWT** (used both as the DS `/login`
   `authToken` and, indirectly, as the websocket auth in capture).

4. **DS query token** (`src/auth.ts`): POST JSON
   `{authToken: <gameJWT>, steamTicket: <hexTicket>, vcplatform: 1}` to
   `${DS_BASE}/login`. The response carries:
   - `characters[]`: the first character signs all later world-poll calls.
   - `queryToken`: the opaque token used as the authenticated POST body (see
     protocol below).
   - `token`: a rich account JWT, stored as `gameToken`, used as the **websocket
     auth token** for colour capture.

The query token, character, `gameToken`, the account username, and a `mintedAt`
timestamp are cached in `.cache/query-token.json` for **12h**, keyed by the
Boundless account username. A cache entry from before `gameToken` existed is
treated as stale and re-minted.

### The authenticated DS wire protocol (`src/protocol.ts`)

Two distinct request-body shapes, ported verbatim from Boundlexx:

- **Plain DS POST** (`/gameserver/...`, `/distance/...`): the body is the
  `queryToken` string as raw UTF-8, with a literal `q` prepended when the path
  contains `/gameserver/` or `/worldpoll`. Content-Type
  `application/octet-stream`. In practice `/gameserver` always takes this branch
  and gets the `q` prefix.

- **World-poll POST** (`/worldpoll` on a world's own `apiURL`): the body is a
  packed struct (little-endian), no `q` prefix, no Content-Type:
  `int8 len(username)` + `username` UTF-8 + `uint32LE playerId` + `pollToken`.
  The `username` here is the **Boundless ACCOUNT username** (e.g. `ExampleUser`),
  verified against the live DS. Boundlexx used the lowercased character name
  because for that account the two happened to coincide; they differ here.

The DS signals a **stale token** with an empty-body HTTP 400. The discovery flow
detects this, invalidates the cache, re-mints once, and retries.

The `/gameserver` path also uses the **account username**, not the web-login
email and not the character name. Only the account username returns 200; this
was confirmed with `src/diag.ts`. `BOUNDLESS_ACCOUNT_USERNAME` carries it (falls
back to `BOUNDLESS_USERNAME`).

---

## What the bot does

### Discovery + resource ingest (`run` / `poll-once`)

`src/index.ts` -> `src/discover.ts` -> `src/ingest.ts`.

1. Mint or reuse the DS query token (12h cache).
2. Probe every world id in `[SCAN_MIN, SCAN_MAX]` with
   `POST /gameserver/<accountUser>/<id>/<characterId>`.
   - Missing ids (404/410) are skipped silently.
   - For each existing, unlocked world, fetch its world poll from the world's own
     `apiURL` `/worldpoll`. The positional `resources` array is mapped to item
     ids via `RESOURCE_MAPPING` and split into **embedded** (first 24 entries:
     gems, ores, coal, fossils, ancient tech, umbris, oortstone) vs **surface**
     resources, with a per-group percentage (matching Boundlexx
     `_create_resource_counts`).
   - The poll also yields the **settlement leaderboard** (ranked name + prestige
     + mayor).
   - A 400 poll on a sovereign world is expected and skipped gracefully.
3. POST all discovered worlds to `${API_BASE}/api/ingest/worlds` with
   `Authorization: Bearer ${INGEST_TOKEN}`.

A world is classified for logging as `sovereign` (sovereign flag),
`exo` (`lifetime` set, not sovereign), or `perm` (no lifetime).

### Live block-colour capture (`capture`)

`src/capture-cli.ts` -> `src/capture-colors.ts`. No game client, no proxy.

For each requested world id:

1. `POST /gameserver/...` (the same call discovery uses) to obtain the world's
   `websocketURL`.
2. Open that planet **websocket** directly (Node's global `WebSocket`, requires
   Node 22+).
3. On connect, send a **single apiId-0 message** whose payload is plain JSON
   auth: `{ characterId, gameVersion, options, portalRank, token: <gameToken>,
   version, worldId, ... }`. The real authentication is the `gameToken` (the DS
   `/login` `token` JWT); `portalRank` is a per-connection placeholder.
4. Read the server's **apiId-0 reply**, parse its JSON, and pull
   `config.world.blockColors` (a `{ blockName: colourId }` map).
5. POST the colours to `${API_BASE}/api/ingest-ws-data` (Bearer auth).

**Boundless frame format** (the payload inside each binary WS frame; the WS
client masks client-to-server frames for us, so only the inner payload is built):

```
[ msgCount : uint16 LE ]        (high bit 0x8000 is a flag, masked off on read)
then, per message:
  [ len   : uint16 LE ]          length including the apiId byte
  [ apiId : 1 byte ]
  [ payload : len-1 bytes ]
```

`npm run capture <ids...>` captures specific worlds. `npm run capture -- --all`
captures every world: the id set is the union of the public `list-gameservers`
(reliable perms + public sovereigns) and our own `/api/v2/worlds` (adds exos +
private sovereigns). The API list is only trusted when it returns more than one
world (it can transiently return a degenerate single-world response), and the
discovery list is always used as a fallback.

The game version constants (`commitId`, version, protocol) are captured values;
if auth starts failing after a Boundless update, they may need refreshing.

### Closest-permanent distances (`distances`)

`src/distance-cli.ts` -> `src/distances.ts`. For each sovereign / exo world,
find the **nearest permanent world** (the one players portal from) and ingest it.

The game's own `assignment` field is just the adjacent gate, not the nearest
perm, so instead the bot queries the authenticated DS
`POST /distance/<accountUser>/<from>/<to>/<characterId>` (the official endpoint
community bots use) for the target against every perm in its region, keeping the
minimum in blinksecs. Results are POSTed to `${API_BASE}/api/ingest-distances`.

- Targets default to every sovereign / exo from `list-gameservers`. Optional id
  args (`npm run distances -- 7890 7891`) restrict to specific targets; since
  exos are not in `list-gameservers`, a missing id's region is looked up from
  `/api/v2/worlds` so same-region perms can still be picked.
- Same region is preferred (blink space is per-region); falls back to all perms
  if a region has none.

### Ingest body shape (`/api/ingest/worlds`)

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
      "owner": null,                        // player id for sovereigns, null for exos/perms
      "apiURL": "https://...",
      "websocketURL": "wss://...",
      "resources": [
        { "itemId": 13624, "count": 12345, "percentage": 8.2, "isEmbedded": true },
        { "itemId": 10775, "count": 6789,  "percentage": 4.1, "isEmbedded": false }
      ],
      "settlements": [
        { "rank": 1, "name": "Capital", "prestige": 123456, "mayorName": "SomeMayor" }
      ]
    }
  ]
}
```

`lifetime` present + not sovereign marks an exoworld; absent marks a permanent
world. `owner` is a number for sovereigns (including private), null otherwise.

---

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run bootstrap` | One-time interactive Steam Guard login. Persists the `.steam/` refresh token + sentry so later logins are headless, then mints a query token to prove the chain. Does NOT scan or ingest. |
| `npm run spike` | Single-world end-to-end proof: runs the full auth chain, fetches `SPIKE_WORLD_ID` via `/gameserver`, prints its data + resources. Does NOT ingest. |
| `npm run run` / `npm run poll-once` | Full discovery: probe `SCAN_MIN..SCAN_MAX`, collect worlds + resources + settlements, POST to `/api/ingest/worlds`. (`poll-once` is the cron alias.) |
| `npm run capture <ids...>` | Capture live block colours for the given world ids (or `-- --all` for every world) and POST to `/api/ingest-ws-data`. |
| `npm run distances [ids...]` | Compute the closest permanent world per sovereign/exo via DS `/distance` and POST to `/api/ingest-distances`. Optional ids restrict the targets. |
| `npm run diag` | Probe `/gameserver` with several candidate path usernames to confirm which one the DS accepts. Uses the cached token (no Steam login). |
| `npm run diag-poll` | Probe `/worldpoll` with several candidate username encodings to confirm the packed-struct username form. Refetches a fresh pollData per attempt. |

Two more diagnostics exist as source files (no npm script; run with
`node --experimental-strip-types src/<file>.ts`):

- `src/diag-ws.ts`: websocket feasibility spike. Connects to a world's game
  websocket and logs raw frames (opcode + length + hex head), looking for
  `blockColors`. Observes only, does not ingest.
- `src/diag-token.ts`: inspects the full DS `/login` response and decodes the
  game JWT, used to find the rich websocket-auth JWT (`gameToken`).

---

## Environment variables

All secrets come from a local `.env` (gitignored) or, on CI, from GitHub
Actions Secrets. Copy `.env.example` to `.env` and fill in real values locally.
Names only (see `.env.example` for inline notes):

| Variable | Purpose |
|----------|---------|
| `STEAM_USERNAME`, `STEAM_PASSWORD` | The dedicated Boundless account's Steam login (mints the Steam ticket for app 324510). |
| `BOUNDLESS_USERNAME`, `BOUNDLESS_PASSWORD` | The Boundless web/forum login (web session -> game JWT). |
| `BOUNDLESS_ACCOUNT_USERNAME` | The in-game account handle used in the DS `/gameserver`, `/worldpoll`, and `/distance` paths. Falls back to `BOUNDLESS_USERNAME` if unset. |
| `INGEST_TOKEN` | Bearer token the Worker checks on the ingest endpoints. |
| `API_BASE` | Base URL of the Boundless Info API Worker (default: production Worker). |
| `DS_BASE` | Discovery server base, including the `:8902` port (default: live universe). |
| `SCAN_MIN`, `SCAN_MAX` | Inclusive world-id range to probe each `run` (defaults 1..5000). |
| `SPIKE_WORLD_ID` | A single known-live world id for `npm run spike` (also the default target for `diag*`). |
| `DS_DELAY_MS`, `WORLD_DELAY_MS`, `REQUEST_TIMEOUT_MS` | Optional politeness delays / timeout (defaults 1000 / 1000 / 8000 ms). |

Optional debug flags (env, not in `.env.example`): `STEAM_DEBUG=1`,
`CAPTURE_DEBUG=1` add verbose logging.

---

## Setup

Requires **Node >= 22** (runs TS directly via `--experimental-strip-types`, no
build step). Node 24 is fine.

```bash
cd "projects/boundless-api/bot"

# 1. Install dependencies (run ONCE).
npm install

# 2. Create your local secrets file and fill it in (NEVER commit it).
cp .env.example .env
#   edit .env: STEAM_USERNAME/PASSWORD, BOUNDLESS_USERNAME/PASSWORD,
#   BOUNDLESS_ACCOUNT_USERNAME, INGEST_TOKEN, SPIKE_WORLD_ID.

# 3. One-time Steam Guard login. Type the 5-character code from the Steam
#    Guard tab when prompted (tapping Approve in the app is NOT enough).
#    Persists the refresh token + sentry under .steam/ for headless reruns.
npm run bootstrap

# 4. Verify the whole chain on a single world (prints its data + resources).
npm run spike

# 5. Full discovery + ingest (scans SCAN_MIN..SCAN_MAX, POSTs to the API).
npm run run
```

Start with a narrow `SCAN_MIN`/`SCAN_MAX` window while verifying, then widen.

---

## Headless / GitHub Actions cron

Because the persisted **Steam refresh token** lets later logins skip 2FA, the
bot runs headless on a schedule with no terminal:

- The cron job restores the `.steam/` contents (refresh token + sentry) produced
  locally by `npm run bootstrap`, then runs the desired scripts
  (`run` / `capture` / `distances`).
- If Steam ever forces a re-auth (the refresh token expires or is invalidated),
  re-run `npm run bootstrap` locally and refresh the stored sentry. When running
  non-interactively, a Steam Guard prompt is fatal by design: it means a human
  must re-bootstrap.
- Secrets on the runner mirror the `.env` variables above.

The workflow file itself lives outside this folder (in the public cron repo, so
the schedule + logs are public while secrets stay in GitHub Secrets).

---

## Security note

- Credentials live **only** in a local `.env` (gitignored) or in **GitHub
  Secrets**. They are never committed and never printed.
- The `.gitignore` excludes `node_modules/`, `.env`, `.env.local`, `.steam/`
  (machine-auth sentry + refresh token, account-bound and sensitive),
  `.session-main-backup/` (a backed-up previous-account session),
  `dslogin-full.json` (a sensitive DS login debug dump), `.cache/` (the 12h
  query token), and `*.log`. Treat the `.steam/` sentry like a credential.
- Double-check `git status` before committing.
- `steam-user` pulls in a `protobufjs` version with a published advisory
  (arbitrary code execution via crafted protobuf field names). Here all protobuf
  is exchanged only with Steam's own (trusted) servers, so it is not exploitable;
  `npm audit fix --force` would break `steam-user`. Revisit if `steam-user` ships
  a patched release.

---

## File map

| File | Responsibility |
|------|----------------|
| `src/config.ts` | Env loading, constants, `RESOURCE_MAPPING`, embedded/surface split |
| `src/steam.ts` | Steam ticket, refresh-token + sentry persistence, one-time 2FA |
| `src/auth.ts` | Boundless web session -> game JWT -> DS query token + gameToken (12h cache) |
| `src/protocol.ts` | Authenticated POST body construction (`q` prefix + poll packed struct) |
| `src/discover.ts` | ID probing -> worlds + resources + settlements |
| `src/capture-colors.ts` | Headless websocket block-colour capture + ingest |
| `src/capture-cli.ts` | `capture` CLI (specific ids or `--all`) |
| `src/distances.ts` | DS `/distance` query + distance ingest |
| `src/distance-cli.ts` | `distances` CLI (closest perm per sovereign/exo) |
| `src/ingest.ts` | POST discovered worlds to `/api/ingest/worlds` |
| `src/index.ts` | Orchestrate the full discovery run (`run` / `poll-once`) |
| `src/bootstrap.ts` | One-time interactive Steam Guard setup |
| `src/spike.ts` | Single-world end-to-end proof |
| `src/diag.ts`, `src/diag-poll.ts`, `src/diag-ws.ts`, `src/diag-token.ts` | Diagnostics (path username, poll struct, websocket frames, JWT inspection) |
| `src/steam-user.d.ts` | Minimal ambient typings for `steam-user` v5 |
