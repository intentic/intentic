// The daemon compares its own baked version (version.ts) to the latest published release so the web can offer
// a non-blocking update, surfaced on /info. Version strings, not registry digests: the sandbox has no Docker
// socket. Source is the PUBLIC npm dist-tag `@intentic/sync@latest`. Every first-party
// package is stamped to the same release version and a release moves the image `:stable` tag onto that version,
// so `@intentic/sync@latest`'s version IS what ghcr.io/intentic/sandbox:stable resolves to.
// Plain global fetch (not the node:https of announce.ts, whose only reason is per-host TLS skip).
//
// The fetch runs on a boot-started background timer (startVersionCheck), NEVER on the /info request path:
// /info reads the cached value synchronously via latestVersion(), so a hot route is never coupled to the
// registry and unit tests (which build the app without running main.ts) see a cold cache and no network.

import { isDevBuild } from "../version.js";

const LATEST_URL = "https://registry.npmjs.org/@intentic/sync/latest";
// A moved release isn't urgent, so refresh cheaply: ~1 request/sandbox/hour to npm.
const REFRESH_MS = 60 * 60_000;

// The last successfully-fetched latest version, or undefined until the first success. A failed refresh leaves
// the previous good value intact rather than clobbering it.
let latest: string | undefined;

// Compare dotted numeric versions (x.y.z). No semver dep in the repo, and release versions are plain numeric.
export const isNewer = (a: string, b: string): boolean => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        if (l !== r) {
            return l > r;
        }
    }
    return false;
};

// A synchronous snapshot of the cache, for the /info handler. Undefined until the first refresh succeeds.
export const latestVersion = (): string | undefined => latest;

// Fetch the latest published version once and update the cache. Never throws — any failure (offline, npm
// down, shape change) keeps the previous value so /info degrades to "no update known". The npm packument's
// `version` is already the plain numeric release version (no `v` prefix to strip).
export const refreshLatestVersion = async (): Promise<void> => {
    try {
        const response = await fetch(LATEST_URL);
        if (response.ok) {
            const body = (await response.json()) as { version?: unknown };
            if (typeof body.version === "string") {
                latest = body.version;
            }
        }
    } catch {
        // Keep the previous cached value.
    }
};

// Boot-time background refresh (main.ts): warm the cache now, then hourly. The interval is unref'd so it never
// holds the event loop open. Started only at boot — tests that build the app directly never trigger a fetch.
//
// A dev build never checks. Its baked version is the unstamped 0.0.0 sentinel, which every published release
// outranks, so the comparison below would report "0.0.0 → x.y.z available" forever — a permanent, unfixable
// update prompt on a sandbox freshly built from the newest source, whose fix (recreate on :stable) would
// actually move it BACKWARDS. Leaving the cache cold is what makes /info omit latest/updateAvailable entirely,
// so both the hub card and the global banner stay hidden; it also spares npm an hourly request per dev sandbox.
export const startVersionCheck = (): { stop: () => void } => {
    if (isDevBuild) {
        return { stop: () => undefined };
    }
    void refreshLatestVersion();
    const timer = setInterval(() => void refreshLatestVersion(), REFRESH_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
};
