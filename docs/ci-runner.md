# The CI runners

CI assumes one thing no runner provides by default: **a persistent host directory at `/ci-cache`**. Without it
the pipeline still passes — every job just runs cold. This file is the config that makes it warm, the runner
setup, and the evidence for why it is shaped this way.

That evidence is not CI-vendor-specific: it is about how pnpm, turbo and cargo behave when their
content-addressed stores are thrown away between jobs, which is the same anywhere.

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

**Room for six concurrent jobs.** Verification is split by release group — `verify-core`, `verify-platform` and
`verify-site` each gate only their own artifacts — and the widest wave of the Actions DAG is **five**:
those three plus `ci-base` and `e2e-hermetic`. Six is that number plus one slot of headroom, because the waves
overlap in practice: `images` starts the moment `verify-core` goes green while the other two groups are still
running.

Derive it rather than trust it — the graph is the source, and it changes:

```sh
# widest wave of jobs with no unmet dependency
node -e 'const Y=require("yaml"),f=require("fs");const j=Y.parse(f.readFileSync(".github/workflows/ci.yml","utf8")).jobs;
const d=Object.fromEntries(Object.entries(j).map(([k,v])=>[k,[v.needs??[]].flat()]));const m={},L=x=>m[x]??=(d[x].length?1+Math.max(...d[x].map(L)):0);
const w={};for(const k in j)(w[L(k)]??=[]).push(k);console.log(Math.max(...Object.values(w).map(a=>a.length)))'
```

Under-provision it and the groups queue behind each other, which is the coupling the DAG was written to
remove: the pipeline still passes, it just serializes, and every argument about a site failure not blocking a
platform deploy stops being true in practice.

---

## The runners

### Six runner processes on one host — not six hosts

**The GitHub Actions runner executes one job at a time — there is no concurrency setting.** Six concurrent
jobs therefore means six `actions/runner` processes on the one box, each a systemd service, all sharing the
one `/ci-cache`.

One machine, six systemd units. If that bookkeeping grates, the alternatives are an autoscaling set or
[Actions Runner Controller](https://github.com/actions/actions-runner-controller) if this ever moves to
Kubernetes — both solve the same problem with more moving parts than six `svc.sh` installs.

```sh
# once per instance, N = 1..6
mkdir -p /srv/actions/runner-$N && cd /srv/actions/runner-$N
curl -fsSL https://github.com/actions/runner/releases/latest/download/actions-runner-linux-x64.tar.gz | tar xz
./config.sh --url https://github.com/intentic/intentic \
            --token <registration-token> \
            --name worker-$N \
            --labels intentic,desktop \
            --work /srv/actions/work-$N \
            --unattended --replace
sudo ./svc.sh install && sudo ./svc.sh start
```

Get `<registration-token>` from **Settings → Actions → Runners → New self-hosted runner** (it expires in an
hour), or mint one from the API.

### The two labels, and why every runner gets both

`runs-on` is an AND over labels, and the workflows use exactly two sets:

| `runs-on` | Jobs |
| --- | --- |
| `[self-hosted, intentic]` | changes, preflight, ci-base, ci-desktop, e2e-hermetic, images, images-platform, verify ×3, nightly e2e, npm publish |
| `[self-hosted, intentic, desktop]` | desktop-check, desktop-verify, release, nightly desktop-setup |

Only `intentic` and `desktop` go in `--labels`. **`self-hosted`, `Linux` and `X64` are applied by the runner
itself** — naming them again just adds lowercase duplicates that nothing matches on.

`desktop` is a superset, so a runner carrying both labels can take any job in the file — which is why the
command above gives every instance both. **On a single host that is strictly better than partitioning.** The
usual reason to pin the desktop jobs to a subset is to keep the ~3.75 GB `ci-desktop` image off the other
machines, and here there are no other machines: six runner processes share one Docker daemon, so the image is
pulled once whatever the labels say. Partitioning would buy nothing and cost a real failure mode — `release`
also needs `desktop`, so with only two such runners a `desktop-check` and a `desktop-verify` running together
leave the release queued while four idle runners watch.

Split the labels when the desktop jobs move to their own machine. Until then, both on all six.

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

Every job runs in the prebaked `ci-base` image. That is `jobs.<id>.container`, and two mounts have to be
declared or the job is cold and Docker-less:

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

Mounting the host socket is what makes a **dind service unnecessary**, along with its TLS certificate dance.
The runner user must be in the `docker` group.

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
  and `desktop-verify` (always `0.0.0`) each invalidated the other's leaf crate and paid a fresh LTO for it.
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

## Why a bind mount and not a managed cache

A per-job cache archive was measured against the shared directory and lost twice over.

**Archiving cost more than it ever returned.** The verify job spent **6m19s** — 38% of its wall-clock —
zipping the store (69,292 files), and the next job's source fetch spent another 40s deleting those same files.
That CPU is spent whether or not anything reads the result, and an object-store backend would not remove it; it
would add an upload on top.

**A slot-scoped cache almost never hit.** Local cache storage scoped per concurrent slot meant a cache written
by one slot was invisible to the next job that landed on another — measured across five consecutive `main`
pipelines, a warm turbo cache (71/74 tasks) appeared only when a run happened to land on the slot that wrote
it, roughly one pipeline in four. Everything else was 0/74.

A shared directory has no archive step, no upload, no restore, and is warm for every job from the first
pipeline onward.

### The install that stays slow

With the store warm and nothing to download, `pnpm install --frozen-lockfile` still measured **2m21s–3m43s in
every job** — the largest uniform cost in the pipeline. Half of that is addressed by keeping a workspace's
installed tree between runs rather than deleting 69k files and re-linking them, which is what
`actions/checkout`'s `clean: false` is for in every job of `ci.yml`. The other half is the same-filesystem
rule at the top of this file.
