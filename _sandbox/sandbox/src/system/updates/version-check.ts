// Offers a release only after the moving stable image points at that release's published image. Both registry
// requests run on the background timer, never on the /info request path; no Docker socket is needed.

import { isNewer } from "@intentic/sandbox-contract/state/versions";
import { isDevBuild } from "../../version.js";

export { isNewer };

const LATEST_URL = "https://api.github.com/repos/intentic/intentic/releases/latest";
const TOKEN_URL = "https://ghcr.io/token?scope=repository:intentic/sandbox:pull&service=ghcr.io";
const MANIFEST_URL = "https://ghcr.io/v2/intentic/sandbox/manifests/";
const MANIFEST_ACCEPT = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";
// A moved release isn't urgent: about one request per sandbox per hour, beside release-notes.ts's own.
const REFRESH_MS = 60 * 60_000;
// How long one GitHub or registry request may take before the refresh gives up and keeps what it had; without one a
// stalled connection held its refresh open forever. The same 10 s a local endpoint's discovery gets
// (endpoints/endpoint-catalog.ts); release-notes.ts uses it too.
export const RELEASE_FETCH_TIMEOUT_MS = 10_000;

// Last successfully-fetched latest version, or undefined until the first success; a failed refresh leaves it alone.
let latest: string | undefined;

// Told once each time the cached version moves, so the update card and the automatic update hear of a release the
// moment it is known rather than at their next poll.
const listeners = new Set<(version: string) => void>();

export const onLatestVersion = (listener: (version: string) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

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
    const tokenResponse = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS) });
    if (!tokenResponse.ok) {
        return false;
    }
    const token = ((await tokenResponse.json()) as { token?: unknown }).token;
    if (typeof token !== "string") {
        return false;
    }
    const headers = { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT };
    const [versioned, stable] = await Promise.all([
        fetch(`${MANIFEST_URL}${version}`, { method: "HEAD", headers, signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS) }),
        fetch(`${MANIFEST_URL}stable`, { method: "HEAD", headers, signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS) }),
    ]);
    const digest = versioned.headers.get("docker-content-digest");
    return versioned.ok && stable.ok && digest !== null && digest === stable.headers.get("docker-content-digest");
};

// Fetches the latest released version once and updates the cache. Never throws: any failure, a timed-out request
// included, keeps the previous value, so /info degrades to "no update known". A release not yet on `:stable` keeps the
// previous value too, which was.
export const refreshLatestVersion = async (): Promise<void> => {
    try {
        const response = await fetch(LATEST_URL, {
            headers: { accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
        });
        if (response.ok) {
            const version = tagOf(await response.json());
            if (version !== undefined && version !== latest && (await publishedOnStable(version))) {
                latest = version;
                for (const listener of listeners) {
                    listener(version);
                }
            }
        }
    } catch {
        // Keeps the previous cached value on failure.
    }
};

// A RELEASE ONE OF THE OWNER'S COMPUTERS ALREADY RUNS IS ONE TO LOOK FOR NOW, NOT WITHIN THE HOUR. The desktop app
// and its machine agent update from the same release as the sandbox image; an agent dialling in newer than anything
// this sandbox knows of is proof a release is out, and waiting for the hourly refresh left the update card reading "up
// to date" beside an installer that had just said otherwise. The release may reach `:stable` a little after the
// agent's own update, so the look is repeated on a short backoff until the release is known or the backoff runs out,
// after which the hourly refresh carries on as before.
export const CHASE_DELAYS_MS = [0, 60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000] as const;

// Runs `run` after `ms`, answering how to call it off; a test hands in one that does not make it wait.
export type ChaseWait = (run: () => void, ms: number) => () => void;

const timerWait: ChaseWait = (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => clearTimeout(timer);
};

let chase: { readonly version: string; cancel: (() => void) | undefined } | undefined;

const stopChase = (): void => {
    chase?.cancel?.();
    chase = undefined;
};

const caughtUp = (seen: string): boolean => latest !== undefined && !isNewer(seen, latest);

const chaseStep = (version: string, step: number, wait: ChaseWait): void => {
    const current = chase;
    if (current?.version !== version) {
        return;
    }
    const delay = CHASE_DELAYS_MS[step];
    if (delay === undefined || caughtUp(version)) {
        chase = undefined;
        return;
    }
    current.cancel = wait(() => {
        current.cancel = undefined;
        void refreshLatestVersion().then(() => chaseStep(version, step + 1, wait));
    }, delay);
};

// Versions the owner's computers announced: the newest one ahead of both the running build and the newest release
// known starts a chase; one already being chased, or older than it, changes nothing. Reached through startVersionCheck's
// `notice`, which a dev build leaves a no-op, as it never checks.
export const noticeSeenVersions = (seen: readonly string[], running: string | undefined, wait: ChaseWait = timerWait): void => {
    const newest = seen.reduce<string | undefined>((best, version) => (best === undefined || isNewer(version, best) ? version : best), undefined);
    if (newest === undefined || (running !== undefined && !isNewer(newest, running)) || caughtUp(newest)) {
        return;
    }
    if (chase !== undefined && !isNewer(newest, chase.version)) {
        return;
    }
    stopChase();
    chase = { version: newest, cancel: undefined };
    chaseStep(newest, 0, wait);
};

// Boot-time background refresh: warms the cache now, then hourly, unref'd so it never holds the event loop open. A dev
// build never checks, since its unstamped 0.0.0 baked version would report a permanent, unfixable update prompt.
export interface VersionCheck {
    readonly stop: () => void;
    // Versions the owner's computers announced, and the one this sandbox runs (noticeSeenVersions).
    readonly notice: (seen: readonly string[], running: string | undefined) => void;
}

export const startVersionCheck = (): VersionCheck => {
    if (isDevBuild) {
        return { stop: () => undefined, notice: () => undefined };
    }
    void refreshLatestVersion();
    const timer = setInterval(() => void refreshLatestVersion(), REFRESH_MS);
    timer.unref();
    return {
        stop: () => {
            clearInterval(timer);
            stopChase();
        },
        notice: (seen, running) => noticeSeenVersions(seen, running),
    };
};
