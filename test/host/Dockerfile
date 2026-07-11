# The "one SSH + Docker host" the deployment declaration assumes, for local end-to-end testing.
# Docker-in-Docker gives an isolated daemon so the providers' nested containers (Forgejo, the CI runner,
# the Komodo compose stack, the cloudflared connector) run exactly as they would on a real owned box,
# without polluting the developer's Docker daemon. sshd is added so the engine reaches it over SSH like
# real infra. The harness injects the authorized public key via testcontainers before start.
FROM docker:28.5.2-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac

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
