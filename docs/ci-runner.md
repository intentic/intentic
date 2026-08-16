# The CI runners

> The **Linux** fleet. The one Windows machine — the only runner that can execute the Windows installer — is
> [`ci-runner-windows.md`](ci-runner-windows.md), and shares none of the setup below.

CI assumes one thing no runner provides by default: **a persistent host directory at `/ci-cache`**. Without it
the pipeline still passes — every job just runs cold. This file is the config that makes it warm, the runner
setup, and the evidence for why it is shaped this way.

That evidence is not CI-vendor-specific: it is about how pnpm, turbo and cargo behave when their
content-addressed stores are thrown away between jobs, which is the same anywhere.

---

## The fork boundary

**The fleet builds only branches pushed to this repository. A pull request from a fork runs nothing.**

`intentic/intentic` is public, and every property this file spends its length arguing for is also what makes a
fork's pull request dangerous: the runners are **not ephemeral**, they share **one `/ci-cache`** with `release`,
and each mounts the **host docker socket**. Building a pull request means running its code — install lifecycle
scripts, tests, build scripts — so a fork's pull request had a path to host root, and from a poisoned turbo
entry a path into a published artifact. The credentials that live on these hosts are the ones that matter:
`TAURI_SIGNING_PRIVATE_KEY`, `KOMODO_API_*`, `CLOUDFLARE_API_TOKEN`.

This is the warning GitHub puts on the runner page. **Two controls hold it, and neither is sufficient alone** —
that pairing is the part worth understanding before reviewing an outside pull request.

**1. Approval, for all outside contributors.** Settings → Actions → General, set to *require approval for all
outside contributors* rather than the default *first-time contributors* — the default stops applying to anyone
the moment one of their pull requests is merged, so it protects a project exactly until it has its first repeat
contributor. This is the control that covers the case the `if` below cannot: on a `pull_request` event Actions
runs the workflow file **from the pull request's own merge ref**, so a fork that edits `ci.yml` runs its edited
copy, guard deleted. Nothing runs before the click, which is what makes that unreachable.

**2. The `if` guard.** This is the control that covers the case approval cannot: a pull request that looks
harmless and carries its payload in a `postinstall`, a test, or a build script. Clicking approve on one of those
runs it on the release host as root — no amount of care at the button changes that, because the diff that
matters is 1,800 packages deep. The guard means the click cannot start a build of fork code at all.

**So when you review an outside pull request, read `.github/` first.** A diff that touches a workflow file is
the one shape where approving is equivalent to running whatever it says.

The guard is two `if` conditions, on `changes` and `preflight`, the DAG roots of `ci.yml`:

```yaml
if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
```

Everything else is already out of reach and stays that way without repeating the line: a skipped dependency
skips its dependents, `images`/`images-platform`/`release` additionally require
`github.event_name == 'push' && github.ref == 'refs/heads/main'`, and the jobs that opt out of the skip rule
with `!cancelled()` all read a root's own output or result. `e2e-hermetic` carries a third copy because it is
the one job whose condition names no `needs` output.

**That inheritance is the fragile part, so it is asserted rather than trusted.** `prepass.mjs --checks-only`
(invariant 4, run by the `preflight` job and the pre-push hook) grows the safe set to a fixpoint from the jobs
that guard themselves and fails on any self-hosted job left outside it — so a job added with no guard and no
`needs` edge to one goes red instead of quietly reopening this.

To run CI on an outside contribution, **read the diff**, then push its branch to this repository and open the
pull request from there.

> Still worth doing, and it needs an org owner: the Linux runners are registered at the **organisation** scope
> (`--url https://github.com/intentic`, below), so they are offered to every repository in the org. Putting them
> in a runner group with **"Allow public repositories" off** would make this a platform guarantee rather than a
> property of one workflow file.

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

**Room for six concurrent jobs — and that is now exactly the wave, not the wave plus headroom.** Verification is
split by release group — `verify-core`, `verify-platform` and `verify-site` each gate only their own artifacts
— and the widest wave of the Actions DAG is **six**: those three plus `migrations`, `ci-base` and
`e2e-hermetic`. It was five when six instances were provisioned; `migrations` is the job that took the spare
slot. The waves also overlap in practice — `images` starts the moment `verify-core` goes green while the other
two groups are still running — so at six instances a pipeline can already be queueing against itself.

Not every job in that wave runs in every pipeline (`migrations` needs a platform change, `ci-base` a Dockerfile
change, `e2e-hermetic` a pull request), so the six collide only sometimes. **Treat the next job added to wave 1
as needing a seventh runner process**, and re-derive rather than trust the number — the script below is why it
is written down as a command instead of a sentence.

Derive it rather than trust it — the graph is the source, and it changes. No dependency, because `yaml` is not
hoisted to the workspace root and `require("yaml")` from there throws:

