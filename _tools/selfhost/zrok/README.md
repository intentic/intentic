# Self-hosted tunnel ingress (zrok v2)

The stack that takes tunneling in-house: [zrok](https://github.com/openziti/zrok) v2 (Apache-2.0, on the
OpenZiti zero-trust overlay) as the front door every sandbox connects out to, in place of per-sandbox
Cloudflare tunnels. One compose file, deployable from Komodo's inline stack config — adapted from the
official self-host bundle (`docker/compose/zrok2-instance` at tag v2.0.4): the two bootstrap scripts the
bundle bind-mounts are fetched at the same pinned tag into a volume, and the optional Caddy TLS overlay is
folded in with its Caddyfile written inline.

## Why this exists

Every sandbox on the Cloudflare path costs the zone ~10 DNS records (workspace + ssh + eight preview slots),
and a zone has a hard record quota — Cloudflare error 81045 is a full zone refusing every new setup. The
daily reaper and pruner (platform `retention.ts`) manage that pressure; this stack removes it. Under zrok,
**one wildcard DNS record and one wildcard certificate serve every sandbox hostname** — the dynamic frontend
routes by name, so a new sandbox costs zero DNS writes. Traffic terminates on hardware we run; and because
shares ride the OpenZiti overlay, they are end-to-end encrypted even from this hub. Cloudflare keeps exactly
one job (the DNS-01 challenge Caddy uses to mint the wildcard certificate).

zrok v2 was chosen once its 2.0 line stabilized (v2.0.4, four patch releases in): its v2 names/namespaces
model decouples a share's public name from the machine backing it — exactly the shape of "a sandbox's address
survives its machine being recreated" — and the whole stack is Apache-2.0. Versions pinned in the compose
were the latest releases when this was written (zrok2 2.0.4, ziti 2.0.2); bump the `*_TAG` env vars
deliberately, never ride `:latest`.

## The one requirement Cloudflare never had

This host is the public front door: **the Caddy port (443 by default), TCP 1280 (Ziti controller, mTLS) and
TCP 3022 (Ziti router) must be reachable from the internet.** A hub nobody can reach tunnels nothing. If no
home machine can take inbound traffic, put this stack on a small VPS (the Oracle Always-Free tier the setup
wizard already offers is enough) and keep everything else where it is.

`CADDY_HTTPS_PORT` exists because a host may already have a front door: on radarsu-server 80/443 are held by
a resident Traefik outside Komodo, so Caddy binds 8443 there and either the router forwards 443→8443 or that
Traefik SNI-passes `*.ZROK2_DNS_ZONE` through. The certificate needs no inbound at all (DNS-01), so TLS is
already working there while the public path is still being decided.

## Before first deploy

1. Pick a zone and create the DNS records (DNS-only / grey-cloud, not proxied):
   - `*.ZROK2_DNS_ZONE` (e.g. `*.sbx.example.com`) → A/AAAA → this host — the ONE wildcard that replaces
     every per-sandbox record. It also covers the stack's own names (`zrok2.`, `ziti.`, `router.` under the
     zone), so one record is genuinely all of it.
2. Fill the stack environment: `ZROK2_DNS_ZONE`, `ZROK2_ADMIN_TOKEN` (≥32 chars), `ZITI_PWD`,
   `ZROK2_DB_PASSWORD`, and `CADDY_DNS_PLUGIN_TOKEN` (Cloudflare token, Zone:Read + DNS:Edit on the zone —
   wildcard-cert challenge only).
3. Deploy. First boot bootstraps the Ziti overlay, the zrok controller (`https://zrok2.ZROK2_DNS_ZONE`), the
   wildcard frontend, and obtains the wildcard certificate. The deploy log carries the host's public egress IP
   (`fetch-bootstrap`), which is the address the wildcard record needs when the host is behind NAT.
4. Create the first account — the profile-gated one-shot, run once:
   ```sh
   ZROK2_ACCOUNT_EMAIL=you@example.com ZROK2_ACCOUNT_PASSWORD=… \
     docker compose --profile bootstrap up zrok2-account   # prints the enable token
   # on any machine:  zrok2 enable <token>
   #                  zrok2 share public http://localhost:3000
   ```
   (From Komodo: set the two `ZROK2_ACCOUNT_*` values in the stack environment and deploy the `zrok2-account`
   service alone.)

## What connects to it

Each sandbox runs the `zrok2` agent — outbound-only, NAT-friendly — enabled with an account token the
platform mints over the controller's admin API. Shares get `name.ZROK2_DNS_ZONE` under the wildcard; v2
names are decoupled from the backing environment, so a recreated sandbox re-attaches the same public name.

## Why Cloudflare is still here (and what actually leaves)

Going "fully zrok" is two separate moves, and only one of them is done:

- **Traffic** — the part worth moving, and what this stack is for. It cannot switch until phase 2 below is
  written AND this hub is publicly reachable; until then every existing sandbox reaches its owner over its
  Cloudflare tunnel, and deleting that would take the product down.
- **DNS + the certificate challenge** — deliberately staying. The zone has to live at *some* registrar/DNS
  host, one wildcard record is not a quota problem, and Caddy's DNS-01 challenge needs an API there. This is
  Cloudflare as a DNS provider, not as a tunnel vendor: no per-sandbox records, no cloudflared, no quota.

So the cleanup that matters happens at cutover: per-sandbox tunnels and their ~10 records each stop being
created, and the existing ones are torn down by the reaper that already exists (`retention.ts`). Nothing to
rip out by hand, and nothing to remove before the replacement carries traffic.

## What the platform does with it (phase 2, landed)

The platform mints ONE zrok account per sandbox (`_platform/api/src/sandbox/zrok.ts` +
`zrok-provision.ts`) and hands it down with the setup code or the hosted machine's env: `ZROK_TOKEN`,
`ZROK_API`, `ZROK_NAMESPACE`. The box's entrypoint enables with it (identity born in the box — the platform
can revoke reachability, never impersonate it) and serves the daemon as a public share whose name is the
`sandbox-<id>` label the browser already knows. Deleting a sandbox deletes its account; the daily sweep
reconciles accounts against rows.

Configure the platform with `ZROK_API_ENDPOINT`, `ZROK_ADMIN_TOKEN` (this stack's `ZROK2_ADMIN_TOKEN`),
`ZROK_ZONE`, and — when sandboxes reach the hub at a different address than the platform does —
`ZROK_AGENT_ENDPOINT`.

### Still owed

The preview/panel names (forwarded ports, the public outbox) are not attached yet: the platform's old
Cloudflare relays are gone, and the daemon does not yet create its own names with its account token. Desktop
sync, the sandbox's `ssh-<id>` name and connected-computer tunnels are SSH-shaped and stay on their old path
until they become private `tcpTunnel` shares. And the connect scripts (`connect.sh`, `ic`) still start the
old cloudflared sidecar for the docker lane — the hosted lane and the image are already zrok-only.
