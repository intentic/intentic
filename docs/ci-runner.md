# The CI runner (`radarsu-worker`)

`.gitlab-ci.yml` assumes one thing of the runner that GitLab does not provide by default: **a host directory
bind-mounted at `/ci-cache`**. Without it the pipeline still passes — every job just runs cold. This file is
the config that makes it warm, and the evidence for why it is shaped this way.

## The one required change

In the runner's `config.toml`, add the mount to `[runners.docker] volumes`:

```toml
concurrent = 4

[[runners]]
  name = "radarsu-worker"
  executor = "docker"

  [runners.docker]
    # ci-base's tag is mutable (the ci-base job moves it on main), so this must stay "always" — with the
    # layers already on the host that is a manifest digest check, not a download.
    pull_policy = "always"
    volumes = [
      "/cache",
      # The pnpm store + turbo task cache. Both are content-addressed stores that every job reads and
      # appends to, so they belong on a shared filesystem rather than in a per-job zip archive.
      "/srv/gitlab-runner/ci-cache:/ci-cache",
    ]
```

Then, once, on the runner host:

```sh
mkdir -p /srv/gitlab-runner/ci-cache
```

Jobs run as root in the container, so no ownership work is needed. `PNPM_STORE` and `TURBO_CACHE_DIR` in
`.gitlab-ci.yml` point at subdirectories of this mount; if it is missing, both fall back to the container's own
filesystem — cold, never broken.

## Why a bind mount and not GitLab's `cache:`

Two independent problems, both measured on pipeline 2721608438 (2026-07-31, 47.9 min):

**GitLab's cache never restored.** Every job logged `No URL provided, cache will not be downloaded from shared
cache server. Instead a local version of cache will be extracted.` → `WARNING: Cache file does not exist`. With
no `[runners.cache]` backend the runner falls back to local storage scoped to the **concurrent slot**, so a
cache written by one slot is invisible to the next job that lands on another. Across five consecutive `main`
pipelines the correlation was exact:

| Pipeline | Slot | Turbo tasks cached |
| --- | --- | --- |
| 2721608438 | concurrent-2 | 0 / 75 |
| 2719431011 | concurrent-1 | 0 / 74 |
| 2718157354 | concurrent-3 | 0 / 74 |
| 2717973061 | **concurrent-0** | **71 / 74** |
| 2716887280 | **concurrent-0** | **34 / 74** |

At `concurrent = 4` that is a warm cache roughly one pipeline in four.

**Archiving it cost more than it ever returned.** The `test` job spent **6m19s** — 38% of its wall-clock —
zipping the store (`.pnpm-store/: found 69292 matching artifact files and directories`), and `get_sources` then
spent 40s deleting those same 69k files for the next job. That CPU is spent whether or not anything reads the
result, and an S3/MinIO backend would not remove it; it would add an upload on top.

A bind mount has no archive step, no upload, no restore, and is shared by every slot from the first pipeline.

## The install that stays slow, and the one check left

With the store warm and nothing to download, `pnpm install --frozen-lockfile` still measured **2m21s-3m43s in
every job** of pipeline 2725042409 — the largest uniform cost in the pipeline. Half of that is now addressed
from the repo side: `.gitlab-ci.yml` sets `GIT_CLEAN_FLAGS: -ffdx -e node_modules`, so a slot keeps its
installed tree between pipelines instead of deleting 69k files and re-linking them.

What that cannot fix is the import method. pnpm hardlinks packages out of the store, and a hardlink cannot
cross a filesystem — so if `/ci-cache` (a host bind mount) and `/builds` (the container's own filesystem) are
different devices, pnpm silently falls back to **copying** every file, which is exactly the shape of a 2-3
minute install. One line in any job settles it:

```sh
stat -c '%d %n' /builds /ci-cache      # same device id → hardlinks; different → copying
```

If they differ, put the builds directory on the same volume as the cache:

```toml
  [[runners]]
    builds_dir = "/builds"
    [runners.docker]
      volumes = [
        "/srv/gitlab-runner/ci-cache:/ci-cache",
        "/srv/gitlab-runner/builds:/builds",
      ]
```

Expect the install to drop to seconds — it becomes a link pass over a store that already holds every package.

## Optional: a distributed cache backend

Two small GitLab caches remain — `iq-models` (~57 MB, in `images` and `release`) and `intentic-e2e-whisper`
(in `e2e:nightly`). They are still subject to the per-slot miss above. If you want them to hit, give the runner
a real backend; MinIO on the same host is enough:

```toml
  [runners.cache]
    Type = "s3"
    Shared = true
    [runners.cache.s3]
      ServerAddress = "127.0.0.1:9000"
      BucketName = "gitlab-runner-cache"
      Insecure = true
      AuthenticationType = "access-key"
      AccessKey = "…"
      SecretKey = "…"
```

This is worth ~90s per pipeline, so it is genuinely optional. `iq-models` deliberately stayed a GitLab cache
rather than moving to `/ci-cache`: it has to land inside `.image-out` (the sandbox image COPYs it as the
`trees` context), and `images` and `release` run `prepare-image-trees.sh` concurrently — a shared directory
would need the fetch made race-safe first.

## Keeping the shared directory bounded

- **turbo** — `.pnpm-setup` prunes entries untouched for 14 days on every job
  (`find "$TURBO_CACHE_DIR" -type f -mtime +14 -delete`). Nothing else evicts from the directory now that it
  outlives the job, so this line is load-bearing.
- **pnpm** — the store only grows when a dependency version is added, so it grows slowly. `pnpm store prune`
  is the supported cleanup, but it removes anything not referenced by a currently-installed project and is
  **not safe to run while jobs are installing**. Run it by hand in a quiet window, not from CI.

Concurrent access itself is fine: the pnpm store is built for many projects sharing one store, and turbo's
entries are content-addressed files written via atomic rename.

## Verifying it worked

After the first pipeline on the new config:

```sh
# no more "Cache file does not exist" for the pnpm/turbo paths — they are no longer GitLab caches at all
# and the test job should report a large "Cached: N cached" from turbo
curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "https://gitlab.com/api/v4/projects/radarsu%2Fintentic/jobs/<id>/trace" | grep -E 'Cached:|  Time:'
```

The sandbox image is a separate axis: its layer cache rides inline on the published image (see
`_tools/scripts/publish-images.sh`), so the check there is that `sandbox:latest` is being *re-pushed* each
pipeline and that the build reports `CACHED` for the tool-install layers.
