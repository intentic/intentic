# ingress

The edge every sandbox hostname points at: it carries browser traffic down tunnels that sandboxes dial, over TCP or QUIC, and hands hosted sandboxes to their Fly app by replay.

```mermaid
flowchart LR
    browser["Browser<br/>sandbox-id.sbx.intentic.dev"] --> ingress(["ingress"])
    front["A sandbox's front"] -- "wss /tunnel/v1 per lane · QUIC<br/>signed grant" --> ingress
    ingress -- "request down the tunnel" --> front
    ingress -- "does it still exist?" --> api["api"]
    ingress -- "fly-replay" --> hosted["Hosted sandbox<br/>Fly app"]
    ingress -- "local miss" --> peer["Peer ingress machine"]
```

- A Rust crate that builds the same [tunnel](../../_sandbox/front/crates/tunnel) crate as the sandbox's front, so both
  ends of a tunnel are one implementation of the wire.
- No database and nothing durable: the tunnel registry is an in-memory map, so a restart drops every tunnel and each
  front redials. The newest tunnel for an id displaces the older one.
- Holds only the platform's Ed25519 public key, so it verifies grants and can never mint one. Revocation is a
  cached, fail-open `GET /api/reachability/<id>` to the api, at registration and on a miss.
- Routes on each request's Host, since HTTP/2 coalesces many hostnames onto one connection. A sandbox with no tunnel
  answers 502 with an `x-intentic-edge` header naming why (`edge-verdict.ts` in the contract), which the editor reads.
- What the edge serves beyond HTTPS over TCP is declared, never probed for: binding the QUIC door
  (`INGRESS_QUIC_PORT`) is what makes it answer every tunnel's upgrade with `x-intentic-transports: quic, h3,
  webtransport` and list the same under `transports` on `/health`. Undeclared means not served, which is what every
  older edge says.
- A front dials two WebSocket lanes, and a QUIC connection beside them once the edge's answer to a lane declares
  `quic`. The lane a request rides comes from the daemon's routes (`tunnel-lanes.json`), so a transfer never queues a
  keystroke; QUIC is preferred while held, each request a stream of its own.
- With the certificate held here (below), browsers get HTTP/3 on the same port, and the editor's terminals ride
  WebTransport where the platform relays the edge's declaration on the sandbox's row: a session opened at
  `/system/transport` on a sandbox's address, each stream served as one HTTP/1.1 connection to that address whatever
  Host it writes. The editor speaks a plain WebSocket on the stream, so any front or daemon serving `/system/terminal`
  serves it.
- Machines behind the one address find each other through Fly's internal DNS and forward a miss once to whichever
  holds the tunnel, over private port 8081.
- A hosted sandbox gets `fly-replay: app=<prefix>-<id>`, which Fly's proxy caches per hostname.

## Key files

- [src/edge.rs](src/edge.rs) — the tunnel door, the grant check, per-request Host routing, replays and verdicts.
- [src/session.rs](src/session.rs) — one held tunnel: a request per stream, an upgrade as a CONNECT.
- [src/cluster.rs](src/cluster.rs) — which peer holds which tunnel, the holds protocol and the one-hop rule.
- [src/quic.rs](src/quic.rs) — the UDP door: a front's QUIC tunnel or a browser's HTTP/3, told apart by ALPN.
- [src/webtransport.rs](src/webtransport.rs) — a browser's session and its streams, pinned to the session's sandbox.
- [src/config.rs](src/config.rs) — every setting and its env var.

## Commands

```sh
cargo test                                        # every suite, over real sockets
pnpm --filter @intentic/ingress docker:release    # the image, the tunnel crate and lane table passed as build contexts
```

## Deploying

The edge runs on Fly as `intentic-ingress`, apart from the Komodo stack that holds the api and web. On a push to
main, CI's `images-platform` job pushes `ghcr.io/intentic/ingress` and runs
[deploy-ingress.sh](../../_tools/scripts/platform/deploy-ingress.sh), which runs `flyctl deploy` with
[fly.toml](fly.toml) and waits until `/health` reports the build baked into the image. An empty `FLY_API_TOKEN`
skips it. The script deploys another config when named (`INGRESS_FLY_CONFIG`, or its first argument), and for one that
terminates TLS it also requires `/health` to declare `quic`, `h3` and `webtransport`. What the script does not set:

```sh
fly scale count 1 --region <region> -a intentic-ingress    # regions live here, not in fly.toml
fly secrets set -a intentic-ingress INGRESS_PUBLIC_KEY="$(openssl pkey -in ingress-key.pem -pubout)" \
    PLATFORM_URL=<api origin> HOSTED_APP_PREFIX=intentic-sbx
