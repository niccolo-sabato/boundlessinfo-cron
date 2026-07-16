# boundlessinfo-cron

Scheduled GitHub Actions for [Boundless Info](https://boundlessinfo.pages.dev). They keep
the live world data current (world discovery, colour and resource capture, and closest-world
distances) and ingest it into Cloudflare KV.

## Workflows

- `poll-worlds.yml`: world discovery every 10 minutes, plus an immediate pass over newly
  spawned worlds.
- `steam-capture.yml`: authenticated discovery and colour/resource capture every 6 hours.
- `keepalive.yml`: keeps the scheduled workflows enabled.

Credentials are provided as GitHub Actions secrets; the required names are listed at the top
of each workflow.
