#!/usr/bin/env bash
# Publish a release's installer ISO and VM disk to the R2 bucket intentic.dev/os serves (the site worker's OS_DOWNLOADS
# binding). Writes os/<version>/intentic-os-<version>-x86_64.iso, ...-x86_64.qcow2 and SHA256SUMS, then os/stable.json
# last, so the manifest the worker reads never names a file that is not up yet; then deletes all but the newest three
# versions. Needs the AWS CLI, R2_ACCOUNT_ID, and an R2 access key with write on the bucket in AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY (AWS_DEFAULT_REGION=auto). os.yml runs it once the ISO installed and booted.
#
#   publish-download.sh --version 1.422.0 --iso install.iso --qcow2 disk.qcow2 [--bucket intentic-os] [--keep 3]
set -euo pipefail

VERSION=""
ISO=""
QCOW2=""
BUCKET="${R2_OS_BUCKET:-intentic-os}"
KEEP=3
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --iso) ISO="$2"; shift 2 ;;
        --qcow2) QCOW2="$2"; shift 2 ;;
        --bucket) BUCKET="$2"; shift 2 ;;
        --keep) KEEP="$2"; shift 2 ;;
        -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
        *) echo "publish-download.sh: unknown argument $1 (see --help)" >&2; exit 2 ;;
    esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "publish-download.sh: --version is a release version, like 1.422.0" >&2; exit 2; }
for file in "$ISO" "$QCOW2"; do
    [ -f "$file" ] || { echo "publish-download.sh: no file at '$file'" >&2; exit 2; }
done
for name in R2_ACCOUNT_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    if [ -z "${!name:-}" ]; then
        echo "publish-download.sh: $name is not set. The ISO built and installed, but intentic.dev/os keeps serving the" >&2
        echo "version before. CLOUDFLARE_ACCOUNT_ID, R2_OS_ACCESS_KEY_ID and R2_OS_SECRET_ACCESS_KEY are the repository" >&2
        echo "secrets os.yml reads; the key needs Object Read & Write on the $BUCKET bucket." >&2
        exit 1
    fi
done

s3() { aws s3 --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" "$@"; }

iso_name="intentic-os-${VERSION}-x86_64.iso"
qcow2_name="intentic-os-${VERSION}-x86_64.qcow2"
prefix="os/${VERSION}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

iso_sha="$(sha256sum "$ISO" | cut -d' ' -f1)"
qcow2_sha="$(sha256sum "$QCOW2" | cut -d' ' -f1)"
printf '%s  %s\n%s  %s\n' "$iso_sha" "$iso_name" "$qcow2_sha" "$qcow2_name" > "$work/SHA256SUMS"

# Immutable: a version's files never change once written, so browsers and Cloudflare may keep them for good.
immutable="public, max-age=31536000, immutable"
s3 cp "$ISO" "s3://${BUCKET}/${prefix}/${iso_name}" --content-type application/x-iso9660-image --cache-control "$immutable" --no-progress
s3 cp "$QCOW2" "s3://${BUCKET}/${prefix}/${qcow2_name}" --content-type application/octet-stream --cache-control "$immutable" --no-progress
s3 cp "$work/SHA256SUMS" "s3://${BUCKET}/${prefix}/SHA256SUMS" --content-type "text/plain; charset=utf-8" --cache-control "$immutable" --no-progress

jq -n \
    --arg version "$VERSION" \
    --arg date "$(date -u +%F)" \
    --arg iso "$iso_name" --argjson isoSize "$(stat -c %s "$ISO")" --arg isoSha "$iso_sha" \
    --arg qcow2 "$qcow2_name" --argjson qcow2Size "$(stat -c %s "$QCOW2")" --arg qcow2Sha "$qcow2_sha" \
    '{
        version: $version,
        date: $date,
        channel: "stable",
        edition: "server",
        files: {
            iso: { name: $iso, size: $isoSize, sha256: $isoSha },
            qcow2: { name: $qcow2, size: $qcow2Size, sha256: $qcow2Sha }
        }
    }' > "$work/stable.json"
s3 cp "$work/stable.json" "s3://${BUCKET}/os/stable.json" --content-type application/json --cache-control "no-cache" --no-progress
echo "publish-download.sh: os/stable.json now names ${VERSION}"

# Older versions: everything past the newest $KEEP, by version order. The one just written is always kept.
mapfile -t versions < <(s3 ls "s3://${BUCKET}/os/" | awk '$1 == "PRE" { sub("/$", "", $2); print $2 }' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -r)
for old in "${versions[@]:$KEEP}"; do
    [ "$old" = "$VERSION" ] && continue
    echo "publish-download.sh: removing os/${old}/"
    s3 rm "s3://${BUCKET}/os/${old}/" --recursive --only-show-errors
done
