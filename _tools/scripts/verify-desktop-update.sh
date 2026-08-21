#!/usr/bin/env bash
# Prove the desktop app keeps its own update promise: IT MOVES ITSELF ONTO THE RELEASE THAT WAS PUBLISHED, AND
# THE WORST OUTCOME IS THE APP YOU ALREADY HAD.
#
#   verify-desktop-update.sh
#
# The sibling of verify-update-survival.sh, which does exactly this for a sandbox. That one exists because the
# update card's claims — your files survive, one command rolls it back — are load-bearing product promises that
# nothing per-push exercised. This one exists for a sharper reason: the desktop app's equivalent claim was
# false. Every release up to and including v1.213.0 drew "Intentic X is available: it installs the next time
# you quit" over a crate containing no install path at all, and no tier anywhere could have noticed, because
# the whole mechanism was one `check()` and an event.
#
# THE DRILL, hermetic, on the bare Debian the other desktop tiers use:
#
#   1. mint a throwaway minisign pair — the release key is not on this machine and must not be
#   2. build TWO AppImages, 9.9.9 and 9.9.10, both carrying that pubkey and an endpoint on loopback
#   3. write the manifest 9.9.10 as a release would, signed with the throwaway key
#   4. run 9.9.9 in the container and let it alone
#        → it checks, downloads, and verifies the signature with nobody pressing anything
#        → closing the window installs it
#        → the file on disk is now 9.9.10, byte for byte
#        → it starts again, and reports itself current against the same manifest
#
# WHY IT BUILDS ITS OWN APP RATHER THAN TESTING THE SHIPPED ARTIFACT. Two of this chain's inputs are compiled
# in — the pubkey and the endpoint — and the alternative to overriding them at BUILD time is an environment
# variable that overrides them at RUN time, in every copy that ships. This app's whole design is about not
# having doors like that (see setup_link.rs on why even `intentic://update` is refused from outside), and a
# test hook is a door. What the released artifact does on a real machine is verify-desktop-install.sh's job and
# @intentic/desktop-smoke-windows'; what this owns is the mechanism.
#
# Costs two release-profile Tauri builds. Nightly, not per-push.
set -euo pipefail
. "$(dirname "$0")/repo-root.sh"

ROOT="$(repo_root)"
APP="$ROOT/_editor/desktop-app"
CONTEXT="$ROOT/_tools/desktop-smoke"
IMAGE="${DESKTOP_SMOKE_IMAGE:-intentic-desktop-smoke:local}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Two versions nothing else could produce, so an artifact from another build cannot be mistaken for one of
# these — and high enough that the app under test can never consider itself newer than the manifest.
FROM_VERSION=9.9.9
TO_VERSION=9.9.10
# Loopback inside the smoke container, where update.sh serves /artifacts. Plain HTTP, which the plugin refuses
# outright unless told — `dangerousInsecureTransportProtocol` below is that permission, and it is set on THESE
# builds and nowhere near a shipped one. Terminating TLS on a throwaway certificate would buy nothing: what
# guards an update is the minisign signature on the artifact, which this tier verifies for real.
ENDPOINT="http://127.0.0.1:8098/latest.json"

echo "==> minting a throwaway signing key"
(cd "$APP" && pnpm exec tauri signer generate --ci -f -p "" -w "$WORK/updater.key" >/dev/null)
# Both files the signer writes are ALREADY base64 — the same encoding tauri.conf.json's committed `pubkey`
# carries, which is why this is read verbatim rather than encoded again.
PUBKEY="$(tr -d '\n' <"$WORK/updater.key.pub")"
export TAURI_SIGNING_PRIVATE_KEY="$(tr -d '\n' <"$WORK/updater.key")"
# The signer prints "Signing without password." and then BLOCKS on a prompt when this is absent — a build that
# hangs rather than one that fails. The same trap build-desktop.sh documents.
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

# The launcher UI once, for both builds — `tauri build` would otherwise re-run vue-tsc and vite per pass over
# bytes the first pass already produced, which is the same saving build-desktop.sh makes for the same reason.
bash "$ROOT/_tools/scripts/stage-desktop-scripts.sh"
echo "==> building the launcher UI"
pnpm --filter @intentic/desktop-app build

# linuxdeploy is itself an AppImage and FUSE-mounts by default; NO_STRIP because its bundled strip predates
# RELR relocations. Both are build-desktop.sh's, and needed here for the same container-shaped reasons.
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=true

TARGET_DIR="${CARGO_TARGET_DIR:-$APP/src-tauri/target}"

build_at() {
    local version="$1" out="$2"
    echo "==> building the AppImage at v${version}"
    # INTENTIC_VERSION is what reaches RUST (build.rs); the --config override is what stamps the bundle and is
    # where the two staged inputs go in. Both have to say the same version or the app would compare a manifest
    # against a number its own binary does not carry.
    INTENTIC_VERSION="$version" pnpm --filter @intentic/desktop-app exec tauri build \
        --config "{\"version\":\"${version}\",\"build\":{\"beforeBuildCommand\":\"\"},\"plugins\":{\"updater\":{\"pubkey\":\"${PUBKEY}\",\"endpoints\":[\"${ENDPOINT}\"],\"dangerousInsecureTransportProtocol\":true}}}" \
        --bundles appimage
    cp "$TARGET_DIR"/release/bundle/appimage/*.AppImage "$out"
    chmod +x "$out"
}

rm -rf "$TARGET_DIR/release/bundle"
build_at "$FROM_VERSION" "$WORK/from.AppImage"
rm -rf "$TARGET_DIR/release/bundle"
build_at "$TO_VERSION" "$WORK/to.AppImage"

# The manifest, in exactly the shape build-desktop.sh writes for a real release — the signature is the .sig the
# bundler produced beside the artifact, which is what the app verifies against the pubkey compiled into it.
SIGNATURE="$(cat "$TARGET_DIR"/release/bundle/appimage/*.AppImage.sig)"
cat >"$WORK/latest.json" <<MANIFEST
{
    "version": "${TO_VERSION}",
    "notes": "the update tier's own release",
    "pub_date": "2026-01-01T00:00:00Z",
    "platforms": {
        "linux-x86_64": { "signature": "${SIGNATURE}", "url": "http://127.0.0.1:8098/to.AppImage" }
    }
}
MANIFEST

echo "==> building the smoke image"
docker build -q -t "$IMAGE" "$CONTEXT" >/dev/null

# A name unique per run, for the reason verify-desktop-install.sh spells out: container names are global to the
# daemon, and a fixed one is a name a concurrent job force-removes out from under this one.
CONTAINER="intentic-desktop-update-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# create + cp + start rather than a bind mount: in CI the daemon is a separate dind service that has never seen
# this job's checkout, so a mount would silently be an empty directory (verify-desktop-install.sh, same note).
docker create --name "$CONTAINER" --entrypoint /usr/local/bin/update.sh "$IMAGE" >/dev/null
docker cp "$WORK/from.AppImage" "$CONTAINER:/artifacts/from.AppImage"
docker cp "$WORK/to.AppImage" "$CONTAINER:/artifacts/to.AppImage"
docker cp "$WORK/latest.json" "$CONTAINER:/artifacts/latest.json"
docker start -a "$CONTAINER"
