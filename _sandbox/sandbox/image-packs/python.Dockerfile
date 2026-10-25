# Optional Python toolchain: uv supplies setup/venv recipes, ruff checks edits, and pyright checks types only when the project venv resolves.
# Keep uv interpreter downloads enabled for project Python pins; UV_LINK_MODE=copy avoids cross-filesystem hardlink warnings.
# Pin tools with CI/catalog updates. pyright's outputjson is parsed as a wire format; incompatible output must report could-not-check.
ENV UV_LINK_MODE=copy
RUN version=0.13.5 \
    && ruff_version=0.17.1 \
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
    npm install -g pyright@1.1.414 && pyright --version
