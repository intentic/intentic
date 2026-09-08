// A prose path reference is loosely anchored (a working prefix, a worktree's absolute prefix) but ends in the real
// workspace-relative path. Resolved by matching shorter tails against the tree; the browser and daemon run the
// identical rule so they can't disagree.

// Leading segments a reference may exceed the workspace by; a worktree's own lead is 3 segments.
const MAX_DROPS = 6;
// Never cut to a bare filename: one name can match a hundred files in a monorepo, worse than not linking.
const MIN_SEGMENTS = 2;
// Enough candidates for a picker; a reference matching more than this is ambiguous by any measure.
export const MAX_REF_CANDIDATES = 10;

// Tails ordered longest (most specific) first. root is the container workspace root: a path under it is the answer
// minus that lead; a path under any other absolute root (a worktree) mirrors the same layout below its own lead.
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

// Segment-boundary matches only, best (shallowest) first: pages/Foo.vue means the app's page, not a copy nested in a
// fixture tree. The daemon's glob only anchors at the string level, so the boundary is enforced here.
export const rankRefCandidates = (tail: string, paths: readonly string[]): readonly string[] =>
    paths
        .filter((path) => path === tail || path.endsWith(`/${tail}`))
        .toSorted((a, b) => a.split(`/`).length - b.split(`/`).length || a.length - b.length || (a < b ? -1 : 1))
        .slice(0, MAX_REF_CANDIDATES);

// The one change-vs-tests rule, shared by every surface that needs it. Convention-based (.test./.spec., __tests__ dirs,
// e2e-harness, runner configs); never bare "contains test", which would flag testimonials/ or latest.ts.
const TEST_DIRS = new Set([`__tests__`, `__fixtures__`, `__mocks__`, `__snapshots__`]);
const TEST_FILE =
    /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[^/.]+|[^/]*\.e2e\.[^/]+|e2e-harness\.[^/]+|(?:vitest|jest|playwright)(?:\.[\w-]+)*\.config\.[^/]+)$/;

export const isTestPath = (path: string): boolean => TEST_FILE.test(path) || path.split(`/`).some((segment) => TEST_DIRS.has(segment));
