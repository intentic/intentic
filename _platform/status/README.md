# Status page

A Cloudflare Worker that probes the platform's three public doors every minute from outside its own box, keeps a day
of samples in a Durable Object, and serves the result as a page and as JSON for status.intentic.dev.

The platform api, its Postgres and the editor's origin share one box and one Cloudflare tunnel, so nothing on that box
can report that the box is down. This Worker runs on Cloudflare's network, and its state lives there too.

## Key files

- [worker.ts](worker.ts): the probes, the StatusLog Durable Object, the alert, the page and `/api/status`.
- [wrangler.jsonc](wrangler.jsonc): the Worker `intentic-status`, its minute cron, the SQLite Durable Object migration,
  and its custom domain status.intentic.dev (attached 2026-11-09).
- [worker-runtime.d.ts](worker-runtime.d.ts): the Cloudflare types the Worker uses, declared here because this
  directory is not a workspace package.

## What it checks

| Component | Probe | Operational when |
| --- | --- | --- |
| `api` | `GET https://api.intentic.dev/api/identity` | 200 JSON with an `identity`; that read needs the database |
| `editor` | `GET https://app.intentic.dev/` | 200 HTML holding the app's mount point |
| `edge` | `GET https://ingress.sbx.intentic.dev/health` | 200 JSON with `status: "ok"` |

The api also has `/health`, which answers `{"status":"ok"}` after a database ping and 503 `{"status":"error"}` without
one. `/api/identity` reads the same database, and it is the request the editor makes first.

All three probes run in parallel, each with an 8 s timeout, except the editor's 13 s, which outlasts the edge Worker's 10 s navigation deadline so a hung box reads as served from the edge copy rather than down. No answer, the wrong answer or a non-200 status counts as
`down`. A correct answer that took longer than 4 s counts as `degraded`. Once the edge failover
(`_editor/web/edge`) fronts the editor, a dead editor origin is answered from the edge copy
(`x-intentic-served-by: edge-fallback`): that also counts as `degraded`, since the editor still loads but sign-in and
the rest of the platform are gone.

A component's state changes only when two samples in a row agree, so one dropped request is not an outage and one good
answer in the middle of an outage is not a recovery. The very first sample sets the state directly. Each confirmed
change is posted to `ALERT_WEBHOOK_URL` as `{ "content": "…" }`, the shape Discord webhooks take, if that secret is
set. Samples older than 24 h are pruned on every round.

## Endpoints

- `GET /`: the page. Inline CSS only, light and dark from `prefers-color-scheme`, and a refresh every 60 s.
- `GET /api/status`: `{ updatedAt, overall, components: [{ id, name, state, latencyMs, since, detail, checkedAt }] }`,
  where `overall` is the worst component state (`operational`, `degraded` or `down`). It is sent with
  `access-control-allow-origin: *` and `cache-control: max-age=30`. Before the first cron round it probes live and
  records what it found.

## Deploying

By hand, from the repository root, with a token that can edit Workers scripts:

```sh
CLOUDFLARE_API_TOKEN=… wrangler deploy --config _platform/status/wrangler.jsonc
CLOUDFLARE_API_TOKEN=… wrangler secret put ALERT_WEBHOOK_URL --config _platform/status/wrangler.jsonc   # optional
```

A newly added cron can take several minutes to start firing. `wrangler dev --config _platform/status/wrangler.jsonc
--test-scheduled` runs it locally, and `GET /__scheduled` fires one round.
