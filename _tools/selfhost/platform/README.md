# Self-hosting the intentic platform

This compose stack runs the **platform** — the thin identity + sandbox-URL store that lives at
`app.intentic.dev` / `api.intentic.dev` — from the published images. It is **not** a sandbox: sandboxes are
per-user and get provisioned _through_ this platform (see [ARCHITECTURE.md](../../../ARCHITECTURE.md)).

```
browser ──▶ app.<zone> (web · nginx static SPA)
        └─▶ api.<zone> (api · Bun / Hono / oRPC / Better-Auth) ──▶ postgres
                             ▲
                      cloudflared tunnel
```

Web and api are separate origins under the **same registrable domain** on purpose: the Better-Auth session
cookie is `SameSite=Lax`, so `app.<zone>` → `api.<zone>` is cross-origin (CORS is load-bearing) but same-site
(the cookie rides). Keep them on the same apex.

## Prerequisites

1. **The images exist.** `ghcr.io/intentic/{web,api}` are published by
   `images-platform` on push to main, or by hand:
   ```sh
   docker login ghcr.io
   TAGS=latest pnpm publish:platform-images        # or TAGS="latest sha-abc1234"
   ```
   These packages are **private** — on the deploy host, `docker login ghcr.io` before `up`
   (the sandbox image is public; the platform is not).

2. **A Google OAuth client.** The web SPA's public client id is hardcoded in
   [environment.deployment.ts](../../../_editor/web/src/environments/environment.deployment.ts). Use that same
   client and, on it, authorize:
   - Authorized JavaScript origin: `https://app.intentic.dev` (your `WEB_ORIGIN`)
   - Authorized redirect URI: `https://api.intentic.dev/api/auth/callback/google` (your `API_URL` + `/api/auth/callback/google`)

3. **A Cloudflare tunnel.** Create one in the dashboard, copy its token into `PLATFORM_TUNNEL_TOKEN`, and add
   two public hostnames pointing at the compose services (cloudflared runs inside the network and resolves
   them by name):
   | Public hostname | Service |
   | --- | --- |
   | `app.intentic.dev` | `http://web:80` |
   | `api.intentic.dev` | `http://api:6480` |

## Run

```sh
cd _tools/selfhost/platform
cp .env.example .env         # fill EVERY required value (see comments in the file)
docker compose up -d
docker compose logs -f api   # first boot runs `prisma migrate deploy`, then serves
```

The api entrypoint applies Prisma migrations on every boot (idempotent, advisory-locked), so a fresh Postgres
volume self-initializes and an image bump self-migrates — no manual db step.

## Notes

- **Email / analytics are optional.** Invites log server-side and analytics stay off until their env vars are
  set. Google + the tunnel + the secrets are the only hard requirements.
- **Intentic-provided sandbox tunnels** need `INTENTIC_CLOUDFLARE_API_TOKEN` (+ zone). Without it, user setup
  offers only the bring-your-own-Cloudflare flow. This is intentic's own Cloudflare account credential.
- **Hosted sandboxes** (`HOSTED_FLY_API_TOKEN` + `HOSTED_FLY_ORG`, on top of the Cloudflare pair above) make
  signing in the whole setup: this deployment creates each new user's machine on its own Fly account and can
  wake, stop and destroy it. That is a deliberate hole in the boundary the rest of this platform keeps — read
  the hosted paragraph in [ARCHITECTURE.md](../../../ARCHITECTURE.md) before switching it on, and remember the
  bill is yours. Off by default; every other setup lane is unaffected. Create the token org-scoped
  (`fly tokens create org --org <org> --name intentic-hosted`) — a deploy token cannot create apps. Machines
  sleep after `HOSTED_IDLE_STOP_MINUTES` of nobody-connected-and-nothing-running and wake on the next visit,
  which is what keeps an idle user's cost at storage alone.
- **The hosted reaper deletes too.** A daily sweep destroys every Fly app under `HOSTED_APP_PREFIX` whose
  sandbox row is gone. Keep that prefix unique to this deployment, and do not put unrelated apps behind it.
- **Scaling:** the api is stateless (DB-backed sessions) and safe to run at `--scale api=N`; the retention
  reaper + sandbox-pool top-up take a Postgres advisory lock so replicas don't duplicate the work.
- **No host ports are published** — everything is reached over the tunnel. Add a `ports:` mapping to `api`/`web`
  only for local debugging.
- **The tunnel reaper deletes — and now prunes and heals.** Once `INTENTIC_CLOUDFLARE_API_TOKEN` is set, the
  daily sweep removes three kinds of clutter, because every sandbox holds ~10 DNS records against Cloudflare's
  per-zone cap (a Free-plan zone ≈ 200 records ≈ under 20 sandboxes; error 81045 is what a full zone answers
  every setup with):
  - **abandoned setups** — tunnels of sandboxes that never connected, past `INTENTIC_CLOUDFLARE_REAP_AFTER_DAYS` (7);
  - **long-offline sandboxes** — past `INTENTIC_CLOUDFLARE_PRUNE_AFTER_DAYS` (45; 0 = never). Recoverable by
    design: the sweep clears the sandbox's cached tunnel so the owner's next setup visit re-creates it — the
    address is derived from the sandbox's own token, so they get the SAME address back. Hosted sandboxes are
    never pruned this way: a sleeping machine's disconnected tunnel is the idle-stop working, not abandonment.
  - **orphaned DNS records** — records pointing at tunnels that no longer exist, plus the loopback
    (`local-*`) records nothing else ever cleaned. The sweep's `DNS record sweep completed` log line carries
    the zone's total record count — the quota-pressure number to watch.
  Deletes of true orphans are final — run a new deployment's first sweep with
  `INTENTIC_CLOUDFLARE_REAP_DRY_RUN=true` and read the candidates:
  ```sh
  docker compose logs api | grep -E 'tunnel reap|orphan DNS|DNS record sweep'
  ```
- **Back up the database yourself.** The `intentic-platform-db` volume is the stack's only state — accounts,
  sandbox registrations and the encrypted tokens. Nothing here schedules a dump; on the deploy host:
  ```sh
  docker compose exec -T postgres pg_dump -U intentic intentic | gzip > intentic-$(date +%F).sql.gz
  ```

## Continuous deploy via Komodo (optional)

Run this compose as a **Komodo stack** named `intentic-platform` and every main push redeploys itself:
`images-platform` ends with [deploy-platform.sh](../../scripts/deploy-platform.sh), which calls Komodo's
`DeployStack` — the stack's services run `:latest` with `pull_policy: always`, so the redeploy pulls what CI
just pushed. The stack name is set in the job's `env` (`PLATFORM_DEPLOY_STACK`) and the Komodo core origin
defaults to `https://komodo.radarsu.com`, leaving one thing to configure — the api key, as GitHub Actions
secrets:

| Variable | Value |
| --- | --- |
| `KOMODO_API_KEY` / `KOMODO_API_SECRET` | an api key minted in Komodo (mask both) |

Optional overrides: `KOMODO_URL` (a different core origin, e.g. `http://192.168.0.x:9120`) and
`PLATFORM_DEPLOY_STACK` (a different stack name — unsetting it in the rules disables the deploy).
