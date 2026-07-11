#!/bin/sh
# Bring up the Docker daemon and sshd together: the engine SSHes in, then drives `docker` over that
# session exactly as it would against a real host.
set -e

# The dind image's own entrypoint configures cgroups/iptables then execs dockerd; run it in the
# background. DOCKER_TLS_CERTDIR="" (set by the harness) makes it listen on the local socket without TLS.
dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &

# Block until the daemon accepts commands so the first provider `docker` call doesn't race startup.
i=0
while [ "$i" -lt 60 ]; do
    if docker info >/dev/null 2>&1; then
        break
    fi
    i=$((i + 1))
    sleep 1
done

# authorized_keys was copied in before start by the harness; sshd requires it to be non-group/world-writable.
if [ -f /root/.ssh/authorized_keys ]; then
    chmod 600 /root/.ssh/authorized_keys
fi

exec /usr/sbin/sshd -D -e
