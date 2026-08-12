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

This host is the public front door: **TCP 443 (Caddy), TCP 1280 (Ziti controller, mTLS) and TCP 3022 (Ziti
router) must be reachable from the internet.** A hub nobody can reach tunnels nothing. If no home machine can
take inbound traffic, put this stack on a small VPS (the Oracle Always-Free tier the setup wizard already
offers is enough) and keep everything else where it is.

## Before first deploy

1. Pick a zone and create the DNS records (DNS-only / grey-cloud, not proxied):
   - `*.ZROK2_DNS_ZONE` (e.g. `*.sbx.example.com`) → A/AAAA → this host — the ONE wildcard that replaces
     every per-sandbox record. It also covers the stack's own names (`zrok2.`, `ziti.`, `router.` under the
     zone), so one record is genuinely all of it.
2. Fill the stack environment: `ZROK2_DNS_ZONE`, `ZROK2_ADMIN_TOKEN` (≥32 chars), `ZITI_PWD`,
   `ZROK2_DB_PASSWORD`, and `CADDY_DNS_PLUGIN_TOKEN` (Cloudflare token, Zone:Read + DNS:Edit on the zone —
   wildcard-cert challenge only).
3. Deploy. First boot bootstraps the Ziti overlay, the zrok controller (`https://zrok2.ZROK2_DNS_ZONE`), the
   wildcard frontend, and compiles Caddy with the DNS plugin (a few minutes, once per volume).
4. Create the first account and check the loop end to end:
   ```sh
   docker compose exec zrok2-controller zrok2 admin create account you@example.com <password>
   # on any machine:  zrok2 enable <token printed above>
   #                  zrok2 share public http://localhost:3000
   ```

## What connects to it

Each sandbox runs the `zrok2` agent — outbound-only, NAT-friendly — enabled with an account token the
platform mints over the controller's admin API. Shares get `name.ZROK2_DNS_ZONE` under the wildcard; v2
names are decoupled from the backing environment, so a recreated sandbox re-attaches the same public name.

## Phase 2 (not in this stack)

Swapping the platform's per-sandbox provisioning from the Cloudflare API to zrok's controller API — a
`zrok.ts` sibling of `_platform/api/src/sandbox/cloudflare.ts` minting an account + names per sandbox, and
the `zrok2` agent riding in the sandbox where cloudflared does today. Until then this stack runs alongside
the Cloudflare path and is the infrastructure the swap lands on.
