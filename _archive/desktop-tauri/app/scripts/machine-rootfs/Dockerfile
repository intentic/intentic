# The WSL2 distro the Windows desktop app imports as `intentic-machine` — the Docker-Desktop-free
# engine for local sandboxes. Built in CI, `docker export`ed to a rootfs tarball, and attached to
# each release as desktop/intentic-machine-amd64.tar.gz (downloaded by the app with progress, then
# `wsl --import`ed). Alpine + dockerd is all it is; the app starts dockerd on demand through
# intentic-machine-boot and talks to it via `wsl -d intentic-machine -u root --exec docker …`.
FROM alpine:3.22

RUN apk add --no-cache docker docker-cli-compose ca-certificates iptables ip6tables e2fsprogs curl

COPY intentic-machine-boot /usr/local/bin/intentic-machine-boot
RUN chmod +x /usr/local/bin/intentic-machine-boot
