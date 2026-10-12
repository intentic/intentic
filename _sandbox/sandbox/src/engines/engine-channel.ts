import { cachedAsync } from "@intentic/base/held";
import { type EngineChannel, type EngineId, isNewer } from "@intentic/sandbox-contract";
import { z } from "zod";
import { ENGINE_DESCRIPTORS, engineDescriptor } from "./engine-descriptors.js";
import { type EngineState, isQuarantined } from "./engine-store.js";

// What upstream publishes is read straight from its registry (npm or GitHub releases); what this project has blessed is
// a JSON file in the intentic repo, fetched raw and overridable by env. Neither read may throw: failure keeps the last
// good value or answers "nothing on offer", never breaking a running sandbox.

const LIST_URL = (): string => process.env["INTENTIC_ENGINES_LIST_URL"] ?? "https://raw.githubusercontent.com/intentic/intentic/main/engines.json";

// Refreshed hourly; the card's Update button reads the list directly, bypassing the wait.
const LIST_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
// One registry answer serves every read this long: an npm document runs to megabytes, GitHub allows 60 anonymous calls/h.
const PUBLISHED_TTL_MS = 10 * 60_000;

const BlessedEntrySchema = z.object({
    blessed: z.string(),
    // Floor upstream enforces itself; advisory here, shown when a turn dies on a version floor.
    minimum: z.string().optional(),
    notes: z.string().optional(),
});
const BlessedListSchema = z.object({ engines: z.record(z.string(), BlessedEntrySchema) });
export type BlessedEntry = z.infer<typeof BlessedEntrySchema>;

interface ListCache {
    readonly entries: Partial<Record<EngineId, BlessedEntry>>;
    readonly readAt: string;
    readonly etag?: string;
}

// The last list read, kept past its hour: the etag for the next conditional read, the card's read time, and the answer
// while a refresh fails. Only a read that landed makes it fresh, so a failed refresh is tried again on the next read.
let list: ListCache | undefined;
const freshList = cachedAsync<undefined, ListCache | undefined>({ ttlMs: LIST_TTL_MS, keep: (read) => read !== undefined });

const fetchList = async (): Promise<ListCache | undefined> => {
    try {
        const response = await fetch(LIST_URL(), {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: list?.etag === undefined ? {} : { "if-none-match": list.etag },
        });
        // 304 means the list is unchanged since last read; only the freshness stamp moves forward.
        if (response.status === 304 && list !== undefined) {
            return { ...list, readAt: new Date().toISOString() };
        }
        if (!response.ok) {
            return undefined;
        }
        const parsed = BlessedListSchema.safeParse(await response.json());
        if (parsed.data === undefined) {
            return undefined;
        }
        // Read by each engine's own key: one whose major the released daemons cannot drive is blessed under another.
        const entries = Object.fromEntries(
            ENGINE_DESCRIPTORS.flatMap((descriptor) => {
                const entry = parsed.data.engines[descriptor.listKey ?? descriptor.id];
                return entry === undefined ? [] : [[descriptor.id, entry]];
            }),
        );
        const etag = response.headers.get("etag");
        return { entries, readAt: new Date().toISOString(), ...(etag === null ? {} : { etag }) };
    } catch {
        return undefined;
    }
};

// Keeps serving the last list read when a refresh fails.
export const blessedList = async (force = false): Promise<ListCache | undefined> => {
    const read = await freshList.get(
        undefined,
        async () => {
            const fetched = await fetchList();
            if (fetched !== undefined) {
                list = fetched;
            }
            return fetched;
        },
        { fresh: force },
    );
    return read ?? list;
};

export const blessedEntry = async (id: EngineId): Promise<BlessedEntry | undefined> => (await blessedList())?.entries[id];

// Read time for the card; undefined means never reached, distinct from a list that blesses nothing.
export const blessedListReadAt = (): string | undefined => list?.readAt;
export const blessedListSource = (): string => LIST_URL();

// Test seam: clears both upstream caches so a suite can change what fetch answers between cases.
export const forgetUpstream = (): void => {
    list = undefined;
    freshList.clear();
    publishedCache.clear();
};

