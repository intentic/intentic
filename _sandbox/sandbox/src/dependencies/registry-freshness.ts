import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

/* WHAT THE REGISTRY ACTUALLY HAS, asked cheaply enough to sit in front of a tool call.
 *
 * This module answers one question, "is the version about to be written behind the newest published one",
 * and it answers it under a constraint that shapes every decision in here: it runs on the CRITICAL PATH of
 * the agent's own tool call. The command does not start until this returns. So the budget is a fraction of a
 * second, the payloads are chosen for size rather than for convenience, and a lookup that cannot be taken
 * says NOTHING rather than guessing — the same rule agent-deps.ts states for itself, for the same reason: a
 * notice that is sometimes invented teaches the model to distrust the ones that are true.
 *
 * WHY NOT THE PACKUMENT. The obvious call is `GET registry.npmjs.org/<name>`, which carries every version and
 * every publish date. It is also 2 MB for `typescript` and 1.6 MB abbreviated, measured, and putting that in
 * front of `pnpm add` would be a worse bug than the one this fixes. So npm is asked through two documents
 * that are 18–200 bytes and ~2 kB respectively:
 *   /-/package/<name>/dist-tags   what `latest` currently is.
 *   /<name>/<version>             whether the version being pinned is deprecated (and nothing else).
 * The pair is fetched concurrently and the second is allowed to fail on its own: a deprecation notice is a
 * bonus, a missing one is not a reason to withhold the version fact.
 *
 * THE COST OF THE MISSING PACKUMENT is the publish DATE, which is why no notice from here says "released N
 * days ago". It says which versions are in play and how far apart they are, both of which are arithmetic over
 * two strings this already has. The one caller that genuinely needs a date is the successor check, which runs
 * for a couple of dozen curated names that are small by construction, and it asks for the packument itself. */

export type Ecosystem = "npm" | "pypi" | "crates";

// The comparison operator a manifest wrote in front of the version, which decides what "behind" even means.
// An empty string is an exact pin.
export type RangeOperator = "" | "^" | "~" | ">=";

export interface PinnedPackage {
    readonly ecosystem: Ecosystem;
    readonly name: string;
    // The version as written, without its operator.
    readonly version: string;
    // The operator that stood in front of it. A caret that already reaches the newest release is NOT stale,
    // and treating it as such is how this feature would have become noise on a healthy manifest.
    readonly range: RangeOperator;
}

// How far apart the pin and the registry are, in the only unit anyone acts on.
export type VersionGap = "major" | "minor" | "patch";

export interface Freshness {
    readonly latest: string;
    readonly gap: VersionGap;
    // The registry's own deprecation message for the pinned version, when it carries one.
    readonly deprecated?: string;
}

export type FreshnessResolver = (pinned: PinnedPackage) => Promise<Freshness | undefined>;

/* How long a registry answer is believed. Six hours is chosen against what it protects: a version published
 * during the window is one the agent pins slightly stale and nobody notices, which is the status quo, while a
 * TTL short enough to catch it would put a network call in front of a meaningful share of tool calls. */
const TTL_MS = 6 * 60 * 60 * 1000;

/* TWO CLOCKS, and separating them is what makes this usable rather than a check that goes quiet exactly when
 * it is needed.
 *
 * `GRACE_MS` is how long a CALLER waits. The agent is parked on a tool call for the whole of it, so it is
 * short, and a lookup that overruns it simply says nothing this time.
 *
 * `TIMEOUT_MS` is how long the FETCH ITSELF gets, and it is much longer, because the fetch is not abandoned
 * when the grace expires — it keeps going and lands in the cache. Measured from a cold container: the first
 * call to a registry costs 2.3–5.3 s of DNS and TLS, and every call after it to the same host is ~600 ms. One
 * clock for both would have to choose between blocking the agent for five seconds and being silent on the
 * first lookup of every session, which is the one it would most want to make. With two, the cold case reports
 * a beat late (the PostToolUse pass reads the same cache) and the warm case — the overwhelming majority — is
 * a hit that costs nothing. */
const GRACE_MS = 800;
const TIMEOUT_MS = 10_000;

// A ceiling on any single response, so an ecosystem whose slim endpoint stops being slim cannot buy an
// unbounded read on this path. PyPI's largest measured here is ~640 kB (numpy).
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

// A prerelease is not what "latest" means to anyone reading this notice, and npm's own `latest` tag already
// excludes them. This is the guard for the ecosystems whose slim endpoint does not.
export const isPrerelease = (value: string): boolean => /-/.test(value.trim());

const compare = (left: Semver, right: Semver): number =>
    left.major !== right.major ? left.major - right.major : left.minor !== right.minor ? left.minor - right.minor : left.patch - right.patch;

