# intentic-engine rootfs

Small WSL2 distro (`intentic-engine`) that runs the open-source Docker engine for Intentic sandboxes on Windows PCs. A
fresh PC gets it as its engine; a PC with Docker Desktop gets it when its owner moves the sandboxes over
(`ic engine move --to intentic`).

## What it contains

- Alpine minirootfs (pinned in `pins.toml`)
- Static `dockerd`, `containerd`, `runc`, and helpers from Docker's static Linux bundle
- `iptables`, `ip6tables`, `openssl`, `ca-certificates` from Alpine
- `/usr/local/bin/intentic-engine` — foreground keeper started by `ic engine start`
- `/etc/wsl.conf` — no Windows PATH append; automount stays on, at `/mnt/`, which is where `ic` and the desktop app
  point a bind mount of a Windows folder (`docker-host/src/wsl_path.rs`)

`ic` writes [rootfs/intentic-engine](rootfs/intentic-engine) into the distro before every start, and
[rootfs/teardown](rootfs/teardown) before a removal, so a change to either ships with `ic` and reaches every installed
engine without a new rootfs.

## The network it shares

Every WSL distro on a PC runs in one VM with one network namespace, and this distro's `dockerd` works in it (Docker
Desktop keeps its engine in a namespace of its own). Verified on omen, 2026-10-09: the bridge and the container
interfaces were visible from the CI fleet's distro. So the keeper:

- leaves connections to `127.0.0.1` to `docker-proxy`: under mirrored networking they arrive on an interface, Docker's
  DNAT for a port published on `127.0.0.1` sends them to the container, and the reply is lost (a sandbox's local
  address timed out from Windows until this rule);
- gives the bridge `192.168.239.1/24` and the networks it makes `192.168.240.0/20`, since Docker's own `172.17.0.0/16`
  is the range VPNs and office networks most often route, and a bridge on it would shadow those routes in every distro;
- does not start when another Docker engine in WSL owns `docker0` (Docker Engine in a person's own Ubuntu, Rancher
  Desktop): two daemons there flush each other's iptables chains. `ic engine start` then says which address it found
  and what to do.

`ic engine remove` runs the teardown first: the loopback rule, Docker's chains when the bridge is ours, and our bridges.

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
