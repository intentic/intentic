// The daemon compares its own baked version (version.ts) to the latest release OF ITS OWN CHANNEL so the web
// can offer a non-blocking update, surfaced on /info. Version strings, not registry digests: the sandbox has
// no Docker socket.
//
// SOURCE IS GITHUB, BY LANE. Every release publishes the `beta` image tags immediately; the `stable` tags move
// only when the promote step (_tools/scripts/promote-stable.sh, nightly) decides a release has soaked — and
// that same step is what flips the GitHub Release's "latest" flag. So the two lanes have two authoritative
// pointers on one API: /releases/latest IS what ghcr.io/intentic/sandbox:stable resolves to, and the newest
// release in the list IS what :beta resolves to. A beta-family channel (`beta`, `core-beta`) reads the second;
// every other channel — `stable`, `core-stable`, the pre-channel empty string — reads the first, which is also
// the honest answer for a pinned custom channel: the promoted release is the one it would be offered.
//
// Plain global fetch (not the node:https of announce.ts, whose only reason is per-host TLS skip).
//
// The fetch runs on a boot-started background timer (startVersionCheck), NEVER on the /info request path:
// /info reads the cached value synchronously via latestVersion(), so a hot route is never coupled to GitHub
// and unit tests (which build the app without running main.ts) see a cold cache and no network.

import { isDevBuild } from "../version.js";

export { isNewer } from "@intentic/sandbox-contract";

const STABLE_URL = "https://api.github.com/repos/intentic/intentic/releases/latest";
// Newest release, promoted or not — what the beta lane runs. Drafts are invisible unauthenticated, and this
// repo publishes no prereleases, so item one is the lane's head.
const BETA_URL = "https://api.github.com/repos/intentic/intentic/releases?per_page=1";
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

// Fetch the channel's latest version once and update the cache. Never throws — any failure (offline, GitHub
// down, shape change) keeps the previous value so /info degrades to "no update known".
export const refreshLatestVersion = async (channel: string): Promise<void> => {
    const beta = channel.endsWith("beta");
    try {
        const response = await fetch(beta ? BETA_URL : STABLE_URL, { headers: { accept: "application/vnd.github+json" } });
        if (response.ok) {
            const body: unknown = await response.json();
            const version = tagOf(beta ? (body as unknown[])[0] : body);
            if (version !== undefined) {
                latest = version;
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
// so both the hub card and the global banner stay hidden; it also spares GitHub an hourly request per dev
// sandbox.
export const startVersionCheck = (channel: string): { stop: () => void } => {
    if (isDevBuild) {
        return { stop: () => undefined };
    }
    void refreshLatestVersion(channel);
    const timer = setInterval(() => void refreshLatestVersion(channel), REFRESH_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
};
