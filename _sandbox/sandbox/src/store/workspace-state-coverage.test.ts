import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

// Checks every workspace-root .intentic path is built through statePath, whose WorkspaceStatePath union makes an
// undeclared path a compile error; this file now only checks declared entries are actually used.

// Matched by expression, not by ".intentic", so a `join(<repoDir>, ".intentic", …)` stays out of scope.
const ROOT_EXPRESSIONS = new Set(["workspace.root", "services.workspace.root", "workspaceRoot", "root", "config.workspaceRoot"]);

const SOURCE_ROOT = join(packageRoot(import.meta.url), "src");

// state-paths.ts itself must quote the raw spelling to define it; that's not a bypass to flag.
const EXEMPT = "workspace/layout/state-paths.ts";

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

// Matches `join(<root>, ".intentic"|STATE_DIR, …)`, the raw spellings statePath replaces; segments may be identifiers,
// not just string literals.
const RAW_JOIN = /join\(\s*([A-Za-z_.]+)\s*,\s*(?:"\.intentic"|STATE_DIR)\s*((?:,\s*(?:"[^"]+"|[A-Za-z_][\w.]*)\s*)+)(?=[,)])/g;
// Matches `${STATE_DIR}/<segment>` template composition; bare `${STATE_DIR}` with nothing appended stays legal.
const RAW_TEMPLATE = /\$\{STATE_DIR\}\/[\w.-]/g;
// Matches the declared spellings `statePath(<root>, ".intentic/…")` and `stateRelPath(".intentic/…")`.
const STATE_PATH = /statePath\(\s*[A-Za-z_.]+\s*,\s*"(\.intentic\/[^"]+)"|stateRelPath\(\s*"(\.intentic\/[^"]+)"/g;

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
            const segments = [...rest.matchAll(/"([^"]+)"|([A-Za-z_][\w.]*)/g)].map(([, segment, expr]) => segment ?? `<${expr}>`);
            rawJoins.push(`.intentic/${segments.join("/")} (${source})`);
        }
        for (const [template] of source === EXEMPT ? [] : text.matchAll(RAW_TEMPLATE)) {
            rawJoins.push(`${template}… (${source})`);
        }
        for (const [, joined, relative] of text.matchAll(STATE_PATH)) {
            statePaths.push(joined ?? relative ?? "");
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
        'Build these with statePath(root, ".intentic/…") from workspace/layout/state-paths.ts instead of join(). A raw join bypasses WorkspaceStatePath, so the path can name a file WORKSPACE_STATE_FILES doesn\'t declare and no view ever refreshes for it.',
    ).toEqual([]);
});

test("every declared entry is actually built somewhere in the daemon", async () => {
    // Catches an entry left behind after its store was deleted; entries with `outsideWriter` are exempt since the
    // daemon itself never builds them.
    const { statePaths } = await scanSources();
    const unused = WORKSPACE_STATE_FILES.filter(
        (file) => file.outsideWriter === undefined && !statePaths.some((path) => path === file.path || path.startsWith(file.path)),
    ).map((file) => file.path);

    expect(unused.toSorted(), "These are declared but no daemon source builds them — drop them or fix the path.").toEqual([]);
});