/* THE HIGHEST VERSION THE PIN ALREADY ADMITS, which is the thing `latest` has to beat before there is
 * anything to say.
 *
 * This is the difference between a useful notice and a nuisance. `"vite": "^7.1.7"` against a registry latest
 * of `8.2.1` IS behind: the caret stops at the major boundary and will never resolve to 8. The same caret
 * against `7.4.0` is not behind at all — the manifest already says yes to it, and `pnpm install` picks it up
 * without anybody editing anything. A check that could not tell those apart would fire on most of a healthy
 * lockfile and be switched off within a day. */
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
            // crates.io refuses an unidentified client outright, and every registry here is friendlier to one.
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

// What one registry answers, before any comparison: the newest non-prerelease it publishes, and whatever it
// says about the version we asked after.
interface RegistryAnswer {
    readonly latest: string;
    readonly deprecated?: string;
}

const npmAnswer = async (name: string, version: string, options: FetchOptions): Promise<RegistryAnswer | undefined> => {
    const encoded = name.replace("/", "%2f");
    // Concurrent, and the deprecation half is allowed to fail alone: it is an extra sentence on the notice,
    // never the reason for it.
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
    // PyPI marks a whole project yanked/inactive through its classifiers rather than a flag.
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
    // `null` records a registry that answered nothing, so a package that does not exist is not re-asked on
    // every edit of the file that names it.
    readonly answer: RegistryAnswer | null;
}

// One file per package, named by hash: a package name can carry a slash, a scope and characters no filesystem
// wants, and this cache is not something anybody reads by hand.
const cacheFile = (dir: string, pinned: PinnedPackage): string =>
    join(dir, `${createHash("sha256").update(`${pinned.ecosystem}\u0000${pinned.name}\u0000${pinned.version}`).digest("hex").slice(0, 32)}.json`);

export interface FreshnessOptions {
    // Where answers are kept between turns. Absent ⇒ memory only, which is what the tests run on.
    readonly cacheDir?: string | undefined;
    readonly now?: (() => number) | undefined;
    // The fetch's own budget, not the caller's. See the two clocks above.
    readonly timeoutMs?: number | undefined;
    readonly graceMs?: number | undefined;
}

/* A resolver, with its two layers of memory.
 *
 * Created once per turn so the in-memory layer is a turn's worth of answers — a manifest edited five times
 * costs one lookup, and the same package named in two files costs one. The disk layer spans turns and is what
 * keeps a busy workspace from re-asking the registry for the same forty packages every conversation.
 *
 * The in-flight map matters as much as either: a `Write` that names twenty dependencies fires twenty lookups
 * in the same tick, and without it the same package is fetched by several of them at once. */
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
            // A cache that cannot be written is a cache miss next time, and nothing worse. Never a reason to
            // fail the lookup the agent is waiting on.
        }
    };

    /* The lookup itself, started at most once per package and never abandoned early. Whoever starts it owns
     * writing the result into both caches, which is what makes it safe for a caller to walk away at its grace
     * and for the NEXT caller to find the answer sitting there. */
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
                // Timed out, offline, DNS, a registry returning something that is not JSON. Silence, and the
                // silence is REMEMBERED below, so an unreachable registry is asked once rather than per edit.
                answer = undefined;
            } finally {
                clearTimeout(timer);
            }
            const entry: CacheEntry = { at: now(), answer: answer ?? null };
            memory.set(key, entry);
            inFlight.delete(key);
            /* NOT awaited, and that is the point: by here the answer is known, and the between-turn cache is
             * an optimization that must never stand between it and the caller. Awaiting it cost exactly that
             * once already — a `mkdir` that HANGS rather than failing (a container's /proc, a wedged network
             * mount) held the answer past its grace and the notice was silently dropped, with a working
             * lookup sitting behind it. writeDisk swallows its own failures, so nothing here can reject. */
            void writeDisk(pinned, entry);
            return answer;
        })();
        inFlight.set(key, lookup);
        return lookup;
    };

    /* What the CALLER gets, which is the cached answer if there is one and otherwise as much of a lookup as
     * fits in the grace. The unresolved case returns `undefined` while the fetch carries on behind it: nothing
     * is cancelled, so the answer is simply late rather than lost, and the next hook to ask the same question
     * — the PostToolUse pass on the very same tool call — finds it in memory. */
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
        // A pin the manifest already reaches is not news — unless the registry says the pinned version is
        // deprecated, which is worth saying whatever the numbers are.
        if (admits(pinned, latest)) {
            return answer.deprecated === undefined ? undefined : { latest: answer.latest, gap: gapBetween(base, latest), deprecated: answer.deprecated };
        }
        const gap = gapBetween(base, latest);
        return answer.deprecated === undefined ? { latest: answer.latest, gap } : { latest: answer.latest, gap, deprecated: answer.deprecated };
    };
};
