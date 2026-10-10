# intentic-engine rootfs

Small WSL2 distro (`intentic-engine`) that runs the open-source Docker engine for Intentic sandboxes on Windows PCs. A
fresh PC gets it as its engine; a PC with Docker Desktop gets it when its owner moves the sandboxes over
(`ic engine move --to intentic`).

## What it contains

- Alpine minirootfs (pinned in `pins.toml`)
- Static `dockerd`, `containerd`, `runc`, and helpers from Docker's static Linux bundle
- `iptables`, `ip6tables`, `openssl`, `ca-certificates`, `passt` (pasta) and `socat` from Alpine
- `/usr/local/bin/intentic-engine` — foreground keeper started by `ic engine start`
- `/etc/wsl.conf` — no Windows PATH append; automount stays on, at `/mnt/`, which is where `ic` and the desktop app
  point a bind mount of a Windows folder (`docker-host/src/wsl_path.rs`)

`ic` writes [rootfs/intentic-engine](rootfs/intentic-engine) into the distro before every start, and
[rootfs/teardown](rootfs/teardown) before a removal, so a change to either ships with `ic` and reaches every installed
engine without a new rootfs.

## Its own network

Every WSL distro on a PC runs in one VM and, by default, one network namespace: a `dockerd` there puts its bridge, its
routes and its iptables chains into every distro's network (seen from the CI fleet's distro on omen, 2026-10-09), and a
person's own dockerd in another distro flushes them. Docker Desktop keeps its engine in a namespace of its own, and since
2026-10-10 (rootfs 1.1.0) so does this one. The keeper runs `dockerd` in the network namespace `intentic`
(`/run/netns/intentic`) and:

- gives it the PC's network from user space with pasta (passt): ordinary sockets of this distro, so nothing is routed or
  NATed in the shared namespace and no firewall rule there is touched;
