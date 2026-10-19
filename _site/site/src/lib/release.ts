// The newest release as the download routes serve it: one place that reads GitHub, so the label on /download/ and
// the file a /desktop/* path hands over come from the same answer and the same one-hour cache.
import { RELEASES_URL } from "./desktop-downloads";

export const DOWNLOAD_TTL_MS = 60 * 60 * 1000;

const LATEST_API = "https://api.github.com/repos/intentic/intentic/releases/latest";

export interface ReleaseInfo {
    version: string;
    /** The day it was published, `YYYY-MM-DD`, or null when the API would not say (rate-limited, offline). */
    date: string | null;
    notes: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** "2026-10-18" as "18 October 2026". Anything that is not a plain ISO day comes back unchanged. */
export function formatReleaseDate(iso: string): string {
    const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u.exec(iso);
    if (match?.groups === undefined) {
        return iso;
    }
    const { year = "", month = "", day = "" } = match.groups;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function createReleaseResolver(fetchImpl: Fetch, now: () => number = Date.now) {
    const downloads = new Map<string, { url: string; at: number }>();
    let latest: { release: ReleaseInfo | null; at: number } | undefined;

    // The version GitHub's own `releases/latest` redirect names, which is what every download route resolves against.
    async function newestVersion(): Promise<string | undefined> {
        const response = await fetchImpl(`${RELEASES_URL}/latest`, { redirect: "manual" });
        return /\/releases\/tag\/v(?<version>[^/?#]+)$/u.exec(response.headers.get("location") ?? "")?.groups?.version;
    }

    // Best effort: the redirect carries no date, and the API is rate-limited for anonymous callers.
    async function publishedOn(version: string): Promise<string | null> {
        try {
            const response = await fetchImpl(LATEST_API, { headers: { accept: "application/vnd.github+json", "user-agent": "intentic.dev-worker" } });
            if (!response.ok) {
                return null;
            }
            // SAFETY: the two fields are read inside the try; a body of any other shape throws and answers null.
            const body = (await response.json()) as { tag_name?: string; published_at?: string };
            // A newer release than the redirect named would label the wrong build: leave the date out then.
            return body.tag_name === `v${version}` ? (body.published_at?.split("T")[0] ?? null) : null;
        } catch (error) {
            console.warn(`[release] the release date could not be read: ${String(error)}`);
            return null;
        }
    }

    return {
        /** What /desktop/latest.json serves; null when GitHub cannot be read, so the page keeps its built label. */
        async latestRelease(): Promise<ReleaseInfo | null> {
            if (latest !== undefined && now() - latest.at < DOWNLOAD_TTL_MS) {
                return latest.release;
            }
            let release: ReleaseInfo | null = null;
            try {
                const version = await newestVersion();
                if (version !== undefined) {
                    release = { version, date: await publishedOn(version), notes: `${RELEASES_URL}/tag/v${version}` };
                }
            } catch (error) {
                // Offline or the redirect shape moved: no label rather than a wrong one.
                console.warn(`[release] the latest release could not be read: ${String(error)}`);
            }
            latest = { release, at: now() };
            return release;
        },

        /** The asset URL a download route redirects to, verified to exist, else the releases page. Memoised per key. */
        async resolveDownload(asset: (version: string) => string, key: string): Promise<string> {
            const cached = downloads.get(key);
            if (cached !== undefined && now() - cached.at < DOWNLOAD_TTL_MS) {
                return cached.url;
            }
            let resolved = `${RELEASES_URL}/latest`;
            try {
                const version = await newestVersion();
                if (version !== undefined) {
                    const candidate = `${RELEASES_URL}/download/v${version}/${asset(version)}`;
                    // An asset that exists answers a HEAD with a redirect to storage; one that does not answers 404.
                    const probe = await fetchImpl(candidate, { method: "HEAD", redirect: "manual" });
                    if (probe.status < 400) {
                        resolved = candidate;
                    }
                }
            } catch (error) {
                // Offline, rate-limited, or the redirect shape moved, the releases-page fallback stands.
                console.warn(`[release] the download could not be resolved: ${String(error)}`);
            }
            downloads.set(key, { url: resolved, at: now() });
            return resolved;
        },
    };
}
