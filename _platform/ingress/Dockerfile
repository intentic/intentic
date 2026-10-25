# syntax=docker/dockerfile:1
# Rust ingress built against its runtime Debian; named tunnel/browser-wire/relay contexts keep the build context local.
# Inject config via src/config.rs; never publish the internal listener or include private signing keys. Only BUILD_ID is baked.
# Fly QUIC needs public UDP 443 on fly-global-services; advertise enabled transports. Restarts drop in-memory tunnels until redial.
FROM rust:1.98.1-slim-trixie@sha256:f47a8de237dcbb0b0ce1099901e60a89728e3d51f24e664b40e947171538ade7 AS build
COPY --from=tunnel . /src/_sandbox/netd/crates/tunnel
COPY --from=browser-wire . /src/_sandbox/netd/crates/browser-wire
COPY --from=relay . /src/_shared/relay
WORKDIR /src/_platform/ingress
COPY . .
# Cache mounts keep the registry and the incremental build across runs on the same builder.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/_platform/ingress/target \
    cargo build --release --locked --bin intentic-ingress \
    && cp target/release/intentic-ingress /intentic-ingress

# Distroless rather than debian-slim, because the binary needs glibc and libgcc_s (it unwinds on panic) and nothing
# else: its TLS roots are compiled in (webpki-roots), it starts no other program, and it writes no file. `cc` is the
# variant that carries libgcc_s, and debian13 is the trixie the build stage links against. The root variant on
# purpose: on Fly the QUIC door binds UDP 443, a privileged port. There is no shell, so `fly ssh console` has nothing to
# open; Fly's checks are TCP (fly.toml) or an HTTP GET (fly.edge-proxy.toml), and neither runs anything in here.
FROM gcr.io/distroless/cc-debian13:latest@sha256:159783207c2cd44c2aa5715961d13c8612368ac9bd450f887e3f08fc8ea461e3
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic
COPY --from=build /intentic-ingress /usr/local/bin/intentic-ingress
# Declared after the FROM it applies to, and defaulted so a hand build needs no argument. docker-release.sh passes the
# content-addressed tag it pushes, so identical content always bakes an identical value.
ARG BUILD_ID=unreleased
ENV INGRESS_HOST=0.0.0.0 INGRESS_PORT=8080 INGRESS_BUILD=$BUILD_ID
EXPOSE 8080
CMD ["intentic-ingress"]
