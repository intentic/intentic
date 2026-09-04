---
name: environment
description: Extend this sandbox's own environment (system packages, language toolchains, SDKs, e.g. Rust, Android, JDK, Go, Python) by proposing custom Dockerfile steps the owner approves. Use when a task needs a tool that isn't installed and a runtime install wouldn't survive, or when the user asks to add capabilities to the sandbox itself.
---

# Sandbox environment (overlay Dockerfile)

You run inside a container built from `ghcr.io/intentic/sandbox:stable`. Anything you install at
runtime outside `/work` is lost when the container is recreated. To extend the environment permanently,
propose custom Dockerfile steps: the owner reviews and approves them, then a rebuild recreates the sandbox
(`/work` persists).

## Check what's already here first

The image is not bare, and reaching for an install before looking wastes a lot of a turn. Baked in every
profile:

- **Toolchain**: git (+ git-lfs), tmux, zsh, make/g++, python3 with **pip and venv** (`python` works too),
  node 24 (which runs `.ts` files directly: `tsx` is a shim over it), pnpm/npm.
- **Python libraries**: **PyYAML** and **Pillow** are baked, so `import yaml` and `from PIL import Image`
  work with no venv. They are the only two; anything else still needs pip inside a venv.
- **First-party CLIs**: `intentic`, `iq`, `lsp`.
- **Search & data** (ripgrep, `jq`, `yq` (YAML, for shell pipelines) in Python just `import yaml`),
  sqlite3, xmllint, file, tree.
- **Network**: curl, wget, rsync, openssh, ss/ip, netstat/ifconfig, lsof, fuser, ping, traceroute, dig/host,
  nc, socat.
- **Process & files**: ps/top, killall/pstree, strace, patch, less, nano/vi, diff, hexdump/xxd/column,
  unzip/zip, tar with gzip/xz/zstd/bzip2, sponge, envsubst, uuidgen, bc, dos2unix.

The heavier features are FEATURE PACKS that ride the image profile: the standard sandbox image also bakes
**Chromium with browser tools** (`mcp__web__browser_navigate`, `mcp__web__browser_take_screenshot`, …: load
them with ToolSearch; never install a browser yourself), a dormant Docker Engine, the provider CLIs
(`codex`, `opencode`, `cli-proxy-api`) and semantic `iq ask`. On a minimal (core) image each arrives through
its capability's own fragment on an owner rebuild: never propose an overlay for those; enabling the
capability composes it automatically.

Check with `command -v <tool>` before assuming something is missing. If a staple that belongs in that list is
genuinely absent, it is worth proposing below: the list above grew from exactly that.

The final overlay (`.intentic/local/environment.approved.Dockerfile`) is COMPOSED BY THE DAEMON from three parts:
the pinned `FROM`, the enabled capabilities' fragments (daemon-owned: never copy or touch these), and the
owner-approved custom section. You propose ONLY custom-section content.

## How to propose

A plain runtime install usually needs NO proposal from you: the daemon records image-scoped installs, watches
what the live container has that the image did not put there, and drafts the overlay step itself once the same
tool recurs across sessions. Draft manually when the need is known NOW (the owner asked, or waiting for
recurrence would waste sessions), or when the step is more than a package name — build flags, an ENV, a
download the daemon cannot infer.

1. Write your steps to `.intentic/config/environment.d/<tool>.Dockerfile`: one file per thing you need, named after
   it (`ffmpeg.Dockerfile`, `rust.Dockerfile`). Do NOT write `.intentic/config/environment.Dockerfile`: the daemon
   composes that from your drafts plus the already-approved custom section, and writing it directly would
   clobber a parallel agent's request and drop steps the owner already approved. Naming the file after the
   tool also means another agent needing the same one converges on your entry instead of duplicating it.
2. `RUN` and `ENV` lines only: NO `FROM` (the daemon owns the base image; a proposal containing one is
   rejected), no `# intentic:runtime` lines (reserved for capability fragments), and no `USER`, `ENTRYPOINT`,
   `CMD`, `EXPOSE`, `WORKDIR`, or `COPY` (there is no build context). Never put secrets in it.
3. Install into system paths, not `/work`: the workspace volume mounts over `/work` and hides anything
   the image put there.
4. Steps must be self-contained: install (and clean up) your own build deps, capability fragments purge
   theirs, so don't rely on another layer's compilers.
5. **Mount the build caches — this is the one rule with teeth.** Every `RUN` that installs with apt must
   carry both apt cache mounts, and must NOT delete `/var/lib/apt/lists` (see below for why). Every `RUN`
   that compiles with cmake must mount ccache and route the compilers through it. The published packs are
   held to the same rule by `_tools/checks/build-cache-mounts.mjs`; copy the shapes below verbatim.

