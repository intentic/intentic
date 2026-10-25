# Headed Chromium/Xvfb plus capture, input and desktop tools; keep display-specific tools out of core.
# Match the Playwright catalog pin to preserve chromium.executablePath(). Remove only the unused headless shell, never the payload cache.
# The browser cache must enter the image; mount only npm's install cache. Restore the shell if a future launch selects its channel.
# Liberation/emoji fonts keep screenshots faithful; large CJK fonts belong in an owner's overlay.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.npm \
    npx --yes playwright@1.64.1 install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb ffmpeg xdotool openbox wmctrl xclip x11-utils fonts-noto-color-emoji fonts-liberation \
    && rm -rf /root/.cache/ms-playwright/chromium_headless_shell-*
