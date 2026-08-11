#!/usr/bin/env bash
# Assemble and package the VSCode extension: build the app + the daemon, deploy the daemon as the extension's
# engine tree, prune what the local profile can never use, smoke-boot the result, and pack a
# platform-specific .vsix into _editor/vscode/dist-bin/.
#
# Platform-specific because the engine tree carries natives (node-pty, @ast-grep, the claude CLI binary), so
# one .vsix per --target, assembled on (or for) a matching machine. The smoke boot runs only when the target
# matches the build host — a cross-assembled tree can be packed here but only its own platform can prove it.
#
#   bash _tools/scripts/build-vscode-extension.sh 1.140.0 linux-x64
set -euo pipefail
VERSION="${1:?usage: build-vscode-extension.sh <version> <vsce-target>}"
TARGET="${2:?usage: build-vscode-extension.sh <version> <vsce-target> (e.g. linux-x64, darwin-arm64, win32-x64)}"
. "$(dirname "$0")/repo-root.sh"
cd "$(repo_root)"

EXT=_editor/vscode
ENGINE="$EXT/engine"

# 1. Build the closure: the app the panels load, the daemon the engine tree deploys, the extension host code.
# The skip is for environments whose closure is already built and whose injected-deps sync cannot run (an
# agent worktree's node_modules mirror) — CI never sets it.
if [ -z "${INTENTIC_VSCE_SKIP_TURBO:-}" ]; then
  pnpm turbo run build --filter=./_editor/web --filter=./_sandbox/sandbox --filter=./_editor/vscode
fi

# 2. The app assets — the SAME dist the platform deploys; the posture difference is injected per webview.
node "$EXT/scripts/copy-app.mjs"

# 3. The engine tree: the daemon package with its production node_modules, self-contained. Hoisted layout —
# real files, no symlinks — because vsce's zip writer cannot package pnpm's symlink forest.
rm -rf "$ENGINE"
pnpm --filter @intentic/sandbox --config.node-linker=hoisted deploy --prod "$ENGINE"

# 4. Prune what the LOCAL profile can never use (the same post-deploy prune pattern as prepare-image-trees.sh,
#    which documents the first two):
#    - onnxruntime-web: transformers' browser backend, unreachable from the node dist.
#    - @openai/codex: the ~350 MiB vendored CLI — locally Codex resolves from the user's own PATH, with the
#      clean missing-binary story (codex-path.ts).
#    - onnxruntime-node: iq's semantic tier. The extension ships no embedding models, so the tier could never
#      run — without the runtime it degrades to keyword search with a warn, proven by the smoke boot below.
#    - node-pty's FOREIGN prebuilds: each target keeps only its own.
rm -rf "$ENGINE"/node_modules/onnxruntime-web
rm -rf "$ENGINE"/node_modules/onnxruntime-node
# The vendored CLI is @openai/codex plus one platform binary package per OS (@openai/codex-<platform>);
# @openai/codex-sdk stays — it is the version anchor codex-path.ts resolves through.
for dir in "$ENGINE"/node_modules/@openai/codex "$ENGINE"/node_modules/@openai/codex-*; do
  [ -e "$dir" ] || continue
  [ "$(basename "$dir")" = "codex-sdk" ] && continue
  rm -rf "$dir"
done
case "$TARGET" in
  linux-*) keep="" ;; # linux builds its binding at deploy time (build/Release); every prebuild dir is foreign
  darwin-x64) keep="darwin-x64" ;;
  darwin-arm64) keep="darwin-arm64" ;;
  win32-x64) keep="win32-x64" ;;
  win32-arm64) keep="win32-arm64" ;;
  *) echo "unknown target $TARGET" >&2; exit 1 ;;
esac
for dir in "$ENGINE"/node_modules/node-pty/prebuilds/*; do
  [ -d "$dir" ] || continue
  [ "$(basename "$dir")" = "$keep" ] || rm -rf "$dir"
done
find "$ENGINE/node_modules" -xtype l -delete

# 5. The marketplace listing's license file (vsce refuses a tree without one).
cp LICENSE "$EXT/LICENSE"

# 6. Smoke-boot the assembled engine in its local profile over a scratch folder — only where the target IS
#    this machine. /health answering with the local profile proves the tree is complete after the prunes.
host_target=""
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) host_target="linux-x64" ;;
  Linux-aarch64) host_target="linux-arm64" ;;
  Darwin-x86_64) host_target="darwin-x64" ;;
  Darwin-arm64) host_target="darwin-arm64" ;;
esac
if [ "$TARGET" = "$host_target" ]; then
  smoke="$(mktemp -d)"
  mkdir -p "$smoke/work"
  git -C "$smoke/work" init -q -b main
  port="$((20000 + RANDOM % 20000))"
  SANDBOX_PROFILE=local WORKSPACE_ROOT="$smoke/work" HISTORY_ROOT="$smoke/history" SANDBOX_PORT="$port" \
    WEB_ORIGIN=http://127.0.0.1:1 CONNECT_TOKEN= SANDBOX_PUBLIC_URL= PLATFORM_URL= TRANSLATOR_URL= \
    GOOGLE_CLIENT_ID= SYNC_PAIR_TOKEN= HOST_PAIR_TOKEN= \
    node "$ENGINE/dist/main.js" >"$smoke/boot.log" 2>&1 &
  engine_pid="$!"
  ok=""
  for _ in $(seq 1 60); do
    if health="$(curl -fsS -m 2 "http://127.0.0.1:$port/health" 2>/dev/null)" && [ "${health#*\"profile\":\"local\"}" != "$health" ]; then
      ok=1
      break
    fi
    sleep 1
  done
  kill "$engine_pid" 2>/dev/null || true
  if [ -z "$ok" ]; then
    echo "engine smoke boot FAILED — tail of $smoke/boot.log:" >&2
    tail -40 "$smoke/boot.log" >&2
    exit 1
  fi
  rm -rf "$smoke"
  echo "engine smoke boot ok (local profile answered /health)"
else
  echo "skipping smoke boot: target $TARGET is not this machine ($host_target)"
fi

# 7. Stamp and pack. vsce reads the version from package.json; --no-dependencies because the extension host
#    bundle is dependency-free and the engine carries its own node_modules inside the tree. vsce is a pinned
#    devDependency of the extension package (never dlx — pnpm's build-script approval prompt would hang CI).
pnpm --dir "$EXT" version "$VERSION" --no-git-tag-version --no-git-checks --allow-same-version >/dev/null
mkdir -p "$EXT/dist-bin"
vsce="$EXT/node_modules/.bin/vsce"
[ -x "$vsce" ] || { echo "vsce not installed — run pnpm install (it is a devDependency of $EXT)" >&2; exit 1; }
(cd "$EXT" && ./node_modules/.bin/vsce package --target "$TARGET" --no-dependencies --out "dist-bin/intentic-$TARGET-$VERSION.vsix")
ls -lh "$EXT/dist-bin/"