### Why the mounts matter more than they look

This overlay is `FROM` the sandbox image. When a new sandbox image is published, that image's digest changes,
which invalidates **every layer of this overlay** — so on each update the sandbox reinstalls its entire
environment from scratch, and the bill grows with every tool anyone has ever added. One measured rebuild spent
19 minutes recompiling a GPU llama.cpp and 14 more downloading 175MB of Debian packages, none of whose recipes
had changed.

The layer miss is unavoidable: the image underneath genuinely did change. Re-downloading the bytes and
recompiling the same objects is not. A cache mount survives the miss, and it is never committed to the image,
so the cache costs nothing in image size — which is why the old `rm -rf /var/lib/apt/lists/*` is now both
harmful (it empties the cache the next rebuild would have read) and pointless (the lists never reach a layer).

Example (apt packages):

```dockerfile
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends build-essential
```

Example (Rust toolchain):

```dockerfile
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends build-essential
RUN --mount=type=cache,target=/root/.cargo/registry \
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
```

Example (anything built with cmake — the ccache mount is what makes a rebuild cheap):

```dockerfile
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.cache/ccache \
    apt-get update && apt-get install -y --no-install-recommends cmake ccache g++ \
    && cmake -S /tmp/src -B /tmp/build -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
    && cmake --build /tmp/build -j \
    && apt-get purge -y cmake ccache && apt-get autoremove -y
```

Other package managers take the same treatment where they have a cache directory worth keeping:
`/root/.cargo/registry` for cargo, `/root/.npm` for npm, `/root/.cache/pip` for pip.

6. **Don't hand-write a fragment for a tool the sandbox already packs.** If the thing you need is one of the
   feature packs (a browser, whisper, llama.cpp, a Docker engine), enabling its capability composes it for
   you — and on an image that already bakes it, composes nothing at all and needs no rebuild. A copied
   fragment is a second pin that drifts from the pack's, and on a standard image it builds the same binary a
   second time.

## After writing the file

Keep going with the task: drafting is not a blocking handover. Use a workaround if one exists, and say
plainly which parts stay unavailable until the rebuild rather than pretending they work.

Tell the owner to review and approve the change on the platform's **Sandbox page → Environment card**.
You cannot approve or apply it yourself; the rebuild runs outside this container. On a sandbox the owner runs
themselves they paste a rebuild command locally (or it applies on the next `intentic deploy apply` for a
server-managed sandbox); on a HOSTED sandbox (a machine the platform runs, `SANDBOX_VM=1` in this
container's env) the owner presses **Rebuild now** on that card and the platform builds it on a machine of its
own, which takes a few minutes and counts against the sandbox's awake hours. Until the rebuild, the new tools
are not available: say so instead of retrying. A capability that extends the image (VPN, a browser connector,
Docker) composes its own fragment automatically: never propose an overlay for those, just point the owner at
the same rebuild.

## Docker Engine problems are the Docker capability's options, not an overlay

Some failures inside the nested engine look like missing tooling and are not: they are switches on the
**Docker capability** (`/capabilities` → Docker). Never propose an overlay for these, and never edit the
user's files to route around them:

- `could not select device driver "nvidia" with capabilities: [[gpu]]` → **GPU access**. Needs an NVIDIA GPU
  and nvidia-container-toolkit on the machine the sandbox runs on, plus a rebuild. Do NOT delete a
  `driver: nvidia` reservation from their compose file to make the error go away: it "works", runs everything
  on CPU, and hides that it did.
- pulls failing or crawling on a metered/air-gapped link → **Registry mirror**.
- `http: server gave HTTP response to HTTPS client` from a LAN registry → **Insecure registries**.
- containers up, but internal/VPN hosts unreachable from them → **Container address pool**. Docker's default
  subnet collides with the route, and the giveaway is that everything else still works.

The last three apply on a dockerd restart (seconds, no rebuild) but the restart stops whatever the engine is
running, so tell the user rather than assuming it's free. Say which parts of the task are blocked meanwhile.

For a SERVER-managed sandbox, also wire the approved overlay into the intent so `intentic deploy apply` builds it:
in `intent/deploy.config.ts`, pass
`dockerfile: readFileSync("/work/.intentic/local/environment.approved.Dockerfile", "utf8")` to the
`i.want.workspace(…)` input: the content lands in the git-reviewed desired-state, which is the approval
gate on that path.
