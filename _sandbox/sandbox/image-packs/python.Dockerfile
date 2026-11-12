# Optional Python toolchain: uv supplies setup/venv recipes, ruff checks edits, and pyright checks types only when the project venv resolves.
# Keep uv interpreter downloads enabled for project Python pins.
# Pin tools with CI/catalog updates. pyright's outputjson is parsed as a wire format; incompatible output must report could-not-check.
#
# ONE CACHE PER KIND, ON THE WORKSPACE VOLUME (2026-11-12). uv's cache sat in /root/.cache, on the container's own
# filesystem, so every venv on a volume had to copy rather than hardlink out of it (UV_LINK_MODE=copy), and agents made a
# cache per tool besides. On shinobi that was five venvs each holding its own 6-7 GB of torch and CUDA wheels, 31 GB of
# per-tool uv caches, and 5.5 GB of cache in the container layer that an update dropped and a kept `.previous` container
# doubled. In .intentic/local/cache/ they sit beside the venvs agents make there, so uv hardlinks (its default) and the
# venvs share one copy of each wheel; that folder is bound from the main checkout into every conversation's namespace,
# outlives updates, and Storage offers each one to clean (toolCaches). A venv in a conversation's checkout is on the
# history volume: uv copies there, as it did before, and says so once per install.
ENV UV_CACHE_DIR=/work/.intentic/local/cache/uv \
    PIP_CACHE_DIR=/work/.intentic/local/cache/pip \
    HF_HOME=/work/.intentic/local/cache/huggingface \
    TORCH_HOME=/work/.intentic/local/cache/torch \
    CUDA_CACHE_PATH=/work/.intentic/local/cache/cuda
RUN version=0.13.6 \
    && ruff_version=0.17.3 \
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
