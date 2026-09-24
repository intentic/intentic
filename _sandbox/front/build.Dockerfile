# syntax=docker/dockerfile:1
# The front for the sandbox image, compiled on the image's own Debian release so it links against the glibc the image
# carries whatever machine builds it; exported as one file (build-front.sh, `--output type=local`).
FROM rust:1.98.1-slim-trixie@sha256:f47a8de237dcbb0b0ce1099901e60a89728e3d51f24e664b40e947171538ade7 AS build
WORKDIR /src
COPY . .
# Cache mounts keep the registry and the incremental build across runs on the same builder.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin intentic-front \
    && cp target/release/intentic-front /intentic-front

FROM scratch
COPY --from=build /intentic-front /intentic-front