fly orgs cross-network-replays status                      # must be on for hosted sandboxes
```

| Setting | Why |
| --- | --- |
| `INGRESS_PUBLIC_KEY` | Public half of the api's `INGRESS_SIGNING_KEY`; the process exits without it. |
| `PLATFORM_URL` | The api, asked whether a sandbox still exists; unset turns revocation off. |
| `HOSTED_APP_PREFIX` | Must equal the api's; unset, `/health` reports `replay:false` and hosted sandboxes answer 502. |

- Run one machine per region where owners of tunnel-lane sandboxes are. `fly.toml` never auto-stops them, since a
  stopped machine drops every tunnel it holds.
- The app must sit in the same Fly org as the hosted sandbox apps, and the org must allow cross-network replays:
  each hosted app gets its own private network (`createApp` in the api's `src/sandbox/hosted/fly/fly.ts`).
- Never publish `INGRESS_INTERNAL_PORT` (8081): binding only the private address is the peer protocol's one lock.
- Roll the edge before the sandboxes that dial it: an edge older than lanes reads a front's second dial as a newer
  tunnel for the same sandbox, and the two lanes displace each other every minute.


### Terminating TLS at the edge

Holding the certificate here is what lets UDP (the QUIC tunnel, HTTP/3, WebTransport) reach the edge, since Fly's
HTTP handler carries none. The platform orders one wildcard for the fleet (the api's `edge-certificate.ts`) and hands
it to an edge presenting `INGRESS_PLATFORM_TOKEN`. [fly.edge-tls.toml](fly.edge-tls.toml) is the edge's shape once it
does: raw TCP on 443 with PROXY v2 headers, a redirect on 80, UDP 443 to the QUIC door. It is a separate file because
CI deploys `fly.toml` on every push, and `tests/fly_configs.rs` holds the two equal outside their services.

Run the steps in order, in one sitting from step 3 to step 6: between them, a push to main redeploys `fly.toml` with
the staged secrets, which keeps everything reachable over TCP but declares a UDP door nothing routes to. Fronts and
editors then retry QUIC and WebTransport on their normal backoff while the WebSocket lanes carry every request, so it
is safe, only wasteful. The shell below assumes `FLY_API_TOKEN` for the org the edge runs in, and `FLY_ORG` for the
org the hosted apps run in.

**0. Land the declaring edge.** Merge the change that made the edge declare its transports, and let CI roll it. Check:
`curl -fsS https://ingress.sbx.intentic.dev/health` shows `"transports":[]` and the new `build`. Nothing else changes,
because the edge serves no UDP yet and declares none. It restarts the edge machines, as every edge deploy does:
tunnels redial within seconds.

