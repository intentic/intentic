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

1. **The images exist.** `registry.gitlab.com/radarsu/intentic/{web,api}` are published by
   `images:platform` on push to main, or by hand:
   ```sh
   docker login registry.gitlab.com
   TAGS=latest pnpm publish:platform-images        # or TAGS="latest sha-abc1234"
   ```
   These packages are **private** — on the deploy host, `docker login registry.gitlab.com` before `up`
   (the sandbox image is public; the platform is not).

2. **A Google OAuth client.** The web SPA's public client id is hardcoded in
   [environment.deployment.ts](../../../_apps/web/src/environments/environment.deployment.ts). Use that same
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

- **Stripe / email / analytics are optional.** Billing 404s, invites log server-side, and analytics stay off
  until their env vars are set. Google + the tunnel + the secrets are the only hard requirements.
- **Intentic-provided sandbox tunnels** need `INTENTIC_CLOUDFLARE_API_TOKEN` (+ zone). Without it, user setup
  offers only the bring-your-own-Cloudflare flow. This is intentic's own Cloudflare account credential.
- **Stripe webhook** (if billing): point it at `https://api.intentic.dev/api/auth/stripe/webhook`.
- **Scaling:** the api is stateless (DB-backed sessions) and safe to run at `--scale api=N`; the retention
  reaper + sandbox-pool top-up take a Postgres advisory lock so replicas don't duplicate the work.
- **No host ports are published** — everything is reached over the tunnel. Add a `ports:` mapping to `api`/`web`
  only for local debugging.

## Continuous deploy via Komodo (optional)

Run this compose as a **Komodo stack** named `intentic-platform` and every main push redeploys itself:
`images:platform` ends with [deploy-platform.sh](../../scripts/deploy-platform.sh), which calls Komodo's
`DeployStack` — the stack's services run `:latest` with `pull_policy: always`, so the redeploy pulls what CI
just pushed. The stack name is set in the job's rules (`PLATFORM_DEPLOY_STACK`) and the Komodo core origin
defaults to `https://komodo.radarsu.com`, leaving one thing to configure — the api key, as masked GitLab
CI/CD variables:

| Variable | Value |
| --- | --- |
| `KOMODO_API_KEY` / `KOMODO_API_SECRET` | an api key minted in Komodo (mask both) |

Optional overrides: `KOMODO_URL` (a different core origin, e.g. `http://192.168.0.x:9120`) and
`PLATFORM_DEPLOY_STACK` (a different stack name — unsetting it in the rules disables the deploy).
