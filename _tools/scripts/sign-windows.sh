#!/usr/bin/env bash
# Authenticode-sign one Windows binary — the thing that makes SmartScreen stop calling our installer
# dangerous, and the one piece of this repo's release that was never wired up at all.
#
#   sign-windows.sh <path-to-exe-or-dll>
#
# Called per-binary by `tauri build` (bundle.windows.signCommand in tauri.conf.json), which hands it the app
# executable, the NSIS installer and the uninstaller in turn, and directly by build-ic.sh and
# build-agent-binaries.sh for the helpers those produce. One script, so "what does signed mean here" has one
# answer.
#
# WHY THERE IS A WARNING AT ALL. Windows shows "Windows protected your PC / More info / Run anyway" for a
# program it cannot attribute to anybody. That is not a virus verdict and no amount of testing makes it go
# away: SmartScreen wants a publisher identity, which means an Authenticode signature from a certificate
# issued to a verified legal entity. Nothing this repo ships has ever carried one — `TAURI_SIGNING_PRIVATE_KEY`
# is the UPDATER's minisign key, which proves an update came from us to the app itself and which SmartScreen
# neither reads nor cares about.
#
# WHY THE SIGNER IS A LINUX TOOL. The Windows installer is cross-built on a Linux runner by cargo-xwin
# (build-desktop.sh), so `signtool.exe` is not available and never will be. Both tools below run on Linux and
# both produce ordinary Authenticode signatures:
#
#   jsign          — the flexible one. Talks to a key that lives in a service rather than in a file: Azure
#                    Trusted Signing, Azure Key Vault, AWS/Google KMS, DigiCert ONE, SSL.com eSigner, or any
#                    PKCS#11 token. This is the shape every certificate sold since June 2023 has, because
#                    CA/B rules now require the private key to stay on certified hardware.
#   osslsigncode   — the simple one. Signs from a PKCS#12 (.pfx) file and a password. Only usable with a
#                    certificate you are allowed to hold as a file, which in practice means a legacy cert or
#                    a test one.
#
# HOW TO TURN IT ON. Set WINDOWS_SIGN_TOOL and the variables its branch reads (below) as masked CI secrets.
# Unset, this script does nothing and says so, which is what keeps `build-desktop.sh <version>` a command any
# developer can run — the same trade the updater key already makes.
#
# WHAT TO BUY is a decision with real trade-offs; docs/windows-code-signing.md lays them out.
set -euo pipefail

# DOES THIS BINARY ALREADY CARRY A SIGNATURE — read off the file itself, with no Windows tool and no
# dependency this image might not have.
#
# An Authenticode signature is appended to the PE and pointed at by data directory entry 4 of the optional
# header, the Certificate Table. A zero entry means unsigned; a non-zero one means there are bytes there.
# That is not a validity check — it does not say the certificate chains, or that the digest matches — and it
# does not need to be: this exists to catch an artifact that never went through the signer at all, which is
# the failure a release can actually have. Validity is the CA's problem and Windows'.
#
# Layout: `e_lfanew` at 0x3C points at "PE\0\0"; the COFF header is 20 bytes; the optional header's magic
# says PE32 (0x10b) or PE32+ (0x20b), which is the only thing that moves the data directories (96 vs 112
# bytes in); entry 4 is 32 bytes past their start, as an 8-byte (offset, size) pair.
u32() { # u32 <file> <byte offset> — little-endian, as decimal
    od -A n -t u4 -j "$2" -N 4 -- "$1" | tr -d ' \n'
}
u16() {
    od -A n -t u2 -j "$2" -N 2 -- "$1" | tr -d ' \n'
}

is_signed_pe() {
    local file="$1" pe magic dirs size
    [ -f "$file" ] || return 1
    pe="$(u32 "$file" 60)"
    [ -n "$pe" ] || return 1
    magic="$(u16 "$file" $((pe + 24)))"
    case "$magic" in
        267) dirs=$((pe + 24 + 96)) ;;  # 0x10b, PE32
        523) dirs=$((pe + 24 + 112)) ;; # 0x20b, PE32+
        *) return 1 ;;
    esac
    size="$(u32 "$file" $((dirs + 32 + 4)))"
    [ -n "$size" ] && [ "$size" -gt 0 ]
}

# `--check <file>` asks that question on its own, which is what the release verification uses to make "we
# sign our installers" a checked fact rather than an intention.
if [ "${1:-}" = "--check" ]; then
    is_signed_pe "${2:?usage: sign-windows.sh --check <file>}"
    exit $?
fi

