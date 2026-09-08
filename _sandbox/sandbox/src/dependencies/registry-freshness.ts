import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Answers whether a pinned version is behind the registry's latest, cheaply enough for the agent's tool-call critical
// path; a lookup that cannot be taken says nothing rather than guessing. Uses two small npm documents instead of the
// multi-MB packument to check dist-tags and deprecation.

export type Ecosystem = "npm" | "pypi" | "crates";

// Comparison operator a manifest wrote before the version, deciding what 'behind' means; empty is an exact pin.
export type RangeOperator = "" | "^" | "~" | ">=";

export interface PinnedPackage {
    readonly ecosystem: Ecosystem;
    readonly name: string;
    // The version as written, without its operator.
    readonly version: string;
    // Operator in front of the version; a caret already reaching the newest release is not stale.
    readonly range: RangeOperator;
}

// How far apart the pin and the registry are, the only unit anyone acts on.
export type VersionGap = "major" | "minor" | "patch";

export interface Freshness {
    readonly latest: string;
    readonly gap: VersionGap;
    // Registry's own deprecation message for the pinned version, when it has one.
    readonly deprecated?: string;
}

export type FreshnessResolver = (pinned: PinnedPackage) => Promise<Freshness | undefined>;

// How long an answer is trusted; six hours balances staleness against a network call on too many tool calls.
const TTL_MS = 6 * 60 * 60 * 1000;

// Two clocks: GRACE_MS bounds the caller's wait; TIMEOUT_MS bounds the fetch, past grace into the cache.
const GRACE_MS = 800;
const TIMEOUT_MS = 10_000;

// Ceiling on any single response, so a slim endpoint that stops being slim can't buy an unbounded read.
const MAX_BYTES = 2_000_000;

interface Semver {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
}

export const parseVersion = (value: string): Semver | undefined => {
    const matched = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
    if (matched === null) {
        return undefined;
    }
    return { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3] ?? "0") };
};

// A prerelease is never what 'latest' means; guards ecosystems whose slim endpoint doesn't already exclude them.
export const isPrerelease = (value: string): boolean => /-/.test(value.trim());

const compare = (left: Semver, right: Semver): number =>
    left.major !== right.major ? left.major - right.major : left.minor !== right.minor ? left.minor - right.minor : left.patch - right.patch;

// Highest version the pin already admits, what latest must beat before there's anything to report; ^7.1.7 admits 7.4.0
// but not 8.2.1.
export const admits = (pinned: PinnedPackage, candidate: Semver): boolean => {
    const base = parseVersion(pinned.version);
    if (base === undefined) {
        return true;
    }
    if (compare(candidate, base) <= 0) {
        return true;
    }
    switch (pinned.range) {
        case "^":
            // npm's caret is major-locked, except below 1.0.0 where the minor takes that role.
            return base.major > 0 ? candidate.major === base.major : candidate.major === 0 && candidate.minor === base.minor;
        case "~":
            return candidate.major === base.major && candidate.minor === base.minor;
        case ">=":
            return true;
        case "":
            return false;
    }
};

export const gapBetween = (from: Semver, to: Semver): VersionGap => (from.major !== to.major ? "major" : from.minor !== to.minor ? "minor" : "patch");

interface FetchOptions {
    readonly signal: AbortSignal;
}

const fetchJson = async (url: string, { signal }: FetchOptions): Promise<unknown> => {
    const response = await fetch(url, {
        signal,
        headers: {
            // crates.io refuses an unidentified client; every registry here accepts this one.
            "user-agent": "intentic-dependency-freshness (+https://github.com/intentic/intentic)",
            accept: "application/json",
        },
    });
    if (!response.ok) {
        return undefined;
    }
    const text = await response.text();
    if (text.length > MAX_BYTES) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// What one registry answers before comparison: the newest non-prerelease version, and whatever it says about the pinned
// one.
interface RegistryAnswer {
    readonly latest: string;
    readonly deprecated?: string;
}

const npmAnswer = async (name: string, version: string, options: FetchOptions): Promise<RegistryAnswer | undefined> => {
    const encoded = name.replace("/", "%2f");
    // Concurrent; the deprecation half may fail alone, since it is a bonus, never the reason for the notice.
    const [tags, pinned] = await Promise.all([
        fetchJson(`https://registry.npmjs.org/-/package/${encoded}/dist-tags`, options),
        fetchJson(`https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`, options).catch(() => undefined),
    ]);
    const latest = asString(asRecord(tags)?.["latest"]);
    if (latest === undefined) {
        return undefined;
    }
    const deprecated = asString(asRecord(pinned)?.["deprecated"]);
    return deprecated === undefined ? { latest } : { latest, deprecated };
};

const pypiAnswer = async (name: string, options: FetchOptions): Promise<RegistryAnswer | undefined> => {
    const body = asRecord(await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, options));
    const info = asRecord(body?.["info"]);
    const latest = asString(info?.["version"]);
    if (latest === undefined || isPrerelease(latest)) {
        return undefined;
    }
    // PyPI marks a project yanked/inactive via its classifiers, not a flag.
    const classifiers = Array.isArray(info?.["classifiers"]) ? (info["classifiers"] as unknown[]) : [];
    const inactive = classifiers.some((entry) => typeof entry === "string" && entry.includes("Development Status :: 7 - Inactive"));
    return inactive ? { latest, deprecated: "the project marks itself Inactive on PyPI" } : { latest };
};

