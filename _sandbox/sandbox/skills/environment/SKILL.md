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
5. apt hygiene: `RUN apt-get update && apt-get install -y --no-install-recommends <pkgs> && rm -rf /var/lib/apt/lists/*`.

Example (Rust toolchain):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
```

## After writing the file

Keep going with the task: drafting is not a blocking handover. Use a workaround if one exists, and say
plainly which parts stay unavailable until the rebuild rather than pretending they work.

Tell the owner to review and approve the change on the platform's **Sandbox page → Environment card**.
You cannot approve or apply it yourself; the rebuild runs outside this container (the owner pastes a
rebuild command locally, or it applies on the next `intentic deploy apply` for server-managed sandboxes). Until
the rebuild, the new tools are not available: say so instead of retrying. A capability that extends the
image (VPN, a browser connector, Docker) composes its own fragment automatically: never propose an overlay
for those, just point the owner at the same rebuild.

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