const npmMetadata = async (packageName: string): Promise<{ latest?: string; versions: string[] } | undefined> => {
    try {
        const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            // Abbreviated document: dist-tags and version keys only, without each version's full manifest.
            headers: { accept: "application/vnd.npm.install-v1+json" },
        });
        if (!response.ok) {
            return undefined;
        }
        const body = (await response.json()) as { "dist-tags"?: Record<string, unknown>; versions?: Record<string, unknown> };
        const latest = body["dist-tags"]?.["latest"];
        return { ...(typeof latest === "string" ? { latest } : {}), versions: Object.keys(body.versions ?? {}) };
    } catch {
        return undefined;
    }
};

const githubReleases = async (repo: string): Promise<{ latest?: string; versions: string[] } | undefined> => {
    try {
        const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { accept: "application/vnd.github+json" },
        });
        if (!response.ok) {
            return undefined;
        }
        const body = (await response.json()) as ReadonlyArray<{ tag_name?: unknown; prerelease?: unknown; draft?: unknown }>;
        const versions = body
            .filter((release) => release.prerelease !== true && release.draft !== true)
            .map((release) => (typeof release.tag_name === "string" ? release.tag_name.replace(/^v/, "") : undefined))
            .filter((version): version is string => version !== undefined);
        // GitHub releases return newest-first; the first entry is `latest`, no extra request needed.
        return { ...(versions[0] === undefined ? {} : { latest: versions[0] }), versions };
    } catch {
        return undefined;
    }
};

type Published = { latest?: string; versions: string[] } | undefined;

// Concurrent readers share one request; an unreachable answer is not held, so the next read asks again.
const publishedCache = cachedAsync<EngineId, Published>({ ttlMs: PUBLISHED_TTL_MS, keep: (answer) => answer !== undefined });

// What upstream publishes for this engine, or undefined when upstream could not be reached; "no newer version" and "we
// could not ask" must not read the same.
const publishedVersions = (id: EngineId, fresh = false): Promise<Published> =>
    publishedCache.get(
        id,
        async () => {
            const { source } = engineDescriptor(id);
            return source.kind === "npm" ? npmMetadata(source.package) : githubReleases(source.repo);
        },
        { fresh },
    );

// Lowest published version at or above the floor, the smallest step that clears it. Used by the card's Update-anyway
// action, which wants the least-unblessed version available.
export const lowestSatisfying = async (id: EngineId, floor: string): Promise<string | undefined> => {
    const descriptor = engineDescriptor(id);
    // Claude's floors are in the CLI's vocabulary, not npm's; the descriptor is responsible for the mapping.
    const satisfies = descriptor.satisfiesFloor ?? ((published: string, bound: string) => published === bound || isNewer(published, bound));
    // Fresh: the floor was raised by a refusal just now, which a held answer may predate.
    const upstream = await publishedVersions(id, true);
    return upstream?.versions
        .filter((version) => satisfies(version, floor) && descriptor.incompatible?.(version) === undefined)
        .sort((left, right) => (isNewer(left, right) ? 1 : -1))
        .at(0);
};

// What the channel says this engine should be on, given the owner's policy and the store's quarantine list. Quarantine
// is applied here, not at install time, so a version already refused is not offered on every check.
export const targetVersion = async (id: EngineId, channel: EngineChannel, state: EngineState): Promise<string | undefined> => {
    const target = await targetOf(id, channel);
    // A pin or a list naming a version this daemon cannot drive offers nothing, rather than an install that is refused.
    return target === undefined || isQuarantined(state, target) || engineDescriptor(id).incompatible?.(target) !== undefined ? undefined : target;
};

const targetOf = async (id: EngineId, channel: EngineChannel): Promise<string | undefined> => {
    switch (channel.kind) {
        case "image": {
            return undefined;
        }
        case "pinned": {
            return channel.version;
        }
        case "latest": {
            return (await publishedVersions(id))?.latest;
        }
        case "blessed": {
            return (await blessedEntry(id))?.blessed;
        }
    }
};
