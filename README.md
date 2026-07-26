# boundlessinfo-cron

Scheduled GitHub Actions for [Boundless Info](https://boundlessinfo.pages.dev). They keep the
live data current and ingest it into Cloudflare KV, D1 and R2. This repository is public
because it holds no secrets, only the jobs; every credential arrives as an Actions secret.

## Workflows

| Workflow | Cadence | What it does |
|---|---|---|
| `poll-worlds.yml` | every 10 minutes | world discovery, plus an immediate pass over newly spawned worlds |
| `steam-capture.yml` | every 6 hours | authenticated discovery, block colours, resources, closest-world distances |
| `shopping-capture.yml` | every 2 hours | shop prices from the official Shopping API: a cheap "hot" pass over known listings, then a rotating item shard to find new ones |
| `map-capture.yml` | 03:41 and 15:41 UTC | planet maps from the official LOD0 API, one world at a time |
| `keepalive.yml` | weekly | keeps the scheduled workflows enabled |

Each workflow lists the secrets it needs at the top of its file.

## The two blessed-key jobs

Shopping and maps use **different** API keys, both issued by the Boundless developers
(`BOUNDLESS_API_KEY` and `BOUNDLESS_API_KEY_LOD0`).

They are separate workflows on purpose. A LOD0 response takes **9 to 13 minutes** by design,
because the world server paces it so the request cannot disturb play, so a map run is long and
sparse. A shopping run is short and dense. Keeping them apart means a slow map capture can
never eat the budget that keeps prices fresh.

Both are bounded by wall-clock time and both pick up where they left off next run, so an
interrupted sweep is always safe.

### Costs are capped in code, not left to hope

- **Shopping** writes to D1, where the free tier allows 100k row-writes a day. The ingest is
  diff-based: a re-scan that finds nothing changed writes zero rows.
- **Maps** write to R2. The ingest refuses an upload past 200 worlds or 3 GiB and answers 507,
  which stops the run and exits non-zero so the Telegram alert fires.

## Rate limits, measured

A `403` from the Shopping API is **rate limiting**, not a bad key and not "this item cannot be
traded". The binding official rule is one response per second per api-key across the whole
universe, so parallelism buys nothing: measured 0 of 16 requests rejected at concurrency 1
against 3 of 16 at concurrency 16. Rejections on genuine cache misses run 10-20% and do not
fall if you slow down, because the server is balancing us against other users and the in-game
Knowledge queries. Retry politely; do not crawl.

## The bot

`bot/` is a copy of the capture bot, kept in sync from the private workspace by
`tools/sync-bot-to-cron.sh`. That script also scrubs the owner's real Boundless account name
out of comments and examples, and its `--check` mode fails if the public copy has drifted or if
the real name ever appears here.
