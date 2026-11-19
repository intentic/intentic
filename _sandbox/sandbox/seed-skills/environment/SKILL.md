---
name: environment
description: Extend this sandbox's own environment (system packages, language toolchains, SDKs: Rust, Android, JDK, Go, Python) by proposing Dockerfile steps the owner approves. Use when a task needs a tool that isn't installed and a runtime install wouldn't survive, or the user asks to add capabilities to the sandbox itself.
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
- **Python projects**: `uv` (+ `uvx`), `ruff` and `pyright` ride the `python` feature pack, which the standard
  image bakes — so `uv sync` installs a `pyproject.toml` project, and the daemon checks every `.py` edit with
  ruff (plus pyright where the project's `.venv` resolves). On an image without that pack the daemon says a
  python project is `unsupported` and reports edits as unchecked rather than guessing; adding it back is the
  pack, not a hand-written step.
- **Python and ML caches** are already set, one per kind, in `.intentic/local/cache/`: `UV_CACHE_DIR` (`uv`),
  `PIP_CACHE_DIR` (`pip`), `HF_HOME` (`huggingface`), `TORCH_HOME` (`torch`), `CUDA_CACHE_PATH` (`cuda`). Use them
  rather than a cache per tool, and don't set `UV_LINK_MODE=copy`: a venv in `.intentic/local/cache/<tool>/` then
  hardlinks every wheel out of the one uv cache, so five venvs with torch hold torch once, and one Hugging Face cache
  holds a model once for every tool that loads it. Put a tool's own install and venv in its own
  `.intentic/local/cache/<tool>/`: Settings → Storage lists each such folder and can clean it.
- **First-party CLIs**: `intentic`, `lsp`.
- **Search & data** (ripgrep, `jq`, `yq` (YAML, for shell pipelines) in Python just `import yaml`),
  sqlite3, xmllint, file, tree.
- **Network**: curl, wget, rsync, openssh, ss/ip, netstat/ifconfig, lsof, fuser, ping, traceroute, dig/host,
  nc, socat.
- **Process & files**: ps/top, killall/pstree, strace, patch, less, nano/vi, diff, hexdump/xxd/column,
  unzip/zip, tar with gzip/xz/zstd/bzip2, sponge, envsubst, uuidgen, bc, dos2unix.

The heavier features are FEATURE PACKS that ride the image profile: the standard sandbox image also bakes
**Chromium with browser tools** (`mcp__web__browser_navigate`, `mcp__web__browser_take_screenshot`, …: load
them with ToolSearch; never install a browser yourself), a dormant Docker Engine, the provider CLIs
(`codex`, `opencode`, `cli-proxy-api`). On a minimal (core) image each arrives through
its capability's own fragment on an owner rebuild: never propose an overlay for those; enabling the
capability composes it automatically. A few packs ride no profile and no capability because few sandboxes need
them: `office` (LibreOffice and poppler, what `fileq render` draws documents with, ~335 MB). Ask for one by name
with `environment propose office --pack --why "…"`: it files that pack's own steps (never hand-copy them), and
answers at once when the image already bakes it.

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
   it (`ffmpeg.Dockerfile`, `rust.Dockerfile`), then run `environment propose <tool> --why "…"` (below). Do NOT
   write `.intentic/config/environment.Dockerfile`: the daemon composes that from your drafts plus the
   already-approved custom section, and writing it directly would clobber a parallel agent's request and drop
   steps the owner already approved. Naming the file after the tool also means another agent needing the same
   one converges on your entry instead of duplicating it.
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

**Write no compiler-cache lines into a Rust recipe.** Wherever the overlay installs a Rust toolchain, the daemon
composes the `rust-cache` pack in front of it by itself: sccache, a `rustc-cached` wrapper as `RUSTC_WRAPPER` (through a
link named `sccache`, so the C and C++ a build script compiles with the cc crate is cached as well), and one cache at `/history/cache/sccache` (30 GB cap) that every checkout's builds read and fill, so a new conversation's first
build takes the dependencies other checkouts already compiled instead of compiling them again. It outlives a restart,
and Settings → Storage counts it as a build cache. It caches library crates; proc-macros, build scripts, binaries and
the workspace's own crates still compile in each checkout. A recipe that sets its own `RUSTC_WRAPPER` keeps it and gets
no pack. A recipe written from this skill between 2026-11-03 and 2026-11-17 may still carry its old sccache lines,
which start ONE server shared by every conversation; an isolated conversation sees its own checkout at `/work` and that server builds the checkout
that started it, so builds there fail with "extern location for … does not exist". If you meet that, propose the same
block without its sccache lines and the pack takes over after the rebuild. Don't share one `CARGO_TARGET_DIR` between
checkouts either: Cargo locks a target directory per build and keys its fingerprints by path, so two conversations
building at once block each other or rebuild each other's crates, and one removed checkout's output disappears from
under the other.

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
`/root/.cargo/registry` for cargo (`$CARGO_HOME/registry` when you set `CARGO_HOME`), `/root/.npm` for npm,
`/root/.cache/pip` for pip. A `cargo install` also keeps its compile: give it a target directory on a mount
(`--mount=type=cache,id=cargo-target-<crate>,target=/var/cache/cargo-target` and
`CARGO_TARGET_DIR=/var/cache/cargo-target cargo install …`), and the rebuild links instead of compiling ~200 crates.

### A heavy toolchain: install it once, copy it out on every rebuild

A cache MOUNT keeps downloads, but a toolchain that is itself gigabytes (an Android SDK with its NDK and system image,
Flutter with its precache, rustup's toolchains) still downloads in full on every update, because the install is what
writes it. For those, install into the image once, keep a copy in a cache mount, and on every later rebuild copy the
copy out: no network, no compile, only a local copy. This is the shape; copy it and change the four marked things:

```dockerfile
# (1) the mount id names the tool; (2) KEY names everything that decides what gets installed: a version, a package
# list, a URL. Change the recipe and the key changes with it, so a stale copy is never reused; (3) the paths the
# install writes; (4) the install itself.
RUN --mount=type=cache,id=toolchain-flutter,target=/var/cache/toolchain,sharing=locked \
    set -eu; \
    key="$(printf '%s' 'flutter 3.47.7 precache android' | sha256sum | cut -c1-16)"; \
    cache="/var/cache/toolchain/$key"; \
    if [ -e "$cache/.complete" ]; then \
        cp -a "$cache/flutter" /opt/flutter; \
    else \
        rm -rf /var/cache/toolchain/* /opt/flutter; \
        curl -fsSL https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.47.7-stable.tar.xz \
            | tar -xJ -C /opt; \
        /opt/flutter/bin/flutter precache --android; \
        mkdir -p "$cache" && cp -a /opt/flutter "$cache/flutter" && touch "$cache/.complete"; \
    fi
```

What to know before using it:
- **Only the paths you copy come back.** Anything else the install writes (`/etc/gitconfig`, a file under `/root`, a
  shell profile) is NOT replayed on a reuse: do those steps after the `fi`, so they run both times.
- **A floating version needs a key that floats with it.** `stable`, `latest` or an unversioned URL would freeze at
  whatever was cached first; derive the key from what upstream publishes instead (rustup:
  `curl -fsSL https://static.rust-lang.org/dist/channel-rust-stable.toml.sha256`), so a new release installs fresh.
- `rm -rf /var/cache/toolchain/*` on a miss drops the previous version, so the cache holds one copy per mount id.
- The cache lives in the Docker builder of the machine that rebuilds, and Docker may evict it when its disk is
  short: that costs one full install, never a wrong one. It does cost the toolchain's size again in that builder.
- Apt packages are not this case: the apt mounts already make them cheap.

6. **Don't hand-write a fragment for a tool the sandbox already packs.** If the thing you need is one of the
   feature packs (a browser, llama.cpp, a Docker engine), enabling its capability composes it for
   you — and on an image that already bakes it, composes nothing at all and needs no rebuild. A copied
   fragment is a second pin that drifts from the pack's, and on a standard image it builds the same binary a
   second time.

## Ask for it: `environment propose`

```sh
environment propose ffmpeg --why "to cut the demo video for the pull request"
# reads .intentic/config/environment.d/ffmpeg.Dockerfile; --file <path> or --file - (stdin) for another source
```

The daemon checks the steps first (a `FROM`, a forbidden instruction or an apt install without its cache mounts
is refused on the spot, with the reason), files them, and puts them on a card in this chat, where the owner
reads them and approves or declines. The command answers like every ask: exit 0 when the running container
already has the approved steps, exit 1 when refused or declined, and exit 3 while it waits, which is the usual
case, since approving is followed by a rebuild. Once the container runs the approved image, the sandbox
continues this conversation by itself: do not poll, and do not propose the same tool twice (`needs` lists what
is still waiting). Exit 2 means no verdict was reached: read the error on stdout and correct the command or
restore the daemon before retrying.

The owner can also take a tool out again (**Remove from environment** on the Environment card). A draft the owner
already answered (approved, removed or declined) is not proposed again when a copy of it lands with your work, so
a removed tool stays removed. If the task truly needs it back, say why and run `environment propose` again: that
is the only way to re-ask for the same steps.

## A tool's own state (its login, its config) across rebuilds

A rebuild keeps only the volumes: `/work`, `/history` and Docker's. Everything a tool writes under `/root`
(`~/.zcode`, `~/.config/<tool>`, a CLI's login token) is in the container's own layer and is gone after every
rebuild, so the owner signs that tool in again each time. Baking the tool into the image does not change this.

To keep it, put the state on the `/history` volume and point the tool at it from the image:

1. Move what the tool has now onto the volume, which survives: `mkdir -p /history/home && mv ~/.zcode
   /history/home/.zcode` (or `mkdir -p /history/home/.zcode` when there is nothing yet).
2. If the tool reads a variable for its config directory (check its docs: `ZCODE_HOME`, `XDG_CONFIG_HOME`,
   `CODEX_HOME`...), propose an `ENV` step setting it: `ENV ZCODE_HOME=/history/home/.zcode`.
3. Otherwise propose a symlink of the DIRECTORY: `RUN ln -sfn /history/home/.zcode /root/.zcode`. Link the
   directory, never a single file: a tool that saves a file by renaming a temporary over it replaces a file
   symlink with an ordinary file and silently stops persisting.

`/history` is this sandbox's own volume: it is not in the workspace's git and does not travel in a bundle,
which is right for a login. Tell the owner the tool keeps its sign-in from the next rebuild on.

## Meanwhile

Keep going with the task: proposing is not a blocking handover. Use a workaround if one exists, and say
plainly which parts stay unavailable until the rebuild rather than pretending they work.

The owner approves on the card in the chat (or on the platform's **Sandbox page → Environment card**, which
lists the same drafts). Approving is theirs alone; the rebuild only runs outside this container, and who runs
it depends on where the sandbox lives. On a HOSTED sandbox (a machine the platform runs, `SANDBOX_VM=1` in this container's env) the
owner presses **Rebuild now** on that card and the platform builds it on a machine of its own, which takes a
few minutes and counts against the sandbox's awake hours. On a sandbox the owner runs themselves, the rebuild happens on their machine — and
**if that machine is connected as a device, it is yours to run** once they have approved: `list_sandboxes`
finds this sandbox by its slug there, and `swap_sandbox` rebuilds the approved environment. Doing so restarts
this container and therefore ends your turn, so say that first and get a yes; with no device connected, the
Environment card's own button (or the command it shows) is the owner's. Until the rebuild, the new tools are
not available: say so instead of retrying. A capability that extends the image (VPN, a network disk, a browser
connector, Docker) composes its own fragment automatically: never propose an overlay for those, just point at the same
rebuild.

## Docker Engine problems are the Docker capability's options, not an overlay

Some failures inside the nested engine look like missing tooling and are not: they are switches on the
**Docker capability** (`/capabilities` → Docker). Never propose an overlay for these, and never edit the
user's files to route around them. Ask for the switch on a card instead, which shows the change and what it
costs (a rebuild, a dockerd restart) and applies it with one press: `capabilities request docker --set gpu=on
--why "…"`, or `--set registryMirror=…`, `--set insecureRegistries=…`, `--set addressPool=…`.

- `could not select device driver "nvidia" with capabilities: [[gpu]]` → **GPU access**. Needs an NVIDIA GPU
  and nvidia-container-toolkit on the machine the sandbox runs on, plus a rebuild. Do NOT delete a
  `driver: nvidia` reservation from their compose file to make the error go away: it "works", runs everything
  on CPU, and hides that it did. Say in your `--why` that on a Windows PC this GPU is the owner's DISPLAY GPU,
  shared through WSL: a GPU hang there freezes or powers off their computer (rog, 2026-11-02).

## The host GPU, once GPU access is on

Nothing in the sandbox uses the GPU unless it asks: a command gets it through `gpu-run <command…>` (the whole GPU,
no wall limit unless `--timeout` or the owner's `gpu.timeoutMinutes`), and every other process, browsers
included, runs on the CPU: the sandbox pins OpenGL to llvmpipe and Vulkan to lavapipe for all of them, so a project
needs no `soft.sh` of its own and nothing to unset. `gpu-run --status` says whether the GPU is there, whether GPU
work is paused, and what renders where (a Vulkan program still lands on lavapipe through gpu-run when the image has
no Dozen driver for a WSL GPU). For a real GPU this sandbox cannot give, `gpu-run --on <device> -- <command>` builds
and runs this checkout on one of the owner's computers (`devices exec`, below its own `--help`). The owner
can give it to every agent command instead (settings `gpu.shells: "all"`, the Overview's Host GPU switch). After
the computer reports a GPU reset (LiveKernelEvent 141/117/116, Display 4101) the sandbox pauses GPU work and
gpu-run refuses until the owner resumes it from the Overview: do not route around it by setting
`LD_LIBRARY_PATH=/usr/lib/wsl/lib` yourself. Never start a browser here with GPU flags (`--ignore-gpu-blocklist`,
`--enable-unsafe-webgpu`, `GALLIUM_DRIVER=d3d12`); real GPU rendering of a web page belongs in the owner's own
browser on their device.
- pulls failing or crawling on a metered/air-gapped link → **Registry mirror**.
- `http: server gave HTTP response to HTTPS client` from a LAN registry → **Insecure registries**.
- containers up, but internal/VPN hosts unreachable from them → **Container address pool**. Docker's default
  subnet collides with the route, and the giveaway is that everything else still works.

The last three apply on a dockerd restart (seconds, no rebuild) but the restart stops whatever the engine is
running; the card says so before the press, and your `--why` should say what is running that it would stop. Say which parts of the task are blocked meanwhile.
