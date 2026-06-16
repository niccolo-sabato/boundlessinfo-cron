# boundlessinfo-cron

Scheduled data jobs for **Boundless Info** (https://boundlessinfo.pages.dev).

This repo is **public on purpose**: public repositories get unlimited free GitHub
Actions minutes, so the pollers run without touching the private repos' quota.
No source code or credentials live here in plaintext: jobs use GitHub **encrypted
secrets** (safe for scheduled workflows; fork pull requests never receive them).

## Jobs

- **poll-worlds** (every 10 min): fetches the game's public discovery server
  `ds.playboundless.com:8902/list-gameservers` and writes the raw payload to the
  Boundless Info Cloudflare KV namespace (key `worlds:raw`). The Worker normalizes
  it on read. Needs no game account / API key.
- **keepalive** (twice a month): a tiny empty commit so GitHub does not auto-disable
  the schedules after 60 days of inactivity.
- **(later) steam-capture**: the headless Steam-login bot that discovers exoworlds +
  resources + block colours and posts them to the API ingest endpoint. Added when
  built; will use Steam/Boundless credentials stored as encrypted secrets.

## Required secrets

Add these in **Settings -> Secrets and variables -> Actions**:

- `CLOUDFLARE_API_TOKEN` - a token scoped to **Account: Workers KV Storage: Edit**
  (create at https://dash.cloudflare.com/profile/api-tokens).
- `CLOUDFLARE_ACCOUNT_ID` = `7d557790c48857d04a8ef7d872ce6917`.

(The Steam bot will later add `STEAM_USERNAME`, `STEAM_PASSWORD`,
`BOUNDLESS_USERNAME`, `BOUNDLESS_PASSWORD`, and a persisted Steam sentry - all as
secrets, never committed.)

## Notes

KV namespace id (Boundless Info `WORLDS`): `dce399dc16a54d1aad5860cf201c41e9`.
This repo intentionally contains no game data or proprietary code; it only schedules
fetches against public endpoints and the owner's own Cloudflare resources.
