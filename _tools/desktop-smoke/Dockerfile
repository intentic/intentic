# Bare desktop smoke host: do not preinstall GTK/WebKit/appindicator; deb installation must resolve its own Depends.
# Only the AppImage tier adds libraries intentionally excluded from its bundle, so missing bundled libraries remain detectable.
# Match the Debian release in _tools/ci-base/Dockerfile when bumping it; an older host can fail before the tested app starts.
# verify-desktop-bundle.sh checks ELF imports and package metadata against the declared glibc floor.
FROM debian:trixie-20260918-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

# Xvfb + dbus: a Tauri app is a GTK app, and GTK needs both a display and a session bus. xdg-utils carries
# xdg-open and xdg-mime — the real OS path a deep link takes, and the thing the .desktop MIME entry feeds.
# desktop-file-utils carries update-desktop-database, which is what turns an installed .desktop entry's
# MimeType line into a handler the OS can look up; on a real Debian it arrives as a dpkg trigger and runs
# itself. Without it `xdg-mime query default` answers nothing however correct the package is, and the deep
# link — the entire channel from the SPA into the app — reads as broken when only the test host is.
# libglib2.0-bin carries `gio`, which is what xdg-open delegates the lookup to on every desktop this app ships
# to (see the XDG_CURRENT_DESKTOP note in smoke.sh for why the delegation matters here).
# xdotool + x11-utils are how the test observes windows: no window manager, so it reads the X tree directly.
# AT-SPI activates the confirmation's named button independently of keyboard focus.
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        dbus-x11 \
        xdg-utils \
        desktop-file-utils \
        libglib2.0-bin \
        x11-utils \
        xdotool \
        procps \
        ca-certificates \
        python3 \
        python3-pyatspi \
        at-spi2-core \
    && rm -rf /var/lib/apt/lists/*

# A stub for the hosted SPA. The install tier asserts that the workspace window OPENS and points at its
# configured origin, not that the real app renders — pointing INTENTIC_APP_URL here keeps the tier hermetic
# (no network, no app.intentic.dev) and deterministic. The nightly tier points it at the real local SPA.
RUN mkdir -p /srv/stub && printf '<!doctype html><title>stub workspace</title><h1>stub</h1>\n' > /srv/stub/index.html

COPY smoke.sh /usr/local/bin/smoke.sh
# The second tier this image serves: does the app replace ITSELF (update.sh). Same bare host, same display, and
# reached by overriding the entrypoint rather than as a third `smoke.sh` kind — it stages two builds and a
# local release endpoint, which shares nothing with the install/deep-link flow but the container around it.
COPY update.sh /usr/local/bin/update.sh
# The third, reached the same way: what the installed app does when intentic is down (outage.sh), with the stub that
# plays the workspace's address and keeps the only record of what the window asked it for.
COPY outage.sh /usr/local/bin/outage.sh
COPY outage_stub.py /usr/local/bin/outage_stub.py
RUN chmod +x /usr/local/bin/smoke.sh /usr/local/bin/update.sh /usr/local/bin/outage.sh /usr/local/bin/outage_stub.py

# The artifact under test is copied to /artifacts by the runner rather than baked in, so one image serves every
# build. Created here so the copy lands in a directory that already exists whichever way the runner fills it.
RUN mkdir -p /artifacts

ENTRYPOINT ["/usr/local/bin/smoke.sh"]
