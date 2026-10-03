// Offers a release only after the moving stable image points at that release's published image. Both registry
// requests run on the background timer, never on the /info request path; no Docker socket is needed.

import { isDevBuild } from "../../version.js";

export { isNewer } from "@intentic/sandbox-contract";

const LATEST_URL = "https://api.github.com/repos/intentic/intentic/releases/latest";
const TOKEN_URL = "https://ghcr.io/token?scope=repository:intentic/sandbox:pull&service=ghcr.io";
const MANIFEST_URL = "https://ghcr.io/v2/intentic/sandbox/manifests/";
const MANIFEST_ACCEPT = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";
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

// Whether `:stable`, the tag every update pulls, already names this release's image. The release moves `:stable` before
// it flags the GitHub release latest (ship-stable.sh), but a sandbox offered a version `ic` could not yet pull restarted
// onto the image it had and still read "update available"; the registry is asked rather than the order trusted.
const publishedOnStable = async (version: string): Promise<boolean> => {
    const tokenResponse = await fetch(TOKEN_URL);
    if (!tokenResponse.ok) {
        return false;
    }
    const token = ((await tokenResponse.json()) as { token?: unknown }).token;
    if (typeof token !== "string") {
        return false;
    }
    const headers = { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT };
    const [versioned, stable] = await Promise.all([
        fetch(`${MANIFEST_URL}${version}`, { method: "HEAD", headers }),
        fetch(`${MANIFEST_URL}stable`, { method: "HEAD", headers }),
    ]);
    const digest = versioned.headers.get("docker-content-digest");
    return versioned.ok && stable.ok && digest !== null && digest === stable.headers.get("docker-content-digest");
};

// Fetches the latest released version once and updates the cache. Never throws: any failure keeps the previous value,
// so /info degrades to "no update known". A release not yet on `:stable` keeps the previous value too, which was.
export const refreshLatestVersion = async (): Promise<void> => {
    try {
        const response = await fetch(LATEST_URL, { headers: { accept: "application/vnd.github+json" } });
        if (response.ok) {
            const version = tagOf(await response.json());
            if (version !== undefined && (await publishedOnStable(version))) {
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
    timer.unref();
    return { stop: () => clearInterval(timer) };
};