TARGET="${1:?usage: sign-windows.sh <file>}"

if [ ! -f "$TARGET" ]; then
    echo "error: nothing to sign at $TARGET" >&2
    exit 2
fi

# A TIMESTAMP IS NOT OPTIONAL. Without one, every signature this release makes stops verifying the day the
# certificate expires — which for a downloadable installer means old versions start warning again on a date
# nobody wrote down. With one, an RFC-3161 authority attests that the signing happened while the certificate
# was valid, and the signature outlives it.
TIMESTAMP_URL="${WINDOWS_SIGN_TIMESTAMP_URL:-http://timestamp.digicert.com}"
# SHA-256 throughout: SHA-1 Authenticode has not been accepted by Windows for years.
DIGEST="${WINDOWS_SIGN_DIGEST:-SHA-256}"
NAME="${WINDOWS_SIGN_NAME:-Intentic}"
SITE="${WINDOWS_SIGN_URL:-https://intentic.dev}"

case "${WINDOWS_SIGN_TOOL:-}" in
    "")
        # The unsigned path, and it is a normal one: every local build, every CI build that is not a release.
        # Loud rather than silent, because "why does Windows still warn" is a question worth answering in the
        # build log of the release that did not sign.
        echo "==> not signing $(basename "$TARGET") — WINDOWS_SIGN_TOOL is unset (Windows will warn on this build)"
        exit 0
        ;;

    jsign)
        # The key lives in a service; `WINDOWS_SIGN_STORETYPE` picks which one and the rest is that service's
        # own addressing. Examples, in the shape jsign documents them:
        #   AZURETRUSTEDSIGNING  STORE=https://weu.codesigning.azure.net/  ALIAS=<account>/<profile>
        #   AZUREKEYVAULT        STORE=<vault name>                        ALIAS=<certificate name>
        #   DIGICERTONE          STORE=<api-key>|<cert.p12>|<password>     ALIAS=<certificate alias>
        # STOREPASS is the credential for whichever of those it is, and is the only secret value here.
        : "${WINDOWS_SIGN_STORETYPE:?jsign needs WINDOWS_SIGN_STORETYPE}"
        : "${WINDOWS_SIGN_STORE:?jsign needs WINDOWS_SIGN_STORE}"
        : "${WINDOWS_SIGN_ALIAS:?jsign needs WINDOWS_SIGN_ALIAS}"
        : "${WINDOWS_SIGN_STOREPASS:?jsign needs WINDOWS_SIGN_STOREPASS}"
        echo "==> signing $(basename "$TARGET") with jsign (${WINDOWS_SIGN_STORETYPE})"
        jsign \
            --storetype "$WINDOWS_SIGN_STORETYPE" \
            --keystore "$WINDOWS_SIGN_STORE" \
            --alias "$WINDOWS_SIGN_ALIAS" \
            --storepass "$WINDOWS_SIGN_STOREPASS" \
            --alg "$DIGEST" \
            --tsaurl "$TIMESTAMP_URL" \
            --tsmode RFC3161 \
            --name "$NAME" \
            --url "$SITE" \
            "$TARGET"
        ;;

    osslsigncode)
        # A certificate held as a file. `-in`/`-out` rather than in place: osslsigncode refuses to write its
        # output over its input, and the caller (tauri, or one of the build scripts) expects the path it gave
        # us to be the signed one afterwards.
        : "${WINDOWS_SIGN_PFX:?osslsigncode needs WINDOWS_SIGN_PFX (path to a .pfx)}"
        : "${WINDOWS_SIGN_PFX_PASSWORD:?osslsigncode needs WINDOWS_SIGN_PFX_PASSWORD}"
        echo "==> signing $(basename "$TARGET") with osslsigncode"
        signed="${TARGET}.signed"
        osslsigncode sign \
            -pkcs12 "$WINDOWS_SIGN_PFX" \
            -pass "$WINDOWS_SIGN_PFX_PASSWORD" \
            -h "$(echo "$DIGEST" | tr -d '-' | tr '[:upper:]' '[:lower:]')" \
            -ts "$TIMESTAMP_URL" \
            -n "$NAME" \
            -i "$SITE" \
            -in "$TARGET" \
            -out "$signed"
        mv -f "$signed" "$TARGET"
        ;;

    *)
        echo "error: unknown WINDOWS_SIGN_TOOL '${WINDOWS_SIGN_TOOL}' (expected 'jsign' or 'osslsigncode')" >&2
        exit 2
        ;;
esac

echo "==> signed $(basename "$TARGET")"
