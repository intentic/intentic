# Headed Chromium/Xvfb plus capture, input and desktop tools; keep display-specific tools out of core.
# Match the Playwright catalog pin to preserve chromium.executablePath(). Remove only the unused headless shell, never the payload cache.
# The browser cache must enter the image; mount only npm's install cache. Restore the shell if a future launch selects its channel.
# Liberation/emoji fonts keep screenshots faithful; fonts-noto-cjk draws Chinese, Japanese and Korean pages, which showed
# boxes (2026-11-19: the person's own window is a browser they read the web in, not only a test target; rejected
# leaving CJK to an owner's overlay, which no owner knew to add).
# libxkbcommon-x11-0: winit (Bevy, most Rust games and GUIs) dlopens it for keyboard input on X11, and exits without it
# before opening a window, so a repo's Start that opens a window on this desktop needs it.
# For castd, the media daemon the castd pack bakes (_sandbox/castd): the stock libraries it links (libyuv0, libopus0,
# libpulse0, and libx264-164, the fallback for its patched x264), PulseAudio for each window's sound (a null sink per
# display, browser/media/cast-audio.ts) and xsettingsd for the window's pixel ratio (browser/media/screen-fit.ts). Here
# rather than in the castd pack, which is bake-only, so a browser added by an overlay is ready for castd when an image
# brings it, and runs as before without.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,target=/root/.npm \
    npx --yes playwright@1.64.1 install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb ffmpeg xdotool openbox wmctrl xclip x11-utils libxkbcommon-x11-0 fonts-noto-color-emoji fonts-liberation \
        fonts-noto-cjk libyuv0 libopus0 libpulse0 libx264-164 pulseaudio pulseaudio-utils xsettingsd \
    && rm -rf /root/.cache/ms-playwright/chromium_headless_shell-*
