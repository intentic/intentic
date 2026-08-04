# The CI runners

CI assumes one thing no runner provides by default: **a persistent host directory at `/ci-cache`**. Without it
the pipeline still passes — every job just runs cold. This file is the config that makes it warm, the evidence
for why it is shaped this way, and the setup for both runner systems while the migration to GitHub Actions is
in flight.

The evidence below was measured on GitLab, but none of it is GitLab-specific: it is about how pnpm, turbo and
cargo behave when their content-addressed stores are thrown away between jobs, which is the same on any CI.

---

## What the runners must provide

**A persistent `/ci-cache`, shared by every concurrent job.** It holds the pnpm store, the turbo task cache,
the cargo registry, three cargo target directories, and the ~1.1 GB xwin MSVC SDK. All are content-addressed
stores that every job reads and appends to — exactly what a shared directory is for, and exactly what a
per-job archive is worst at.

**`/ci-cache` on the same filesystem as the build directory.** pnpm hardlinks packages out of its store, and a
hardlink cannot cross a filesystem — so if the two are different devices, pnpm silently falls back to
**copying** every file, which is the shape of a 2–3 minute install. One line settles it:

```sh
stat -c '%d %n' /ci-cache <build-dir>   # same device id → hardlinks; different → copying
```

Expect the install to drop to seconds once they match: it becomes a link pass over a store that already holds
every package.

**A Docker daemon.** The image, release and e2e jobs drive it.

**Room for eight concurrent jobs.** Verification is split by release group — `test:core`, `test:platform` and
`test:site` each gate only their own artifacts — so the test stage opens with six jobs eligible at once (those
three plus `desktop:check`, `desktop:verify` and, until cutover, `mirror:verify`). Then the publishing jobs
come free individually as their own gate goes green. Under-provision this and the groups queue behind each
other, which is the coupling the DAG was written to remove: the pipeline still passes, it just serializes, and
every argument about a site failure not blocking a platform deploy stops being true in practice.

---

## GitHub Actions (the target)

### Eight runners, not one runner with eight slots

