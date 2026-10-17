# Meta's Muse Code CLI, `muse`, which the daemon spawns as `muse serve` to serve a turn on the Muse loop over the Muse
# Session Protocol (runtimes/muse/). Meta publishes it as one native binary per platform (~350 MB), each listed with its
# sha256 and size in a per-version manifest on Meta's download host: the same files dev.meta.ai/install.sh fetches.
#
# CLOSED SOURCE, like the Cursor and Devin packs, and a pack for the same reason: Meta grants no right to redistribute
# the binary, so it must never ride a published image. Deliberately absent from image-packs/profiles.json. A turn on the
# Muse loop installs this exact pin into the engine store on demand; once a Meta account is connected, the overlay
# rebuild the owner approves bakes the same copy into their own image (runtimes/minted/minted-provider.ts `packs`).
#
# ponytail: engines.json blesses this pin; bump-engines.mjs moves it together with @muse-code/sdk in pnpm-workspace.yaml.
RUN set -eu; version=1.4.10-R6427.1; \
    case "$(uname -m)" in \
        x86_64) platform=x86_linux ;; \
        aarch64) platform=aarch64_linux ;; \
        *) echo "Muse Code has no Linux build for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    base="https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${version}"; \
    curl -fsSL "${base}&file=manifest.json" -o /tmp/muse-manifest.json; \
    url="$(node -p "require('/tmp/muse-manifest.json').artifacts['${platform}'].url")"; \
    sum="$(node -p "require('/tmp/muse-manifest.json').artifacts['${platform}'].checksum")"; \
    curl -fsSL "${url}" -o /usr/local/bin/muse; \
    echo "${sum}  /usr/local/bin/muse" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/muse; \
    rm -f /tmp/muse-manifest.json; \
    muse --version
