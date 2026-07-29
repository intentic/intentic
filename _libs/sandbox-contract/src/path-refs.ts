/* Which file a NAMED reference means. A path written in prose is only loosely anchored to the workspace: an
 * agent that has been working in `_apps/web/src` writes `pages/workspace/Foo.vue`, and a turn running in an
 * isolated worktree prints `/history/worktrees/<id>/_apps/web/src/foo.ts` — neither is the workspace-relative
 * path the file routes speak, but both END in it.
 *
 * So a reference is resolved by matching progressively shorter TAILS of it against the real tree. The rules
 * live here, in the contract package, because both sides run them: the browser first against the workspace
 * tree it already has cached, then the daemon (/workspace/resolve) against the iq engine's full sweep, which
 * sees the files the capped tree walk left out. Two matchers that disagreed would make a link's destination
 * depend on which one answered. */

// How many leading segments a reference may carry that the workspace doesn't (the `/history/worktrees/<id>/`
// lead of a worktree path is 3; a foreign absolute root is rarely deeper).
const MAX_DROPS = 6;
// A tail is never cut down to a bare filename: `index.ts` names a hundred files in a monorepo and picking one
// at random is worse than not linking. The link grammar never emits a slash-less reference either.
const MIN_SEGMENTS = 2;
// Enough candidates for a picker; a reference matching more than this is ambiguous by any measure.
export const MAX_REF_CANDIDATES = 10;

// The tails worth matching, longest (most specific) first. `root` is the container workspace root: a path
// under it is already the answer minus that lead, and a path under any OTHER absolute root (a worktree) still
// mirrors the layout below its own lead, which the successive drops strip.
export const referenceTails = (raw: string, root: string): readonly string[] => {
    const normalized = raw.replaceAll(`\\`, `/`).replace(/^\.\//, ``);
    const anchored = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized.replace(/^\/+/, ``);
    const segments = anchored.split(`/`).filter((segment) => segment !== `` && segment !== `.`);
    const tails: string[] = [];
    for (let drop = 0; drop <= MAX_DROPS && segments.length - drop >= MIN_SEGMENTS; drop++) {
        tails.push(segments.slice(drop).join(`/`));
    }
    return tails;
};

// The paths that genuinely END in `tail` on a segment boundary, best first — the shared ranking both matchers
// return their candidates in. Shallowest wins: `pages/Foo.vue` means the app's page, not the copy six
// directories down in a fixture tree. (The daemon's glob is anchored only at the string level — `**/pages/x.vue`
// also matches `mypages/x.vue` — so the boundary is enforced here rather than by the pattern.)
export const rankRefCandidates = (tail: string, paths: readonly string[]): readonly string[] =>
    paths
        .filter((path) => path === tail || path.endsWith(`/${tail}`))
        .toSorted((a, b) => a.split(`/`).length - b.split(`/`).length || a.length - b.length || (a < b ? -1 : 1))
        .slice(0, MAX_REF_CANDIDATES);

/* IS THIS FILE TEST CODE — the one classification rule for every surface that splits a diff into "the
 * change" and "the proof". The agent review header answers "how much of this is tests?" with it; anything
 * else that wants the split (fleet cards, commit summaries) must use this same predicate, because two
 * classifiers that disagree turn the readout into a lie the user can't detect.
 *
 * Convention-based, matching what this monorepo (and the ecosystems it scaffolds) actually writes: a
 * `.test.` / `.spec.` filename in any extension, a `__tests__` / `__fixtures__` directory anywhere on the
 * path, an `e2e-harness`, or a test-runner config. Deliberately NOT "anything containing 'test'": a
 * `testimonials/` page or a `latest.ts` is product code, and a false "tests" tag is worse than a missed one —
 * it tells a reviewer not to look. */
const TEST_DIRS = new Set([`__tests__`, `__fixtures__`, `__mocks__`, `__snapshots__`]);
const TEST_FILE = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[^/.]+|[^/]*\.e2e\.[^/]+|e2e-harness\.[^/]+|(?:vitest|jest|playwright)(?:\.[\w-]+)*\.config\.[^/]+)$/;

export const isTestPath = (path: string): boolean =>
    TEST_FILE.test(path) || path.split(`/`).some((segment) => TEST_DIRS.has(segment));
