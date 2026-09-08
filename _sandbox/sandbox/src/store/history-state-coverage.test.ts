import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { HISTORY_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

// Same guard as workspace-state-coverage but for /history: scans daemon source for every historyRoot-based path and
// fails if it is not declared in HISTORY_STATE_FILES.

// Matched by expression, not string, so a `join(someOtherRoot, …)` call is excluded by construction.
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

// Matches `join(<root>, "a", "b")`; the lookahead lets a computed final segment still contribute its literal prefix.
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
    // Guards against the regex matching nothing, which would make this test pass vacuously.
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
    // Catches an entry left behind after its store was deleted.
    const used = await declaredPaths();
    const unused = HISTORY_STATE_FILES.filter((file) => !used.some(({ path }) => covers(path, file.path))).map((file) => file.path);

    expect(unused.toSorted(), "These are declared but no daemon source builds them — drop them or fix the path.").toEqual([]);
});
