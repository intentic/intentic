import { type EngineChannel, type EngineId, ENGINE_IDS, isNewer } from "@intentic/sandbox-contract";
import { z } from "zod";
import { engineDescriptor } from "./engine-descriptors.js";
import { type EngineState, isQuarantined } from "./engine-store.js";

/* WHICH VERSION AN ENGINE SHOULD BE ON, which is two questions with two very different trust stories.
 *
 * WHAT UPSTREAM PUBLISHES is read straight from the registry that publishes it — npm for four engines, GitHub
 * releases for the translator. That is a fact about the world and needs no intermediary.
 *
 * WHAT THIS PROJECT HAS RUN ITS SUITE AGAINST is the blessed list, a JSON file in the intentic repository. It
 * is deliberately DATA rather than an image or a release: a version becomes blessed with one commit, and every
 * running sandbox picks it up within the hour, which is the whole point of this mechanism. It is fetched from
 * the raw file rather than the API so it costs nothing against the hourly budget version-check.ts and
 * release-notes.ts already share, and it is overridable by env so a self-hosted fleet can bless its own.
 *
 * NEITHER READ IS ALLOWED TO THROW. An unreachable registry, a rewritten list, a 500 — each keeps the last good
 * answer and, failing that, means "nothing on offer", which leaves the sandbox running exactly what it runs
 * now. The version-check.ts precedent, for the same reason: an update mechanism that can break a working
 * sandbox by being offline is worse than no update mechanism. */

const LIST_URL = (): string =>
    process.env["INTENTIC_ENGINES_LIST_URL"] ?? "https://raw.githubusercontent.com/intentic/intentic/main/engines.json";

// Hourly, beside the two GitHub reads the daemon already makes. A blessing is not urgent enough to poll for,
// and the Update button on the card reads the list directly, so nobody waits an hour for a version they can see.
const LIST_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

const BlessedEntrySchema = z.object({
    blessed: z.string(),
    // The floor upstream itself enforces (a model that refuses older clients). Advisory here: it is what the
    // card compares against when a turn dies on a version floor, so the reason it names is the real one.
    minimum: z.string().optional(),
    notes: z.string().optional(),
});
const BlessedListSchema = z.object({ engines: z.record(z.string(), BlessedEntrySchema) });
export type BlessedEntry = z.infer<typeof BlessedEntrySchema>;

interface ListCache {
    readonly entries: Partial<Record<EngineId, BlessedEntry>>;
    readonly readAt: string;
    readonly etag?: string;
    readonly at: number;
}

let list: ListCache | undefined;

const isEngineId = (id: string): id is EngineId => (ENGINE_IDS as readonly string[]).includes(id);

const fetchList = async (): Promise<ListCache | undefined> => {
    try {
        const response = await fetch(LIST_URL(), {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: list?.etag === undefined ? {} : { "if-none-match": list.etag },
        });
        // 304 is the ordinary answer once the list has been read once: the previous value stands, and only its
        // freshness stamp moves.
        if (response.status === 304 && list !== undefined) {
            return { ...list, at: Date.now(), readAt: new Date().toISOString() };
        }
        if (!response.ok) {
            return undefined;
        }
        const parsed = BlessedListSchema.safeParse(await response.json());
        if (parsed.data === undefined) {
            return undefined;
        }
        const entries = Object.fromEntries(Object.entries(parsed.data.engines).filter(([id]) => isEngineId(id)));
        const etag = response.headers.get("etag");
        return { entries, readAt: new Date().toISOString(), ...(etag === null ? {} : { etag }), at: Date.now() };
    } catch {
        return undefined;
    }
};

/* The blessed list, refreshed when the cached copy is older than an hour. A failed refresh keeps the previous
 * value rather than clobbering it, so a sandbox that read the list this morning still knows what is blessed
 * when GitHub is down this afternoon. */
export const blessedList = async (force = false): Promise<ListCache | undefined> => {
    if (!force && list !== undefined && Date.now() - list.at < LIST_TTL_MS) {
        return list;
    }
    list = (await fetchList()) ?? (list === undefined ? undefined : { ...list, at: Date.now() });
    return list;
};

export const blessedEntry = async (id: EngineId): Promise<BlessedEntry | undefined> => (await blessedList())?.entries[id];

// When the list was last actually read, for the card. Undefined on a sandbox that has never reached it, which
// is a different claim from "the list blesses nothing" and has to stay tellable.
export const blessedListReadAt = (): string | undefined => list?.readAt;
export const blessedListSource = (): string => LIST_URL();

// Test seam: forget the cached list so a suite can move INTENTIC_ENGINES_LIST_URL between cases.
export const forgetBlessedList = (): void => {
    list = undefined;
};

const npmMetadata = async (packageName: string): Promise<{ latest?: string; versions: string[] } | undefined> => {
    try {
        const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            // The abbreviated document: dist-tags and version keys without every version's full manifest,
            // which for a package this old is the difference between kilobytes and megabytes per check.
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
        // The API answers newest-first, so the first row is `latest` without a second request for it.
        return { ...(versions[0] === undefined ? {} : { latest: versions[0] }), versions };
    } catch {
        return undefined;
    }
};

// What upstream publishes for this engine, or undefined when upstream could not be reached at all. The
// difference matters to every caller: "no newer version" and "we could not ask" must not read the same.
const publishedVersions = async (id: EngineId): Promise<{ latest?: string; versions: string[] } | undefined> => {
    const { source } = engineDescriptor(id);
    return source.kind === "npm" ? npmMetadata(source.package) : githubReleases(source.repo);
};

/* The lowest published version at or above a floor, which is what "an upstream floor moved and this sandbox
 * has to get past it" wants: the smallest step that works, not the newest thing on the registry. Used by the
 * card's Update-anyway action, where the owner is deliberately taking a version nobody has blessed and has
 * every reason to want the least of it. */
export const lowestSatisfying = async (id: EngineId, floor: string): Promise<string | undefined> => {
    const descriptor = engineDescriptor(id);
    // Claude's floors arrive in the CLI's vocabulary rather than npm's, which is the descriptor's business and
    // not this module's (engine-descriptors.ts states the assumption and what checks it).
    const satisfies = descriptor.satisfiesFloor ?? ((published: string, bound: string) => published === bound || isNewer(published, bound));
    const published = await publishedVersions(id);
    return published?.versions
        .filter((version) => satisfies(version, floor))
        .sort((left, right) => (isNewer(left, right) ? 1 : -1))
        .at(0);
};

/* WHAT THE CHANNEL SAYS THIS ENGINE SHOULD BE ON, given the owner's policy and what the store already knows.
 *
 * Quarantine is applied HERE rather than at install time, so a version this daemon has already refused is not
 * offered again on every check — an upstream that publishes a broken `latest` would otherwise produce a card
 * that asks for the same failed download forever. */
export const targetVersion = async (id: EngineId, channel: EngineChannel, state: EngineState): Promise<string | undefined> => {
    const target = await targetOf(id, channel);
    return target === undefined || isQuarantined(state, target) ? undefined : target;
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
