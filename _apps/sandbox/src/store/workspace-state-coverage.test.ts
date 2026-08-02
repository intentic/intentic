import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

/* THE GUARD THAT THE PREVIOUS TABLE DIDN'T HAVE — now only half a guard, because the compiler took the other half.
 *
 * `.intentic/drafts/` went missing from the browser's invalidation table for one reason: the test that covered
 * that table asserted the entries it already had. A list checked against itself can only ever confirm what
 * someone remembered to write down, which is the failure AGENTS.md names — "a hardcoded file list repeats the
 * miss it exists to prevent" — so this recognizes violations by their SHAPE instead.
 *
 * "Every path the daemon builds is declared" is no longer checked here: `statePath` (workspace/state-paths.ts)
 * takes `WorkspaceStatePath`, the literal union of the table's own paths, so an undeclared path does not compile.
 * That is a stronger statement than a regex sweep can make — it holds for computed call sites, generated leaves
 * and shapes this pattern would never have matched — but it holds only for paths that go THROUGH statePath. So
 * the first test below has changed job: it enforces that they all do.
 *
 * The second direction is still this file's alone. Nothing in the type system notices a table entry whose store
 * was deleted, and that entry would quietly keep invalidating a query for a file that can no longer change.
 *
 * Scope is deliberately the WORKSPACE ROOT's .intentic/. A repo's own `<repo>/.intentic/ui/` (panels.routes) is a
 * different space entirely — it is not what the watcher reports and not what these queries read — so the root
 * expression is part of the pattern rather than something to filter out afterwards. */

// The identifiers the daemon builds workspace-root paths from. A `join(dir, ".intentic", …)` where `dir` is a
// REPO is out of scope by construction, which is why this matches on the expression rather than on ".intentic".
const ROOT_EXPRESSIONS = new Set(["workspace.root", "services.workspace.root", "workspaceRoot", "root", "config.workspaceRoot"]);

const SOURCE_ROOT = join(import.meta.dirname, "..");

// The module that REPLACES the raw spelling has to quote it to explain itself, and a doc comment is not a call.
const EXEMPT = "workspace/state-paths.ts";

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

// `join(<root>, ".intentic", "a", "b")` — the raw spelling `statePath` replaced. A bare `join(root, ".intentic")`
// (the AI-credential root, not a manifest) has no segments and is legitimately not a table entry.
const RAW_JOIN = /join\(\s*([A-Za-z_.]+)\s*,\s*"\.intentic"\s*((?:,\s*"[^"]+"\s*)+)(?=[,)])/g;
// `statePath(<root>, ".intentic/…")` — the declared spelling. Only the table path matters; any `tail` after it is
// a leaf beneath a declared directory prefix.
const STATE_PATH = /statePath\(\s*[A-Za-z_.]+\s*,\s*"(\.intentic\/[^"]+)"/g;

const scanSources = async (): Promise<{ rawJoins: string[]; statePaths: string[] }> => {
    const files = await sourceFiles(SOURCE_ROOT);
    const rawJoins: string[] = [];
    const statePaths: string[] = [];
    for (const file of files) {
        const text = await readFile(file, "utf8");
        const source = file.slice(SOURCE_ROOT.length + 1);
        for (const match of source === EXEMPT ? [] : text.matchAll(RAW_JOIN)) {
            const [, rootExpression = "", rest = ""] = match;
            if (!ROOT_EXPRESSIONS.has(rootExpression)) {
                continue;
            }
            const segments = [...rest.matchAll(/"([^"]+)"/g)].map(([, segment]) => segment);
            rawJoins.push(`.intentic/${segments.join("/")} (${source})`);
        }
        for (const [, path = ""] of text.matchAll(STATE_PATH)) {
            statePaths.push(path);
        }
    }
    return { rawJoins, statePaths };
};

test("every workspace-root .intentic path goes through statePath, where the table's type can check it", async () => {
    const { rawJoins, statePaths } = await scanSources();
    // Sanity: if the pattern ever stops matching, this file would pass vacuously and guard nothing.
    expect(statePaths.length).toBeGreaterThan(10);

    expect(
        [...new Set(rawJoins)].toSorted(),
        'Build these with statePath(root, ".intentic/…") from workspace/state-paths.ts instead of join(). A raw join bypasses WorkspaceStatePath, so the path can name a file WORKSPACE_STATE_FILES doesn\'t declare and no view ever refreshes for it.',
    ).toEqual([]);
});

test("every declared entry is actually built somewhere in the daemon", async () => {
    // The direction the compiler cannot see: an entry left behind after its store was deleted is a rule nothing
    // exercises, and it would quietly keep invalidating a query for a file that can no longer change.
    const { statePaths } = await scanSources();
    const unused = WORKSPACE_STATE_FILES.filter((file) => !statePaths.some((path) => path === file.path || path.startsWith(file.path))).map(
        (file) => file.path,
    );

    expect(unused.toSorted(), "These are declared but no daemon source builds them — drop them or fix the path.").toEqual([]);
});
