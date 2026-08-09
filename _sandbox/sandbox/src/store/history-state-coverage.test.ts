import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { HISTORY_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

/* THE SAME GUARD AS workspace-state-coverage, pointed at the other volume.
 *
 * `/history` had no manifest at all until an environment export needed one, which is precisely how it came to
 * hold the most load-bearing state in the sandbox — every repo's real git dir, the fleet registry, the
 * checkpoint scopes — with nothing anywhere saying so. A hand-written list would rot the same way the
 * browser's invalidation table did, so this recognizes violations by their SHAPE: it reads the daemon's own
 * source, finds every path built under `historyRoot`, and fails when one is absent from HISTORY_STATE_FILES.
 *
 * Adding a store on this volume is therefore a change to one visible list — including the question that list
 * exists to force, which is whether the new state travels in a bundle, is a credential, or is regenerated.
 */

// The identifiers the daemon builds historyRoot paths from. Matching on the EXPRESSION rather than on a string
// keeps a `join(someOtherRoot, …)` out by construction, the same way the workspace guard does.
const ROOT_EXPRESSIONS = new Set(["historyRoot", "config.historyRoot"]);

const SOURCE_ROOT = join(packageRoot(import.meta.url), "src");

const sourceFiles = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return sourceFiles(path);
            }
            return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
        }),
    );
    return found.flat();
};

/* `join(<root>, "a", "b")` → the quoted segments.
 *
 * The trailing lookahead — rather than a literal `)` — is what lets a call with a COMPUTED final segment still
 * contribute its literal prefix: `join(historyRoot, "gits", encodeURIComponent(name))` matches up to "gits" and
 * stops, which is the declared entry (the directory), not the generated leaf under it.
 */
const HISTORY_JOIN = /join\(\s*([A-Za-z_.]+)\s*,\s*((?:"[^"]+"\s*,\s*)*"[^"]+"\s*)(?=[,)])/g;

const declaredPaths = async (): Promise<{ path: string; source: string }[]> => {
    const files = await sourceFiles(SOURCE_ROOT);
    const found: { path: string; source: string }[] = [];
    for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(HISTORY_JOIN)) {
            const [, rootExpression = "", rest = ""] = match;
            if (!ROOT_EXPRESSIONS.has(rootExpression)) {
                continue;
            }
            const segments = [...rest.matchAll(/"([^"]+)"/g)].map(([, segment]) => segment);
            if (segments.length === 0) {
                continue;
            }
            found.push({ path: segments.join("/"), source: file.slice(SOURCE_ROOT.length + 1) });
        }
    }
    return found;
};

const covers = (path: string, entry: string): boolean => path === entry || path.startsWith(entry) || `${path}/` === entry;

test("every /history path the daemon builds is declared in HISTORY_STATE_FILES", async () => {
    const used = await declaredPaths();
    // Sanity: if the pattern ever stops matching, this test would pass vacuously and guard nothing.
    expect(used.length).toBeGreaterThan(10);

    const undeclared = used
        .filter(({ path }) => !HISTORY_STATE_FILES.some((file) => covers(path, file.path)))
        .map(({ path, source }) => `${path} (${source})`);

    expect(
        [...new Set(undeclared)].toSorted(),
        "Add these to HISTORY_STATE_FILES in @intentic/sandbox-contract, each saying whether it travels in an environment bundle.",
    ).toEqual([]);
});

test("every declared entry is actually built somewhere in the daemon", async () => {
    // The other direction: an entry left behind after its store was deleted would keep claiming bundle space
    // (or a warning in the import report) for a file that can no longer exist.
    const used = await declaredPaths();
    const unused = HISTORY_STATE_FILES.filter((file) => !used.some(({ path }) => covers(path, file.path))).map((file) => file.path);

    expect(unused.toSorted(), "These are declared but no daemon source builds them — drop them or fix the path.").toEqual([]);
});