**A self-hosted Actions runner executes one job at a time.** There is no `concurrent` setting. To get the
parallelism above you register **eight runner instances** on the host — or an autoscaling set, or
[Actions Runner Controller](https://github.com/actions/actions-runner-controller) if this ever moves to
Kubernetes. Eight `svc.sh` installs from the same tarball, each with its own work directory, is the simplest
thing that works.

```sh
# once per instance, N = 1..8
mkdir -p /srv/actions/runner-$N && cd /srv/actions/runner-$N
curl -fsSL https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz | tar xz
./config.sh --url https://github.com/intentic/intentic \
            --token <registration-token> \
            --name worker-$N \
            --labels self-hosted,linux,x64,intentic \
            --work /srv/actions/work-$N \
            --unattended --replace
sudo ./svc.sh install && sudo ./svc.sh start
```

Get `<registration-token>` from **Settings → Actions → Runners → New self-hosted runner** (it expires in an
hour), or mint one from the API.

Give at least two of the eight the extra label `desktop` — `desktop:check`, `desktop:verify` and `release` are
the jobs that need the Rust/Tauri/NSIS toolchain image, and pinning them to a subset keeps that ~3.75 GB image
off every host.

### The shared cache and the same-filesystem rule

```sh
mkdir -p /srv/actions/ci-cache
```

Put the work directories **on the same filesystem** as it — that is what `--work /srv/actions/work-$N`
above is for, with `/srv/actions` as one volume. Verify after the first run:

```sh
stat -c '%d %n' /srv/actions/ci-cache /srv/actions/work-1
```

### Jobs run in a container, and need two mounts

Every job runs in the prebaked `ci-base` image, the same way it did on GitLab. In Actions that is
`jobs.<id>.container`, and two mounts have to be declared or the job is cold and Docker-less:

```yaml
container:
  image: ghcr.io/intentic/ci-base:latest
  volumes:
    - /srv/actions/ci-cache:/ci-cache          # the shared stores
    - /var/run/docker.sock:/var/run/docker.sock # the host daemon — no dind service
  credentials:
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
```

Mounting the host socket is what **removes the `docker:27-dind` service** the GitLab jobs attached, along with
its TLS certificate dance. The runner user must be in the `docker` group.

### What the runner host needs installed

Only Docker and the runner itself. Everything else — node, pnpm, ripgrep, bun, the docker CLI, the Rust and
Tauri toolchains — is baked into `ci-base` and `ci-desktop`.

### Keeping it bounded

- **turbo** — the pnpm-setup composite action prunes entries untouched for 14 days on every job
  (`find "$TURBO_CACHE_DIR" -type f -mtime +14 -delete`). Nothing else evicts from the directory now that it
  outlives the job, so this step is load-bearing.
- **pnpm** — the store only grows when a dependency version is added, so it grows slowly. `pnpm store prune`
  is the supported cleanup, but it removes anything not referenced by a currently-installed project and is
  **not safe to run while jobs are installing**. Run it by hand in a quiet window, not from CI.
- **cargo** — `/ci-cache/cargo` (the shared registry) grows like the pnpm store. The build directories do not:
  `desktop-target` (release), `desktop-verify-target` and `desktop-check-target` are **one per job** on
  purpose, for two reasons. Cargo locks a target directory exclusively for a whole build, so jobs sharing one
  serialize; and a build's fingerprint includes the stamped version, so the release (a new version every time)
  and `desktop:verify` (always `0.0.0`) each invalidated the other's leaf crate and paid a fresh LTO for it.
  Measured on the desktop crate: bumping the version recompiles exactly one crate in 20s, rebuilding the same
  version is a 1s no-op. Each dir is a few GB of rebuildable objects; `rm -rf` any of them in a quiet window
  and the next job repays it once.
- **xwin** — `/ci-cache/xwin` holds the MSVC CRT + Windows SDK that cargo-xwin splats for the release's Windows
  cross-build (~1.1 GB). Downloaded once, read by every run, never modified. It is here rather than at its
  default under `$HOME/.cache` because that dies with the container, which cost every release a 2m40s
  re-download.

Concurrent access itself is fine: the pnpm store is built for many projects sharing one store, turbo's entries
are content-addressed files written via atomic rename, and cargo's registry is designed for many builds
sharing one `CARGO_HOME`.

---

## GitLab (until cutover)

`.gitlab-ci.yml` stays live and green until the Actions pipeline has produced a green run on the same commit.
This section goes with it.

In the runner's `config.toml`:

```toml
concurrent = 8

[[runners]]
  name = "radarsu-worker"
  executor = "docker"

  [runners.docker]
    # ci-base's tag is mutable (the ci-base job moves it on main), so this must stay "always" — with the
    # layers already on the host that is a manifest digest check, not a download.
    pull_policy = "always"
    volumes = [
      "/cache",
      "/srv/gitlab-runner/ci-cache:/ci-cache",
    ]
```

Then once, on the runner host: `mkdir -p /srv/gitlab-runner/ci-cache`. Jobs run as root in the container, so
no ownership work is needed. If the mount is missing, both paths fall back to the container's own filesystem —
cold, never broken.

### Why a bind mount and not GitLab's `cache:`

Two independent problems, both measured on pipeline 2721608438 (2026-07-31, 47.9 min). This is the evidence
that also justifies the Actions design above.

**GitLab's cache never restored.** Every job logged `No URL provided, cache will not be downloaded from shared
cache server`. With no `[runners.cache]` backend the runner falls back to local storage scoped to the
**concurrent slot**, so a cache written by one slot is invisible to the next job that lands on another. Across
five consecutive `main` pipelines the correlation was exact:

| Pipeline | Slot | Turbo tasks cached |
| --- | --- | --- |
| 2721608438 | concurrent-2 | 0 / 75 |
| 2719431011 | concurrent-1 | 0 / 74 |
| 2718157354 | concurrent-3 | 0 / 74 |
| 2717973061 | **concurrent-0** | **71 / 74** |
| 2716887280 | **concurrent-0** | **34 / 74** |

At `concurrent = 4` that is a warm cache roughly one pipeline in four.

**Archiving it cost more than it ever returned.** The `test` job spent **6m19s** — 38% of its wall-clock —
zipping the store (69,292 files), and `get_sources` then spent 40s deleting those same files for the next job.
That CPU is spent whether or not anything reads the result, and an S3/MinIO backend would not remove it; it
would add an upload on top.

A shared directory has no archive step, no upload, no restore, and is shared by every job from the first
pipeline. Actions has the same choice and the same answer.

### The install that stays slow

With the store warm and nothing to download, `pnpm install --frozen-lockfile` still measured **2m21s–3m43s in
every job** of pipeline 2725042409 — the largest uniform cost in the pipeline. Half of that is addressed from
the repo side: `GIT_CLEAN_FLAGS: -ffdx -e node_modules` keeps a slot's installed tree between pipelines
instead of deleting 69k files and re-linking them. The other half is the same-filesystem rule at the top of
this file.