const cratesAnswer = async (name: string, options: FetchOptions): Promise<RegistryAnswer | undefined> => {
    const body = asRecord(await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, options));
    const crate = asRecord(body?.["crate"]);
    const latest = asString(crate?.["max_stable_version"]);
    return latest === undefined ? undefined : { latest };
};

const ask = (pinned: PinnedPackage, options: FetchOptions): Promise<RegistryAnswer | undefined> => {
    switch (pinned.ecosystem) {
        case "npm":
            return npmAnswer(pinned.name, pinned.version, options);
        case "pypi":
            return pypiAnswer(pinned.name, options);
        case "crates":
            return cratesAnswer(pinned.name, options);
    }
};

interface CacheEntry {
    readonly at: number;
    // null records a registry that answered nothing, so a nonexistent package isn't re-asked on every edit.
    readonly answer: RegistryAnswer | null;
}

// One file per package, named by a hash, since a package name can carry slashes and characters no filesystem wants.
const cacheFile = (dir: string, pinned: PinnedPackage): string =>
    join(dir, `${createHash("sha256").update(`${pinned.ecosystem}\u0000${pinned.name}\u0000${pinned.version}`).digest("hex").slice(0, 32)}.json`);

export interface FreshnessOptions {
    // Where answers persist between turns; absent means memory only, which is what the tests run on.
    readonly cacheDir?: string | undefined;
    readonly now?: (() => number) | undefined;
    // The fetch's own budget, not the caller's grace.
    readonly timeoutMs?: number | undefined;
    readonly graceMs?: number | undefined;
}

// A resolver with two memory layers, per-turn in-memory and cross-turn on disk, plus an in-flight map so concurrent
// lookups for the same package share one fetch.
export const createFreshnessResolver = (options: FreshnessOptions = {}): FreshnessResolver => {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    const graceMs = options.graceMs ?? GRACE_MS;
    const memory = new Map<string, CacheEntry>();
    const inFlight = new Map<string, Promise<RegistryAnswer | undefined>>();

    const readDisk = async (pinned: PinnedPackage): Promise<CacheEntry | undefined> => {
        if (options.cacheDir === undefined) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(await readFile(cacheFile(options.cacheDir, pinned), "utf8")) as CacheEntry;
            return typeof parsed.at === "number" ? parsed : undefined;
        } catch {
            return undefined;
        }
    };

    const writeDisk = async (pinned: PinnedPackage, entry: CacheEntry): Promise<void> => {
        if (options.cacheDir === undefined) {
            return;
        }
        try {
            await mkdir(options.cacheDir, { recursive: true });
            await writeFile(cacheFile(options.cacheDir, pinned), JSON.stringify(entry), "utf8");
        } catch {
            // An unwritable cache is a miss next time, nothing worse; never a reason to fail the caller's lookup.
        }
    };

    // Starts a lookup at most once per package, never abandoned early; whoever starts it writes the result to both
    // caches.
    const lookupFor = (pinned: PinnedPackage, key: string): Promise<RegistryAnswer | undefined> => {
        const running = inFlight.get(key);
        if (running !== undefined) {
            return running;
        }
        const lookup = (async (): Promise<RegistryAnswer | undefined> => {
            const controller = new AbortController();
            const timer = setTimeout(() => {
                controller.abort();
            }, timeoutMs);
            let answer: RegistryAnswer | undefined;
            try {
                answer = await ask(pinned, { signal: controller.signal });
            } catch {
                // Timeout, offline, DNS, non-JSON: silence, remembered so a dead registry is asked once, not per edit.
                answer = undefined;
            } finally {
                clearTimeout(timer);
            }
            const entry: CacheEntry = { at: now(), answer: answer ?? null };
            memory.set(key, entry);
            inFlight.delete(key);
            // Not awaited: the answer is known; a hung write (mkdir that hangs, not fails) must never delay it.
            void writeDisk(pinned, entry);
            return answer;
        })();
        inFlight.set(key, lookup);
        return lookup;
    };

    // What the caller gets: a cached answer, or as much of a lookup as fits in the grace; an unresolved fetch continues
    // and lands in memory for the next asker.
    const answerFor = async (pinned: PinnedPackage, key: string): Promise<RegistryAnswer | undefined> => {
        const remembered = memory.get(key) ?? (await readDisk(pinned));
        if (remembered !== undefined && now() - remembered.at < TTL_MS) {
            memory.set(key, remembered);
            return remembered.answer ?? undefined;
        }
        const lookup = lookupFor(pinned, key);
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
                resolve(undefined);
            }, graceMs);
        });
        try {
            return await Promise.race([lookup, grace]);
        } finally {
            clearTimeout(timer);
        }
    };

    return async (pinned) => {
        const base = parseVersion(pinned.version);
        if (base === undefined) {
            return undefined;
        }
        const key = `${pinned.ecosystem}\u0000${pinned.name}\u0000${pinned.version}`;
        const answer = await answerFor(pinned, key);
        if (answer === undefined) {
            return undefined;
        }
        const latest = parseVersion(answer.latest);
        if (latest === undefined || isPrerelease(answer.latest)) {
            return answer.deprecated === undefined ? undefined : { latest: answer.latest, gap: "patch", deprecated: answer.deprecated };
        }
        // A pin already within range isn't news, unless the registry marks it deprecated, worth saying regardless.
        if (admits(pinned, latest)) {
            return answer.deprecated === undefined ? undefined : { latest: answer.latest, gap: gapBetween(base, latest), deprecated: answer.deprecated };
        }
        const gap = gapBetween(base, latest);
        return answer.deprecated === undefined ? { latest: answer.latest, gap } : { latest: answer.latest, gap, deprecated: answer.deprecated };
    };
};
