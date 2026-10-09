# intentic-engine rootfs

Small WSL2 distro (`intentic-engine`) that runs the open-source Docker engine for Intentic sandboxes on Windows PCs without Docker Desktop.

## What it contains

- Alpine minirootfs (pinned in `pins.toml`)
- Static `dockerd`, `containerd`, `runc`, and helpers from Docker’s static Linux bundle
- `/usr/local/bin/intentic-engine` — foreground keeper started by `ic engine start`
- `/etc/wsl.conf` — no Windows PATH append; automount stays on for `/mnt/c` project binds

## Build

```sh
bash _sandbox/ic/engine/build.sh _sandbox/ic/dist-bin
# or
bash _tools/scripts/build/build-intentic-engine.sh
```

Output: `intentic-engine-<version>-x86_64.tar.gz` and a `.sha256` sidecar beside it. CI attaches both to the GitHub release next to the `ic` binaries.

## Update policy

`ic engine update` replaces only the static Linux docker binaries inside an existing distro so `/var/lib/docker` in the distro VHDX is kept. When `engine_version` in `pins.toml` changes, the build produces a new rootfs tarball; installs use `wsl --import` (first setup) or a documented remove/reinstall if the rootfs layout must change.
