// The cache rule the published packs are held to (_tools/checks/build-cache-mounts.mjs), for apt, the install nearly
// every overlay block makes: every layer above the sandbox image rebuilds whenever it is published, and without the
// mounts each rebuild downloads every package again. Worse, the base image no longer carries Debian's docker-clean hook,
// so a RUN without the mounts commits every .deb it downloaded into its layer (151 MB of clang, LLVM and WebKitGTK
// archives in one dogfood sandbox's image). Said when an agent proposes (proposeDraft), where the fix is one edit away;
// and, for a block approved before the rule, offered back to the owner as a revision (cache-revisions.ts).

const APT_INSTALL = /\bapt(?:-get)?\s+(?:-\S+\s+)*install\b/u;
const APT_UPDATE = /\bapt(?:-get)?\s+(?:-\S+\s+)*update\b/u;
const APT_CACHE = /--mount=type=cache,target=\/var\/cache\/apt\b/u;
const APT_LISTS = /--mount=type=cache,target=\/var\/lib\/apt\/lists\b/u;
const DELETES_LISTS = /\brm\s+(?:-\S+\s+)*[^\n]*\/var\/lib\/apt\/lists/u;

const CACHE_MOUNT = "--mount=type=cache,target=/var/cache/apt,sharing=locked";
const LISTS_MOUNT = "--mount=type=cache,target=/var/lib/apt/lists,sharing=locked";

// One instruction at a time, continuation lines included: a RUN's mounts sit on its first line, its install further down.
export const instructionsOf = (steps: string): string[] => {
    const found: string[] = [];
    let current: string | undefined;
    for (const line of steps.split("\n")) {
        const trimmed = line.trim();
        if (current === undefined && (trimmed === "" || trimmed.startsWith("#"))) {
            continue;
        }
        current = current === undefined ? line : `${current}\n${line}`;
        if (!current.trimEnd().endsWith("\\")) {
            found.push(current);
            current = undefined;
        }
    }
    return current === undefined ? found : [...found, current];
};

export const cacheProblem = (steps: string): string | undefined => {
    if (instructionsOf(steps).some((step) => APT_INSTALL.test(step) && !(APT_CACHE.test(step) && APT_LISTS.test(step)))) {
        return (
            "an apt install must mount both apt caches on its RUN (--mount=type=cache,target=/var/cache/apt,sharing=locked " +
            "and --mount=type=cache,target=/var/lib/apt/lists,sharing=locked), or every image update downloads it all again; " +
            "the environment skill has the shape"
        );
    }
    return DELETES_LISTS.test(steps)
        ? "leave /var/lib/apt/lists alone: it is the cache mount the next rebuild reads, and it never reaches the image anyway"
        : undefined;
};

// `&& rm -rf /var/lib/apt/lists/*` and `&& apt-get clean` as a segment of a chained RUN: the first deletes the cache
// mount the next rebuild reads, the second empties the one that keeps .debs out of the layer. Matched with the operator
// that joins them, so taking one out leaves the chain well formed.
const CLEANUP_SEGMENT = /\s*(?:&&|;)\s*(?:rm\s+(?:-\S+\s+)*\/var\/lib\/apt\/lists\/?\*?|apt-get\s+clean)(?=\s*(?:&&|;|\\?\s*$))/gmu;

// A line that is nothing but a continuation backslash once a segment left it.
const ONLY_CONTINUATION = /^\s*\\\s*$/u;

// One RUN with its cleanup taken out, keeping the continuation backslashes consistent: the last remaining line of the
// instruction ends without one, every other line with one.
const withoutCleanup = (step: string): string => {
    const lines = step
        .split("\n")
        .map((line) => line.replace(CLEANUP_SEGMENT, ""))
        .filter((line) => !ONLY_CONTINUATION.test(line) && line.trim() !== "");
    return lines
        .map((line, index) => {
            const bare = line.replace(/\s*\\\s*$/u, "");
            return index === lines.length - 1 ? bare : `${bare} \\`;
        })
        .join("\n");
};

// The mounts an apt RUN lacks, placed first on the instruction the way the environment skill shapes it.
const withMounts = (step: string): string => {
    const missing = [APT_CACHE.test(step) ? undefined : CACHE_MOUNT, APT_LISTS.test(step) ? undefined : LISTS_MOUNT].filter(
        (mount): mount is string => mount !== undefined,
    );
    if (missing.length === 0) {
        return step;
    }
    const match = /^(\s*)RUN\s+/iu.exec(step);
    if (match === null) {
        return step;
    }
    const indent = match[1] ?? "";
    const rest = step.slice(match[0].length);
    return `${indent}RUN ${missing.map((mount) => `${mount} \\\n${indent}    `).join("")}${rest}`;
};

// A block brought within the rule mechanically: both mounts on every apt RUN, every lists deletion and `apt-get clean`
// taken out, every comment and every other line left exactly as it was. Undefined when the block already keeps the
// rule, or when the mechanical answer is not obviously the same install: an apt RUN with no `apt-get update` of its own
// would read package lists from a cache that may be empty, and a lists deletion not shaped as a chained segment is not
// something to rewrite unseen. Those stay a person's edit.
export const withAptCaches = (body: string): string | undefined => {
    if (cacheProblem(body) === undefined) {
        return undefined;
    }
    const steps = instructionsOf(body);
    let revised = body;
    for (const step of steps) {
        const installs = APT_INSTALL.test(step);
        if (!installs && !DELETES_LISTS.test(step)) {
            continue;
        }
        if (installs && !APT_UPDATE.test(step)) {
            return undefined;
        }
        const cleaned = withoutCleanup(step);
        revised = revised.replace(step, installs ? withMounts(cleaned) : cleaned);
    }
    return cacheProblem(revised) === undefined && revised !== body ? revised : undefined;
};
