# syntax=docker/dockerfile:1
# netd for the sandbox image, compiled on the image's own Debian release so it links against the glibc the image
# carries whatever machine builds it; exported as one file (build-netd.sh, `--output type=local`). The context is the
# netd's own directory, and build-netd.sh passes `relay` (_shared/relay) beside it, laid out as in the repository.
FROM rust:1.98.1-slim-trixie@sha256:f47a8de237dcbb0b0ce1099901e60a89728e3d51f24e664b40e947171538ade7 AS build
COPY --from=relay . /src/_shared/relay
WORKDIR /src/_sandbox/netd
COPY . .
# Cache mounts keep the registry and the incremental build across runs on the same builder.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/_sandbox/netd/target \
    cargo build --release --locked --bin intentic-netd \
    && cp target/release/intentic-netd /intentic-netd

FROM scratch
COPY --from=build /intentic-netd /intentic-netd