- forwards every TCP port listening inside the namespace (the engine's API, each port a sandbox publishes) from the same
  port on this distro's `127.0.0.1`, which WSL hands to Windows' own `127.0.0.1`, rescanning every second. Loopback
  only: pasta's own forwarding binds every address, and under mirrored networking that is the LAN;
- maps `169.254.231.1` to this distro's loopback and starts dockerd with `--host-gateway-ip` set to it, so
  `host.docker.internal` reaches the host as on Docker Desktop;
- keeps the bridge on `192.168.239.1/24` and the networks it makes on `192.168.240.0/20`, since pasta copies the PC's
  routes into the namespace and Docker's own `172.17.0.0/16` is the range VPNs and office networks most often route;
- on its first start in a distro that ran an older engine, clears what that one left in the shared namespace (its
  loopback rule, its bridges, Docker's chains when `docker0` was ours).

Only one keeper runs per distro (`flock` on `/run/intentic-engine/keeper.lock`): a second ends at once with exit 4, and
`ic engine start` waits for the first. One that finds a killed keeper's helpers or dockerd still running stops them first.

A PC where the namespace cannot be set up (no `/dev/net/tun`, no pasta or socat and no network to fetch them on an
engine imported from 1.0.0) runs `dockerd` in the shared namespace as before 1.1.0 rather than not at all. There the
keeper leaves Windows' connections to `127.0.0.1` to `docker-proxy` (mirrored networking otherwise loses them), and does
not start beside another Docker engine in WSL that owns `docker0`: two daemons there flush each other's iptables chains,
and `ic engine start` says which address it found and what to do. The mode in use is in
`/run/intentic-engine/network` and in `ic engine status` (`network`: `isolated` or `shared`); setting
`INTENTIC_ENGINE_NETWORK=shared` for the keeper forces the fallback (from Windows: that variable and
`WSLENV=INTENTIC_ENGINE_NETWORK/u` in the environment of `ic engine restart`). Logs: `/var/log/intentic-engine.log` (keeper and
dockerd), `/var/log/intentic-pasta.log`, `/var/log/intentic-forwards.log`.

Measured on omen, 2026-10-10 (mirrored networking; the namespace against the shared network on the same machine within
the hour, and against Docker Desktop):

| | Intentic's engine, own namespace | shared network | Docker Desktop |
| --- | --- | --- | --- |
| 1 GiB download from a published port | 540–570 MB/s | | 510–540 MB/s |
| 1 GiB `docker cp` into a container | 60–74 MB/s | 69–85 MB/s | |
| 1 GiB piped into `docker run -i` (how a move writes a volume) | 71–73 MB/s | 79–80 MB/s | |
| 1 GiB `docker cp` out of a container, over TCP | 36–39 MB/s | 40–42 MB/s | 140–143 MB/s |
| drop copy's mounted route, 2000 files of 8 KiB / one of 1 GiB, warm | 3.2 s / 16.4 s | | 3.1 s / 17.0 s |

WSL's own loopback relay carries uploads from Windows at about 90 MB/s with or without the forward. `docker cp` out
trailed Docker Desktop in either network over TCP; the docker CLI's reading of TCP was the cause, and the engine's named
pipe ([below](#its-named-pipe)) takes it past Docker Desktop. A sandbox moved from
Docker Desktop answered `/health` from Windows, reached the internet, and ran Docker in Docker. Two starts at once ended
with one keeper and both `ic engine start`s answered in 3.6 s; a start after the keeper was killed stopped the dockerd
and pasta it left and answered in 7.7 s; the desktop app's keeper brought a killed engine back in 34 s.

## Its named pipe

`docker cp` out of our engine ran at 36–40 MB/s, a quarter of Docker Desktop. Measured on omen, 2026-10-10, the
engine was not the cause: dockerd hands out the archive at ~356 MB/s inside the distro, and curl.exe and .NET pulled it
from Windows over the same TCP forward at 290–313 MB/s. docker.exe was: any version of it, Docker's signed build
included, read the TCP endpoint at 36–40 MB/s, and read Docker Desktop at 38 MB/s too once Docker Desktop was put
behind a TCP proxy on Windows' own loopback. Over a named pipe, the same docker.exe read our engine at 284–286 MB/s.
Docker Desktop's CLI talks to a named pipe; ours talked TCP. (omen runs FortiClient's network filter, which may make
TCP worse there than elsewhere; the pipe is the way Docker Desktop goes on every PC, so ours goes it too.)

So `ic engine start` keeps a relay running (`ic engine relay`, [src/engine/relay.rs](../src/engine/relay.rs)): it
serves the engine on `\\.\pipe\<distro>.<user>` and carries each connection to the TLS endpoint with the account's
client certificate. The pipe lets in only this account and SYSTEM and refuses remote clients; it is message mode, as
Docker's own pipes are, so a client's end of stdin reaches the engine. The relay runs from a copy of ic named by its hash
(`~/.intentic/engine/relay/`), so the ic the machine agent updates is never locked, and a newer ic's start hands the
pipe over to its own copy. `engine.json` names the pipe (`pipe`); ic, the desktop app and the machine agent use it while
it is there and the TLS endpoint otherwise (`intentic_docker_host::engine_pipe`), so a relay that is not running costs
speed, not commands. `ic engine stop`, `hold` and `remove` end it; `ic engine status` shows it (`pipe`).

Measured on omen the same evening, runs interleaved on a laptop busy with other work (1 GiB each):

| | Through the pipe | TCP + TLS | Docker Desktop |
| --- | --- | --- | --- |
| `docker cp` out of a container | 141–163 MB/s | 31–34 MB/s | 53–106 MB/s |
| piped into `docker run -i` | 36–53 MB/s | 38–39 MB/s | 13–26 MB/s |

`ic engine remove` runs the teardown first: what an engine in the shared namespace left there. The namespace itself,
pasta and the forwards end with the distro.

## Build

```sh
bash _sandbox/ic/engine/build.sh _sandbox/ic/dist-bin
# or
bash _tools/scripts/build/build-intentic-engine.sh
```

Output: `intentic-engine-<version>-x86_64.tar.gz` and a `.sha256` sidecar beside it (about 53 MB). The release attaches
both to the GitHub release next to the `ic` binaries; CI's and the nightly's Windows build put it into the artifact the
Windows smoke's tier 4 runs.

## Update policy

`ic engine update` replaces only the static Linux docker binaries inside an existing distro so `/var/lib/docker` in the
distro VHDX is kept; the keeper itself is refreshed by every start. When `engine_version` in `pins.toml` changes, the
build produces a new rootfs tarball; installs use `wsl --import` (first setup) or a documented remove/reinstall if the
rootfs layout must change.
