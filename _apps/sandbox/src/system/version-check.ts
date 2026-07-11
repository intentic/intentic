// The daemon compares its own baked version (version.ts) to the latest published release so the web can offer
// a non-blocking update, surfaced on /info. Version strings, not registry digests: the sandbox has no Docker
// socket. Source is the GitLab Releases API `permalink/latest` — a release moves the image `:stable` tag onto
// the new version, so the latest release's version IS what registry.gitlab.com/radarsu/intentic/sandbox:stable
// resolves to. Plain global fetch (not the node:https of announce.ts, whose only reason is per-host TLS skip).
//
// The fetch runs on a boot-started background timer (startVersionCheck), NEVER on the /info request path:
// /info reads the cached value synchronously via latestVersion(), so a hot route is never coupled to GitLab
// and unit tests (which build the app without running main.ts) see a cold cache and no network.

const LATEST_URL = "https://gitlab.com/api/v4/projects/radarsu%2Fintentic/releases/permalink/latest";
// A moved release isn't urgent, so refresh cheaply: ~1 request/sandbox/hour to GitLab.
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

// Fetch the latest release version once and update the cache. Never throws — any failure (offline, GitLab
// down, shape change) keeps the previous value so /info degrades to "no update known". The release tag is
// `v${version}` (tagFormat), so strip the leading `v`.
export const refreshLatestVersion = async (): Promise<void> => {
    try {
        const response = await fetch(LATEST_URL);
        if (response.ok) {
            const body = (await response.json()) as { tag_name?: unknown };
            if (typeof body.tag_name === "string") {
                latest = body.tag_name.replace(/^v/, "");
            }
        }
    } catch {
        // Keep the previous cached value.
    }
};

// Boot-time background refresh (main.ts): warm the cache now, then hourly. The interval is unref'd so it never
// holds the event loop open. Started only at boot — tests that build the app directly never trigger a fetch.
export const startVersionCheck = (): { stop: () => void } => {
    void refreshLatestVersion();
    const timer = setInterval(() => void refreshLatestVersion(), REFRESH_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
};
