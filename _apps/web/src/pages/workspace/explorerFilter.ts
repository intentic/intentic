import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";

/* What the explorer LISTS — the two reading filters behind the toolbar's funnel, as one predicate.
 *
 * It lives here rather than in either view because the desktop tree and the mobile listing have to agree on
 * what a level holds (one browser, one set of switches), and they had already grown two copies of the
 * ignored-entry line between them.
 *
 * Both filters answer the same question — "is this part of the code I'm reading right now?" — and neither
 * hides anything: an ignored path is still openable by name, and a hidden test is one switch away.
 *
 * Names, not paths, are enough: the tree filters a level at a time, so a file inside a hidden `__tests__/` is
 * never asked about — its folder already went.
 *
 * Pure, and no framework code — unit-testable in isolation. */

// Mirrors how iq classifies a path as `tests` (CLASS_TESTS in _libs/iq-engine/src/workspace/scan.ts, the
// node-side classifier this browser copy can't import), widened by the Go/Rust `_test.` suffix.
//
// Deliberately conservative, because a filter that eats a source file is worse than one that leaves a test in:
// `.test.`/`.spec.` need the dot on BOTH sides, so `testbed.ts` and `latest.ts` stay, and a bare `test.ts`
// stays too — that name is as often a fixture or an entry point as it is a test.
const TEST_FILE = /\.(test|spec)\.|^test_|_test\./;
const TEST_DIRS = new Set([`__tests__`, `__test__`, `test`, `tests`, `spec`, `specs`, `e2e`]);

const isTestEntry = (name: string, type: WorkspaceTreeEntry["type"]): boolean => (type === `dir` ? TEST_DIRS.has(name) : TEST_FILE.test(name));

export const explorerShows = (entry: WorkspaceTreeEntry, showIgnored: boolean, hideTests: boolean): boolean => {
    if (!showIgnored && entry.ignored === true) {
        return false;
    }
    return !(hideTests && isTestEntry(entry.name, entry.type));
};
