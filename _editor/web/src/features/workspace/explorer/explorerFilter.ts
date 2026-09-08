import type { WorkspaceTreeEntry } from "@intentic/api-contract";

// Shared predicate for the toolbar's ignored/hidden-tests filters, so the desktop tree and mobile listing agree on what
// a level holds. Neither truly hides: an ignored path opens by name, a hidden test is a switch away. Matches by name,
// not path; pure, no framework code.

// Mirrors iq's CLASS_TESTS (scan.ts), widened by the Go/Rust `_test.` suffix; dots required on both sides.
const TEST_FILE = /\.(test|spec)\.|^test_|_test\./;
const TEST_DIRS = new Set([`__tests__`, `__test__`, `test`, `tests`, `spec`, `specs`, `e2e`]);

const isTestEntry = (name: string, type: WorkspaceTreeEntry["type"]): boolean => (type === `dir` ? TEST_DIRS.has(name) : TEST_FILE.test(name));

export const explorerShows = (entry: WorkspaceTreeEntry, showIgnored: boolean, hideTests: boolean): boolean => {
    if (!showIgnored && entry.ignored === true) {
        return false;
    }
    return !(hideTests && isTestEntry(entry.name, entry.type));
};
