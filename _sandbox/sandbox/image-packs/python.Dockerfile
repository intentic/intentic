# THE PYTHON TOOLCHAIN THE DAEMON ITSELF CALLS. python3 is in the base image (with pip, venv, PyYAML, Pillow)
# because half of all sessions shell into it whatever the project is written in; these three are here because
# product features name them by binary, and a feature whose binary is off PATH is a feature that silently does
# not exist:
#   uv      — the manager the setup recipes resolve `pyproject.toml` and `uv.lock` to (workspace/deps/classify.ts,
#             `uv sync`). The daemon refuses to offer a recipe whose manager is not on PATH (setupStateOf), so
#             without uv every modern python repo dropped into /work reports `unsupported` and nothing in the
#             product can install it. It is also what BUILDS the `.venv` that isolated turns mirror
#             (@intentic/constants/mirror-roots), which is why the recipes name one path and one name.
#   ruff    — the per-edit check for a `.py` file (agent/verification/python/python-diagnostics.ts). It answers a file
#             in milliseconds and needs no environment at all, which is what lets the post-edit hook run it on
#             every edit the way the TypeScript half runs tsgo.
#   pyright — the type half of that check, and the only one of the two that can see a wrong attribute or a bad
#             call. The hook runs it ONLY where the project's `.venv` resolves, for the same reason the node
#             gate exists: with no environment to resolve imports against it reports every import as missing,
#             which is confident, specific, wrong feedback that costs the model real reasoning to distrust.
#
# A PACK RATHER THAN THE BASE IMAGE. ~90 MB of toolchain that only a python project ever uses: the core profile
# stays the floor it claims to be, every published `standard` image carries this (image-packs/profiles.json),
# and a core sandbox that later meets a python repo can compose the same fragment into its overlay. The rule
# that keeps shellcheck out of the base ("a linter agents don't run on themselves") does not reach ruff and
# pyright: the DAEMON runs these, unprompted, on every python edit.
#
# UV DOWNLOADING AN INTERPRETER IS LEFT ON (its default). A project pinning a `requires-python` this image does
# not ship then works instead of failing at sync, and the download lands in uv's own cache rather than in the
# image. `UV_LINK_MODE=copy` is the deliberate one: uv hardlinks from that cache into the target `.venv`, the
# cache and /work are different filesystems in every sandbox, and the fallback it takes anyway prints a warning
# on every install that reads as a fault.
# ponytail: uv and ruff are pinned for reproducible images, not held in lockstep with anything — bump freely.
# pyright's `--outputjson` is a wire format the daemon parses (python-diagnostics.ts): its integration test
# fails on a bump that changes the shape, and the parser reports "could not check" rather than "clean" if one
# ever does.
ENV UV_LINK_MODE=copy
RUN version=0.12.10 \
    && ruff_version=0.16.6 \
    && case "$(dpkg --print-architecture)" in \
        amd64) triple=x86_64-unknown-linux-gnu ;; \
        arm64) triple=aarch64-unknown-linux-gnu ;; \
        *) echo "python pack: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${version}/uv-${triple}.tar.gz" \
        | tar -xz -C /usr/local/bin --strip-components=1 "uv-${triple}/uv" "uv-${triple}/uvx" \
    && curl -fsSL "https://github.com/astral-sh/ruff/releases/download/${ruff_version}/ruff-${triple}.tar.gz" \
        | tar -xz -C /usr/local/bin --strip-components=1 "ruff-${triple}/ruff" \
    && uv --version && uvx --version && ruff --version
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pyright@1.1.413 && pyright --version
