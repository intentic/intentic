# The "one SSH + Docker host" the deployment declaration assumes, for local end-to-end testing.
# Docker-in-Docker gives an isolated daemon so the providers' nested containers (Forgejo, the CI runner,
# the Komodo compose stack, the cloudflared connector) run exactly as they would on a real owned box,
# without polluting the developer's Docker daemon. sshd is added so the engine reaches it over SSH like
# real infra. The harness injects the authorized public key via testcontainers before start.
FROM docker:29.8.1-dind@sha256:3f3c01aaaebf7cce837356b688b7c059a4749f10bd7660dec7c58fc454a283f0

# Links the GHCR package to this repository — without it a private package is unpullable by the repository's
# own GITHUB_TOKEN, and every job that runs this image fails before its first step.
LABEL org.opencontainers.image.source=https://github.com/intentic/intentic

# openssh: the SSH transport. openssl/iproute2: required by the host (`ip route`) and komodo (`openssl
# rand`) providers. docker-cli-compose: the komodo provider runs `docker compose up -d`.
RUN apk add --no-cache openssh openssh-server openssl iproute2 docker-cli-compose \
    && ssh-keygen -A \
    && mkdir -p /root/.ssh /run/sshd \
    && chmod 700 /root/.ssh \
    && printf 'PermitRootLogin prohibit-password\nPubkeyAuthentication yes\n' >> /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/intentic-host-entrypoint.sh
RUN chmod +x /usr/local/bin/intentic-host-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/intentic-host-entrypoint.sh"]
