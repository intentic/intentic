# syntax=docker/dockerfile:1
# The intentic ingress image (ghcr.io/intentic/ingress): the edge every sandbox is reached through, a Rust binary
# compiled here in a BuildKit stage on the Debian release it then runs on, so it links the glibc it carries and no
# job needs a toolchain. docker-release.sh passes the three sibling trees it compiles from as named contexts: `tunnel`
# (_sandbox/front/crates/tunnel, the wire both ends of a tunnel speak), `browser-wire`
# (_sandbox/front/crates/browser-wire, what a browser sees of the edge: the verdict header, the WebTransport path) and
# `contract` (_shared/sandbox-contract/src/protocol, whose lane table the binary embeds), so the context stays this
# directory.
#
# THERE IS NO BOOT CHAIN HERE: no migrations to apply, no schema to prove, no database to reach. The process holds
# live connections and nothing else, so "started" and "ready" are the same moment, which is also what makes it safe
# to redeploy at any time. A restart closes every tunnel with 1001 and every container redials at once.
#
# Runtime config (src/config.rs) is injected by the deployment, never baked:
#   INGRESS_PUBLIC_KEY      the platform's Ed25519 PUBLIC key (SPKI PEM). Required: the process exits without it.
#   PLATFORM_URL            where to ask whether a sandbox still exists. Unset: that check is off.
#   INGRESS_PORT/HOST       defaults 8080 / 0.0.0.0.
#   INGRESS_INTERNAL_PORT   the cluster's own listener, default 8081, bound to the private address (FLY_PRIVATE_IP
#                           when present, else INGRESS_INTERNAL_HOST, else every interface). Never publish it.
#   INGRESS_PEERS           off Fly only: the other machines, `host[:port[:internalPort]]` comma-separated, with
#                           INGRESS_ADVERTISE_HOST naming this one as they reach it. On Fly both are derived.
#   INGRESS_INSTANCE_ID     this machine's name in logs and on /health; defaults to FLY_MACHINE_ID.
#   HOSTED_APP_PREFIX       hosted sandboxes' Fly app prefix; unset replays nothing.
#   INGRESS_TLS_PORT        where the edge terminates TLS itself; unset leaves TLS to whatever is in front of it. The
#                           certificate is a PEM pair on disk (INGRESS_TLS_CERT_FILE, INGRESS_TLS_KEY_FILE) or the one
#                           the platform issued (INGRESS_PLATFORM_TOKEN with PLATFORM_URL), reloaded in place.
#   INGRESS_PROXY_PROTOCOL  the TLS port sits behind a TCP passthrough that names the browser in a PROXY header.
#   INGRESS_QUIC_PORT       the UDP door, on the same certificate: a front's QUIC tunnel and a browser's HTTP/3 and
#                           WebTransport. Setting it is also what the edge DECLARES (x-intentic-transports on a tunnel's
#                           answer, `transports` on /health): fronts and editors reach for UDP only where it is declared.
#   INGRESS_QUIC_HOST       the address it binds, else INGRESS_HOST; on Fly, `fly-global-services`, the only one UDP
#                           reaches.
#   INGRESS_ALT_SVC         what TCP answers advertise HTTP/3 with, naming the PUBLIC UDP port: h3=":443"; ma=86400.
#   LOG_LEVEL, LOG_PRETTY   a tracing filter (default info) and human lines instead of JSON.
# The ONE value baked rather than injected, because a deployment must not be able to claim a build it is not
# running: BUILD_ID becomes INGRESS_BUILD, which /health reports and deploy-ingress.sh asserts against the tag it just
# pushed. Left at `unreleased` by a hand-run `docker build`.
# The private half of the key NEVER appears here: this image can verify grants and can never mint one, which is the
# whole of why a compromised edge cannot make anything reachable.
FROM rust:1.98.1-slim-trixie@sha256:f47a8de237dcbb0b0ce1099901e60a89728e3d51f24e664b40e947171538ade7 AS build
COPY --from=tunnel . /src/_sandbox/front/crates/tunnel
COPY --from=browser-wire . /src/_sandbox/front/crates/browser-wire
COPY --from=contract tunnel-lanes.json ingress-contract.fixture.json /src/_shared/sandbox-contract/src/protocol/
WORKDIR /src/_platform/ingress
COPY . .
# Cache mounts keep the registry and the incremental build across runs on the same builder.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/_platform/ingress/target \
    cargo build --release --locked --bin intentic-ingress \
    && cp target/release/intentic-ingress /intentic-ingress

FROM debian:trixie-20260918-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
COPY --from=build /intentic-ingress /usr/local/bin/intentic-ingress
# Declared after the FROM it applies to, and defaulted so a hand build needs no argument. docker-release.sh passes the
# content-addressed tag it pushes, so identical content always bakes an identical value.
ARG BUILD_ID=unreleased
ENV INGRESS_HOST=0.0.0.0 INGRESS_PORT=8080 INGRESS_BUILD=$BUILD_ID
EXPOSE 8080
CMD ["intentic-ingress"]
