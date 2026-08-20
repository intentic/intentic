// The daemon compares its own baked version (version.ts) to the latest release so the web can offer a
// non-blocking update, surfaced on /info. Version strings, not registry digests: the sandbox has no Docker
// socket.
//
// SOURCE IS GITHUB, ONE LANE. A release ships the moment its pipeline goes green: release-images.sh moves the
// `stable` image tags and ship-stable.sh flips the Release's "latest" flag, both inside the same publish. That
// leaves exactly ONE authoritative pointer — /releases/latest IS what ghcr.io/intentic/sandbox:stable resolves
// to, so the check needs no channel to decide where to look. This used to be two lanes, `beta` reading the
// newest release and `stable` reading the promoted one; the soak between them is gone and so is the split.
// A pinned custom channel reads the same pointer, which is still the honest answer to what it would be offered.
//
// Plain global fetch (not the node:https of announce.ts, whose only reason is per-host TLS skip).
//
// The fetch runs on a boot-started background timer (startVersionCheck), NEVER on the /info request path:
// /info reads the cached value synchronously via latestVersion(), so a hot route is never coupled to GitHub
// and unit tests (which build the app without running main.ts) see a cold cache and no network.

import { isDevBuild } from "../version.js";

export { isNewer } from "@intentic/sandbox-contract";

const LATEST_URL = "https://api.github.com/repos/intentic/intentic/releases/latest";
// A moved release isn't urgent, so refresh cheaply: ~1 request/sandbox/hour against GitHub's 60/hour budget,
// beside release-notes.ts's one.
const REFRESH_MS = 60 * 60_000;

// The last successfully-fetched latest version, or undefined until the first success. A failed refresh leaves
// the previous good value intact rather than clobbering it.
let latest: string | undefined;

// A synchronous snapshot of the cache, for the /info handler. Undefined until the first refresh succeeds.
export const latestVersion = (): string | undefined => latest;

const tagOf = (release: unknown): string | undefined => {
    const tag = (release as { tag_name?: unknown } | undefined)?.tag_name;
    return typeof tag === "string" ? tag.replace(/^v/, "") : undefined;
};

// Fetch the latest released version once and update the cache. Never throws, any failure (offline, GitHub
// down, shape change) keeps the previous value so /info degrades to "no update known".
export const refreshLatestVersion = async (): Promise<void> => {
    try {
        const response = await fetch(LATEST_URL, { headers: { accept: "application/vnd.github+json" } });
        if (response.ok) {
            const version = tagOf(await response.json());
            if (version !== undefined) {
                latest = version;
            }
        }
    } catch {
        // Keep the previous cached value.
    }
};

// Boot-time background refresh (main.ts): warm the cache now, then hourly. The interval is unref'd so it never
// holds the event loop open. Started only at boot, tests that build the app directly never trigger a fetch.
//
// A dev build never checks. Its baked version is the unstamped 0.0.0 sentinel, which every published release
// outranks, so the comparison below would report "0.0.0 → x.y.z available" forever, a permanent, unfixable
// update prompt on a sandbox freshly built from the newest source, whose fix (recreate on :stable) would
// actually move it BACKWARDS. Leaving the cache cold is what makes /info omit latest/updateAvailable entirely,
// so both the hub card and the global banner stay hidden; it also spares GitHub an hourly request per dev
// sandbox.
export const startVersionCheck = (): { stop: () => void } => {
    if (isDevBuild) {
        return { stop: () => undefined };
    }
    void refreshLatestVersion();
    const timer = setInterval(() => void refreshLatestVersion(), REFRESH_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
};
