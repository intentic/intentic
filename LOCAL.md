# Run the intentic deployment engine on your own PC (no server)

> The [intentic deployment engine](docs/deploy-engine.md) is a bundled tool, not the intentic product.

The deployment engine normally deploys to a remote server. But because each host's Cloudflare Tunnel connects **outbound** (the host opens no inbound ports — see [docs/deploy-engine.md](docs/deploy-engine.md)), the "server" can just as well be **your own laptop or desktop, behind NAT, not exposed to the internet**. Your apps stay reachable through your Cloudflare account exactly as they would from a VPS.

[_tools/scripts/intentic-local.sh](_tools/scripts/intentic-local.sh) bootstraps this in one shot.

## How it works

The script starts a **Docker-in-Docker + sshd container** on your PC and points intentic at it over SSH on `127.0.0.1:2222`. From intentic's view that container is an ordinary server:

```ts
i.have.host("host", { address: "127.0.0.1", user: "root", sshKey: env("HOST_SSH_KEY"), port: 2222 });
```

`intentic deploy apply` then deploys the whole stack — Forgejo, Komodo, the AI-agent workspace, and `cloudflared` — *inside* that host. `cloudflared` dials outbound to Cloudflare's edge, so your apps are public with **no inbound exposure on your machine**. The nested Docker daemon isolates intentic's containers from your own Docker and gives clean teardown. This is the same DinD-over-SSH path intentic's end-to-end test harness exercises — nothing about the deploy is local-only.

## Prerequisites

- **Docker** (able to run a `--privileged` container — required for Docker-in-Docker)
- **Node 24+** and an **OpenSSH client** (`ssh`, `ssh-keygen`)
- **Outbound internet** (to pull images, reach Cloudflare and the Anthropic API)
- A **Cloudflare account** + a **domain (zone) you own**, and an API token with:
  - Account → Cloudflare Tunnel → Edit
  - Zone → DNS → Edit
  - Zone → Zone → Read
- Runs on **Linux or WSL2** with a Linux Docker engine. On Docker Desktop (macOS/Windows), run the engine inside WSL — `--privileged` Docker-in-Docker and `--network host` don't behave the same on the Desktop VM.

## Quick start

```sh
export CLOUDFLARE_API_TOKEN=...     # token with the scopes above
export INTENTIC_ZONE=example.com    # a domain you own in that account

./_tools/scripts/intentic-local.sh up
```

(Omit the env vars and the script prompts for them.) It will:

1. Build the DinD+sshd host image and start it (`--privileged`, SSH on `2222`, Forgejo/Komodo also published to `localhost` for instant browsing). A named Docker volume persists the nested stack across restarts.
2. Generate an SSH keypair and authorize it on the host.
3. Scaffold an intent (`intentic deploy init`) with the localhost host + your Cloudflare account + the AI-agent workspace + a sample app.
4. Run `intentic deploy resolve` + `intentic deploy apply` until it converges.
5. Print your URLs and the intentic-generated admin logins.

When it finishes you get:

- **Public (through the tunnel):** `https://git.<zone>`, `https://deploy.<zone>`, `https://app.<zone>`, and per-sandbox previews at `https://preview-<name>.<zone>`
- **Local (instant, no DNS):** `http://127.0.0.1:3000` (Forgejo), `http://127.0.0.1:9120` (Komodo)

## Lifecycle

```sh
./_tools/scripts/intentic-local.sh up      # build + deploy (default)
./_tools/scripts/intentic-local.sh down    # stop the host; tunnel, DNS, and data volume are kept (fast re-up)
./_tools/scripts/intentic-local.sh clear   # also drop the host's data volume (full local teardown)
```

Edit `intentic-local/intent/deploy.config.ts` and re-run `up` to reconcile changes. `clear` leaves the Cloudflare tunnel (`intentic-host`) and DNS records in your account — remove them from the Cloudflare dashboard if you want them gone.

## Extending to full parity

The scaffolded config is intentionally minimal (the workspace + one app). The generated file includes commented lines to add observability (SignOz), a database (Postgres), a cache (Valkey), SSO (Authentik), and object storage (Garage) — uncomment them and re-run `up`. See [_tools/examples/deploy.config.ts](_tools/examples/deploy.config.ts) for the full surface.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | *(prompted)* | Cloudflare API token (scopes above) |
| `INTENTIC_ZONE` | *(prompted)* | A domain you own in that account |
| `INTENTIC_DIR` | `./intentic-local` | Where the `intent/` + `desired-state/` repos are scaffolded |
| `SSH_PORT` / `FORGEJO_PORT` / `KOMODO_PORT` | `2222` / `3000` / `9120` | Ports published to `localhost` |
| `INTENTIC_CMD` | `npx --yes @intentic/cli@latest` | How the CLI is invoked |
| `INTENTIC_LINK` | *(unset)* | Set to `1` to `init --link` against this monorepo's local `_libs` (development) |

> **Developing in this repo?** Run it against your local build instead of npm:
> ```sh
> pnpm build
> INTENTIC_CMD="pnpm intentic" INTENTIC_LINK=1 ./_tools/scripts/intentic-local.sh up
> ```

## Security note

The host runs as a **privileged** container (a hard requirement for Docker-in-Docker). intentic's entire stack lives inside that nested daemon, isolated from the Docker you use day to day. SSH is loopback-only (`127.0.0.1:2222`) with key auth, and the only public surface is whatever your Cloudflare tunnel routes — your machine opens no inbound ports.