```sh
# widest wave of jobs with no unmet dependency
node -e 'const s=require("fs").readFileSync(".github/workflows/ci.yml","utf8").split("\n"),d={};let c=null;
for(const l of s.slice(s.findIndex(l=>/^jobs:/.test(l))+1)){const j=l.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);if(j){d[c=j[1]]=[];continue}
const n=l.match(/^ {4}needs:\s*(.+?)\s*$/);if(n&&c)d[c]=n[1].replace(/^\[|\]$/g,"").split(",").map(x=>x.trim()).filter(Boolean)}
const m={},L=x=>m[x]??=(d[x].length?1+Math.max(...d[x].map(L)):0),w={};for(const k in d)(w[L(k)]??=[]).push(k);
console.log(Math.max(...Object.values(w).map(a=>a.length)))'
```

Under-provision it and the groups queue behind each other, which is the coupling the DAG was written to
remove: the pipeline still passes, it just serializes, and every argument about a site failure not blocking a
platform deploy stops being true in practice.

**Measured, on a host running one runner process** — 173 jobs over a 17-hour window, every one of them on a
single instance:

| | |
| --- | --- |
| peak jobs executing at once | **1** |
| peak jobs waiting at once | **21** |
| median wait before a job starts | **10m29s** |
| p90 / max wait | **36m43s / 61m10s** |
| host busy | 7.7h of 17h — **idle 54% of the time** |

Idle and starved at once is the signature of this mistake: the work is there, the slots are not. With one
instance the wall clock is the *sum* of every job's duration; with enough of them it is the critical path,
which for this DAG is a little over a third of that. A 23-second `changes` job waiting 35 minutes for a slot is
not a scheduling problem, it is a provisioning one.

---

## The runners

### Six runner processes on one host — not six hosts

**The GitHub Actions runner executes one job at a time — there is no concurrency setting.** Six concurrent
jobs therefore means six `actions/runner` processes on the one box, each a systemd service, all sharing the
one `/ci-cache`.

