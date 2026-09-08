# The turbo remote cache

A turbo remote cache on the fleet host, so a task already run on the same inputs anywhere that can reach it is a
replay rather than a second run.

## Responsibilities

- Serve turbo's remote cache API from one container on the runner host, with local disk under `/ci-cache`.
- Let readers outside the runners' bind mount (a sandbox, a second runner host) replay what CI built.
- Keep the trust direction one way: CI writes, everything else reads.

## Key files

- [docker-compose.yml](docker-compose.yml): the server, its token, its disk.

## How it fits

The six runner processes already share `/ci-cache/turbo` through a bind mount, so among themselves nothing is gained.
What was not shared is the same work run in the sandbox: `pnpm verify` after a land compiles and tests the tree the
verify groups will compile and test again minutes later, on inputs turbo hashes identically. With this server up and
the sandbox reading from it, those groups replay.

Bring it up on the runner host:

```sh
TURBO_TOKEN="$(openssl rand -hex 24)" docker compose -f _tools/turbo-cache/docker-compose.yml up -d
```

Then, in the repository's settings, the variables `TURBO_API` (`http://127.0.0.1:3000` from a job container on the
same host, or the host's address) and `TURBO_TEAM` (any word, `intentic`), and the secret `TURBO_TOKEN`. `ci.yml`,
`verify.yml` and `release.yml` hand all three to every job; unset, turbo reads them as absent and uses the bind
mount alone.

A sandbox reads but never writes: `TURBO_API`, `TURBO_TEAM`, `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_READ_ONLY=1` in
the shell that runs `pnpm verify`. The direction matters. An artifact written by an agent's turn and replayed by
the release job is the poisoned cache `ci.yml` refuses at the fork boundary, so the sandbox side is read-only by
rule, and the token it holds is the same one CI writes with only because turbo has one token, not two.

Pruning is the runners' `find -mtime +14 -delete` pass in `.github/actions/pnpm-setup`, pointed at
`/ci-cache/turbo-remote` as well when the disk asks for it.
