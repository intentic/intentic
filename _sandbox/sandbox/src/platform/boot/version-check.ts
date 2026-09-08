// Compares the daemon's baked version to the latest GitHub release so /info can offer a non-blocking update; version
// strings, not registry digests, since the sandbox has no Docker socket. /releases/latest is the one authoritative
// pointer, so there is no channel to pick. The fetch runs on a background timer, never on the /info request path.

import { isDevBuild } from "../../version.js";

export { isNewer } from "@intentic/sandbox-contract";

const LATEST_URL = "https://api.github.com/repos/intentic/intentic/releases/latest";
// A moved release isn't urgent: about one request per sandbox per hour, beside release-notes.ts's own.
const REFRESH_MS = 60 * 60_000;

// Last successfully-fetched latest version, or undefined until the first success; a failed refresh leaves it alone.
let latest: string | undefined;

// Synchronous snapshot of the cache for the /info handler; undefined until the first refresh succeeds.
export const latestVersion = (): string | undefined => latest;

const tagOf = (release: unknown): string | undefined => {
    const tag = (release as { tag_name?: unknown } | undefined)?.tag_name;
    return typeof tag === "string" ? tag.replace(/^v/, "") : undefined;
};

// Fetches the latest released version once and updates the cache. Never throws: any failure keeps the previous value,
// so /info degrades to "no update known".
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
        // Keeps the previous cached value on failure.
    }
};

// Boot-time background refresh: warms the cache now, then hourly, unref'd so it never holds the event loop open. A dev
// build never checks, since its unstamped 0.0.0 baked version would report a permanent, unfixable update prompt.
export const startVersionCheck = (): { stop: () => void } => {
    if (isDevBuild) {
        return { stop: () => undefined };
    }
    void refreshLatestVersion();
    const timer = setInterval(() => void refreshLatestVersion(), REFRESH_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
};