One machine, six systemd units. If that bookkeeping grates, the alternatives are an autoscaling set or
[Actions Runner Controller](https://github.com/actions/actions-runner-controller) if this ever moves to
Kubernetes — both solve the same problem with more moving parts than six `svc.sh` installs.

Each instance needs **its own directory, its own `--name` and its own `--work`**, and all of them want to be on
the same filesystem as `/ci-cache`. Run it from `$HOME`, never from inside a runner directory:

```sh
# N = 2..6 alongside the existing instance. NOT run from inside an existing runner dir: there ./config.sh and
# ./svc.sh are THAT runner's, so this reconfigures the one working instance instead of adding a new one.
VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest |
           sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')"
curl -fSL "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-x64-$VERSION.tar.gz" \
     -o ~/.actions-runner.tar.gz

mkdir -p ~/actions-runner-$N ~/actions-work-$N && cd ~/actions-runner-$N
tar xzf ~/.actions-runner.tar.gz
./config.sh --url https://github.com/intentic \
            --token <registration-token> \
            --name $(uname -n)-$N \
            --labels intentic,desktop \
            --work ~/actions-work-$N \
            --unattended --replace
sudo ./svc.sh install $USER && sudo ./svc.sh start
```

**`--url` has to match the scope the token came from.** A token minted on the ORG's runner page pairs with
`https://github.com/intentic`; one minted on the REPO's pairs with `https://github.com/intentic/intentic`.
Crossing them fails as an unexplained `404 Not Found` from `POST api.github.com/actions/runner-registration`,
which reads like an expired token and is really a scope mismatch — the token is fine, the URL is wrong. The
existing runners are org-registered, so the org form above is the one that keeps them in one list. To tell the
two apart without guessing:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.github.com/actions/runner-registration \
  -H "Authorization: RemoteAuth <registration-token>" -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/intentic","runner_event":"register"}'   # 200 = org-scoped token
```

**The download URL has to name the version.** There is no
`releases/latest/download/actions-runner-linux-x64.tar.gz` — that path 404s, because the asset is published as
`actions-runner-linux-x64-<version>.tar.gz`. Piping the 404 body into `tar` is what produces `gzip: stdin:
unexpected end of file` followed by `./config.sh: not found`, which reads like a broken script and is really a
broken URL.

**`svc.sh` does not exist until `config.sh` has succeeded** — it is generated by configuration, not shipped in
the tarball. `sudo ./svc.sh: command not found` therefore means the configure step above it failed.

`config.sh` must run as the normal user (it refuses under `sudo`); only `svc.sh` takes it. Get
`<registration-token>` from the **organisation's** Settings → Actions → Runners → New self-hosted runner, to
match the `--url` above. It expires in an hour, but within that window it is reusable: one token registers as
many runners as you like, and minting a new one does not invalidate it.

**Runner 2.327.1 is a floor, not a preference.** Every action the workflows use runs on the node24 runtime,
and a runner below that version cannot execute one — the job fails before the first step. Resolving the version
from the releases API above clears it, and nothing here passes `--disableupdate`, so a runner that has been
running keeps clearing it on its own. Pinning an older tarball, or turning self-update off, is what would break
the pipeline.

### The two labels, and why every runner gets both

`runs-on` is an AND over labels, and the workflows use exactly two sets:

| `runs-on` | Jobs |
| --- | --- |
| `[self-hosted, intentic]` (17) | ci: changes, preflight, migrations, ci-base, ci-desktop, e2e-hermetic, images, images-merge, images-platform · verify ×3 · release: plan, images-amd64 · nightly: e2e, images-public · action-publish, vscode-publish, rollback |
| `[self-hosted, intentic, desktop]` (10) | ci: desktop-check, ic-check, desktop-verify, desktop-windows-build · release: windows-build, linux-build, publish · nightly: desktop-setup, desktop-windows-build, update-survival |
| `[self-hosted, windows-desktop]` (3) | ci: desktop-verify-windows · release: windows-verify · nightly: desktop-windows |

Regenerate rather than edit — this table went stale once already, and a stale one reads as a capacity claim:

```sh
node -e 'const fs=require("fs");const by={};
for(const f of fs.readdirSync(".github/workflows").filter(f=>f.endsWith(".yml"))){
  const s=fs.readFileSync(".github/workflows/"+f,"utf8").split("\n");let job=null;
  for(let i=s.findIndex(l=>/^jobs:/.test(l))+1;i<s.length;i++){
    const h=s[i].match(/^ {2}([A-Za-z_][\w-]*):\s*$/);if(h){job=h[1];continue}
    const r=s[i].match(/^ {4}runs-on:\s*(.+?)\s*$/);if(r&&job)(by[r[1]]??=[]).push(f.replace(/\.yml$/,"")+"/"+job)}}
for(const [k,v] of Object.entries(by).sort())console.log(`${k}\n   (${v.length}) ${v.join(", ")}\n`)'
```

The two GitHub-hosted sets are deliberate and documented where they are used: `ubuntu-24.04` for codeql,
scorecard and the npm publish, `ubuntu-24.04-arm` for the two native arm64 sandbox builds.

The npm publish is the one job that may **not** run here: npm's registry builds the provenance attestation's
builder id out of the runner's environment and accepts only `github-hosted`, so `npm-publish.yml` runs on
`ubuntu-24.04` and pays cold caches for it. The file says the rest; prepass invariant 9 keeps it there.

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

**The host path is `/ci-cache`, and it is not configurable.** Every workflow hardcodes the mount as
`/ci-cache:/ci-cache`, so a cache made anywhere else is a cache nothing reads — Docker would silently create an
empty `/ci-cache` on the host and every job would run cold against it, which is the failure that looks like
"the cache is configured and yet nothing is warm".

```sh
mkdir -p /ci-cache
```

Put the work directories **on the same filesystem** as it — that is what `--work /srv/actions/work-$N` above is
for. If `/srv` is its own volume, either give `/ci-cache` a bind mount onto that volume or move the work dirs
back onto the root one; the check below is what tells you which situation you are in. Verify after the first
run:

```sh
stat -c '%d %n' /ci-cache /srv/actions/work-1
```

### Jobs run in a container, and need two mounts

Every job runs in the prebaked `ci-base` image. That is `jobs.<id>.container`, and two mounts have to be
declared or the job is cold and Docker-less:

```yaml
container:
  image: ghcr.io/intentic/ci-base:latest
  volumes:
    - /ci-cache:/ci-cache                      # the shared stores
    - /var/run/docker.sock:/var/run/docker.sock # the host daemon — no dind service
  credentials:
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}
```

Mounting the host socket is what makes a **dind service unnecessary**, along with its TLS certificate dance.
The runner user must be in the `docker` group.

### The two host jobs, and the ownership hazard they carry

`ci-base` and `ci-desktop` are the exceptions — they run on the host as the runner user, because docker-building
the CI images is the one thing that cannot happen inside them. All jobs, container and host alike, share
**one persistent workspace per runner**, so the container jobs' checkout leaves a root-owned tree behind and
the next host job cannot write `.git`. Checkout dies on `index.lock: Permission denied`, then dies again
trying to delete a tree it also cannot write.

It does not announce itself. When `changes` was still a host job this made it a per-workspace coin flip — four
of the six workspaces were in that state at once, and a failed `changes` makes every image and desktop job
**skip**, which reads as a green pipeline that published nothing. That is why `changes` now runs in the
container like everything else (the chown it needed first measured 4+ minutes on every pipeline), leaving the
hazard to the two jobs that only run when their own Dockerfiles change.

Each host job therefore opens with a `Reclaim the workspace from the container jobs` step that chowns the tree
back through a throwaway root container (the runner user is in the `docker` group, so this needs no sudo).
To repair a workspace by hand:

```sh
docker run --rm --entrypoint chown -v /home/<user>/<work-dir>:/w ghcr.io/intentic/ci-base:latest -R 1000:1000 /w
```

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
