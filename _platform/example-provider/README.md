# @intentic-app/example-provider

A complete, working paid service in one dependency-free file — the reference a third-party provider copies,
and the endpoint the platform's own conformance suite is driven against. A service on intentic is not an
extension: no manifest, no bundle, no repo pointer. It is one https endpoint that verifies a signature and
streams NDJSON, and this package is exactly that and nothing more.

## Responsibilities

- Implement the whole provider contract as copyable reference code: verify
  `HMAC-SHA256(secret, "{timestamp}.{body}")` on every call (refusing forgeries **and** replays — two of the
  three admission-probe checks), then stream `status` lines and exactly one `result` (the third).
- Reproduce every settlement on demand, test-card style: the request's `scenario` picks the outcome
  (`ok` / `slow` / `refuse` / `fail` / `broken`) and `paceMs` the stream's tempo — the same vocabulary as the
  platform-hosted `demo-research` service, so one request shape drives both.
- Be the fixed end the platform's gates are tested against: the api's `pool-conformance.test.ts` runs the
  REAL admission probe and the REAL metered forward against this very handler, so the probe's demands and
  the reference's behaviour cannot drift apart unnoticed.

## Key files

- [src/provider.ts](src/provider.ts) — the whole service: signature verification, scenarios, the NDJSON
  stream. A real provider replaces the canned answer and keeps everything else.
- [src/main.ts](src/main.ts) — boots it under Bun: `SERVICE_SECRET` (required), `PORT` (default 8790).

## Running it

```sh
SERVICE_SECRET=whatever-your-listing-answered pnpm --filter @intentic-app/example-provider dev
```

`GET /healthz` answers unsigned (for your own uptime checks); every `POST` is a metered run and must carry
the platform's signature. The listing rules require a public **https** endpoint — this process serves plain
http, so put TLS in front (a reverse proxy, a tunnel, any PaaS).

## Listing it — the whole walk, end to end

This is the open-admission path a real provider takes, usable as-is to exercise the provider side of the
economy on a staging platform (Stripe in test mode):

1. **Claim your publisher name** (Settings → Creator) — proved against the registry, and the name your
   earnings accrue to.
2. **Connect payouts** — Stripe's hosted onboarding; test mode completes with its documented test values.
3. **Draft the listing** — slug, name, description, price, your public endpoint URL, and a sample request
   your endpoint really serves (e.g. `{"query":"a worked example","paceMs":0}`). The draft answers your
   signing secret **once**; set it as `SERVICE_SECRET` and deploy.
4. **Run the health check** — the probe sends your own sample request signed, then a forged and a replayed
   call it expects refused. This package passes all three.
5. **Publish** — live on probation the same second, under probation's price ceiling. Members can run it;
   every run earns.
6. **Watch the watch work** — run it with `{"scenario":"fail"}` a few times and the refund rate climbs in
   your provider view and the public ledger; keep going past the published threshold and the canary/watch
   suspends the listing, exactly as it would a real flaky provider. `{"scenario":"ok"}` runs graduate it.

## How it fits

The platform's forward ([pool-services.ts](../api/src/pool/pool-services.ts)) is the only caller that can
produce a valid signature, so the signature is the provider's whole auth story. The scenario vocabulary is
shared with the platform-hosted demo service ([pool-demo.ts](../api/src/pool/pool-demo.ts)): the demo covers
the member-facing flow without any deployment, and this package covers what the demo is exempt from — open
admission, the watch, and earnings — by being a real, listable endpoint.