**1. Every hosted machine dials its tunnel.** A hosted machine dials once it runs a sandbox image with intentic-front
(the `ghcr.io/intentic/sandbox:stable` of any build since aa02061469) and its machine config carries `INGRESS_URL`
and `SANDBOX_GRANT`, which `hostedMachineConfig` (the api's `hosted.ts`) writes on every provision, claim, restart,
rebuild and move since 71dbfb7145. A machine configured before that has no grant, and after step 5 it is reachable at
no address. List every machine and whether its config carries the grant:

```sh
for app in $(flyctl apps list --org "$FLY_ORG" --json | jq -r '.[].Name | select(startswith("intentic-sbx-"))'); do
    flyctl machine list -a "$app" --json |
        jq -r --arg app "$app" '.[] | "\($app) \(.id) \(.state) grant=\(.config.env.SANDBOX_GRANT != null) \(.config.image)"'
done
```

Every line must say `grant=true`. For a line that says `grant=false`, have the owner press Restart on that sandbox
(the api's `sandbox.hostedRestart`, which replaces the machine's config), or wait for the next claim, rebuild or move.
A started machine then dials within seconds: `flyctl logs -a <app> --no-tail | grep 'reachable: the ingress tunnel is
registered'` shows it, and the edge logs `tunnel registered` with its 12-hex id (`flyctl logs -a intentic-ingress
--no-tail | grep '"tunnel registered"'`). While the edge sits behind Fly's proxy, a hosted sandbox holding a tunnel is
already served down it; one without is still replayed. Restarting a machine interrupts that one sandbox for a boot. To
roll back, nothing: dialling in is additive.

**2. The certificate is issued.** Make a token and remember it for step 3:

```sh
TOKEN="$(openssl rand -hex 32)"
```

In Cloudflare, zone `intentic.dev`: first write down the value of the `_acme-challenge.sbx.intentic.dev` CNAME (Fly's
DNS-01 delegation for its own `*.sbx.intentic.dev` certificate), then delete that record, since while it exists the
api cannot publish its TXT challenge there. Check: `dig +short CNAME _acme-challenge.sbx.intentic.dev` answers
nothing. Fly's certificate keeps serving until it would renew, about thirty days before it expires, so finish step 5
well inside that.

In Komodo, stack `intentic-platform`: add `INGRESS_PLATFORM_TOKEN=$TOKEN` to its environment (the api also needs
`INTENTIC_CLOUDFLARE_API_TOKEN` and `INTENTIC_CLOUDFLARE_ZONE=intentic.dev`, already set for loopback certificates),
then redeploy it:

```sh
curl -fsS -X POST https://komodo.radarsu.com/execute -H 'Content-Type: application/json' \
    -H "X-Api-Key: $KOMODO_API_KEY" -H "X-Api-Secret: $KOMODO_API_SECRET" \
    -d '{ "type": "DeployStack", "params": { "stack": "intentic-platform" } }'
```

That restarts the api and the web for a few seconds; sandboxes and their tunnels are untouched. Check: the api logs
`edge certificate issued` for `sbx.intentic.dev` within a few minutes, and

```sh
curl -fsS -H "authorization: Bearer $TOKEN" https://api.intentic.dev/api/ingress/certificate |
    jq -r .certificate | openssl x509 -noout -subject -enddate -ext subjectAltName -fingerprint -sha256
```

names `*.sbx.intentic.dev` and `sbx.intentic.dev`; keep the fingerprint for step 5. A 404 `no certificate has been
issued` means the order has not finished or failed (the api logs why and retries every six hours). To roll back,
remove the variable and redeploy; the stored certificate is inert without it. Recreate the CNAME only if you are
abandoning the switch, so that Fly can renew its own.

**3. Stage the edge's secrets**, without a restart:

```sh
flyctl secrets list -a intentic-ingress        # PLATFORM_URL must already be https://api.intentic.dev
flyctl secrets set --stage -a intentic-ingress \
    INGRESS_PLATFORM_TOKEN="$TOKEN" \
    INGRESS_TLS_PORT=8443 INGRESS_PROXY_PROTOCOL=true \
    INGRESS_QUIC_PORT=8443 INGRESS_QUIC_HOST=fly-global-services \
    INGRESS_ALT_SVC='h3=":443"; ma=86400'
```

Check: `flyctl secrets list -a intentic-ingress` lists them, marked staged, and the machines did not restart
(`flyctl status -a intentic-ingress`). To roll back: `flyctl secrets unset --stage -a intentic-ingress
INGRESS_PLATFORM_TOKEN INGRESS_TLS_PORT INGRESS_PROXY_PROTOCOL INGRESS_QUIC_PORT INGRESS_QUIC_HOST INGRESS_ALT_SVC`.

**4. A dedicated IPv4 for UDP**, which Fly delivers to no shared address:

```sh
flyctl ips allocate-v4 -a intentic-ingress
flyctl ips list -a intentic-ingress
```

Check: `dig +short ingress.sbx.intentic.dev` and `dig +short sandbox-000000000000.sbx.intentic.dev` answer the new
v4 (a CNAME to `intentic-ingress.fly.dev` follows on its own; an A record in Cloudflare has to be changed to it). No
restart and no interruption: TCP keeps working on either address. To roll back: `flyctl ips release <v4> -a
intentic-ingress`, after pointing any A record back.

**5. Deploy the TLS shape.** From a checkout of main:

```sh
INGRESS_FLY_CONFIG=_platform/ingress/fly.edge-tls.toml bash _tools/scripts/platform/deploy-ingress.sh
```

This applies the staged secrets and the new services, restarting every edge machine: each tunnel drops with 1001 and
redials within seconds, and an open terminal or event stream reconnects. The script fails unless the new build answers
and `/health` declares `quic`, `h3` and `webtransport`. Then check:

```sh
openssl s_client -connect ingress.sbx.intentic.dev:443 -servername ingress.sbx.intentic.dev </dev/null 2>/dev/null |
    openssl x509 -noout -fingerprint -sha256          # the fingerprint from step 2, not Fly's certificate
curl -sI https://ingress.sbx.intentic.dev/health | grep -i alt-svc      # h3=":443"
curl -sI http://ingress.sbx.intentic.dev/health | head -1               # a redirect to https
flyctl logs -a intentic-ingress --no-tail | grep 'QUIC tunnel registered'
```

Within a minute the api relays the declaration: each sandbox row under `sbx.intentic.dev` in `sandbox.list` carries
`edgeTransports`, and an editor reloaded after that opens terminals on a WebTransport session at `/system/transport`
(DevTools, Network). A hosted sandbox is now reached down its tunnel only, and a stopped one answers the `no-tunnel`
verdict the editor's wake acts on. To roll back: `bash _tools/scripts/platform/deploy-ingress.sh` (fly.toml, Fly's
proxy and certificate again), then `flyctl secrets unset -a intentic-ingress INGRESS_TLS_PORT INGRESS_PROXY_PROTOCOL
INGRESS_QUIC_PORT INGRESS_QUIC_HOST INGRESS_ALT_SVC`, which restarts the machines once more; fronts and editors stop
reaching for UDP as soon as the edge stops declaring it.

**6. Swap the files.** One commit, so that CI deploys this shape from now on:

```sh
git mv _platform/ingress/fly.toml _platform/ingress/fly.edge-proxy.toml
git mv _platform/ingress/fly.edge-tls.toml _platform/ingress/fly.toml
```

Rewrite the two files' header comments to match (the proxy one is now the rollback), and this section's step 5
rollback to name `fly.edge-proxy.toml`. `cargo test --test fly_configs` must pass. CI's deploy is then a TLS one: its
log ends `intentic-ingress declares quic, h3 and webtransport`. The deploy restarts the edge as every push does. To
roll back: revert the commit, then step 5's rollback.

**7. Remove Fly's certificate**, once step 6 has held for a day, since rolling back to Fly's proxy needs it:

```sh
flyctl certs list -a intentic-ingress
flyctl certs remove '*.sbx.intentic.dev' -a intentic-ingress
```

No restart and no interruption: nothing reaches Fly's TLS any more. To roll back: `flyctl certs add
'*.sbx.intentic.dev' -a intentic-ingress`, and recreate the `_acme-challenge` CNAME it prints.

From then on a hosted sandbox is reached down the tunnel it dials like every other. The replay lane (`HOSTED_APP_PREFIX`
here, the front door `hostedMachineConfig` still gives every hosted machine) serves nothing and can go.
