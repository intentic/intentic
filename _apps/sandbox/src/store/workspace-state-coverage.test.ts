import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";

/* THE GUARD THAT THE PREVIOUS TABLE DIDN'T HAVE.
 *
 * `.intentic/drafts/` went missing from the browser's invalidation table for one reason: the test that covered
 * that table asserted the entries it already had. A list checked against itself can only ever confirm what
 * someone remembered to write down, which is the failure AGENTS.md names — "a hardcoded file list repeats the
 * miss it exists to prevent" — so the replacement recognizes violations by their SHAPE instead.
 *
 * It reads the daemon's own source, finds every path built under the workspace root's `.intentic/`, and fails
 * when one is absent from WORKSPACE_STATE_FILES. Adding a manifest without declaring what it makes stale is
 * therefore a failing test at the moment the path is written, not a silently dead view months later.
 *
 * Scope is deliberately the WORKSPACE ROOT's .intentic/. A repo's own `<repo>/.intentic/ui/` (panels.routes)
 * is a different space entirely — it is not what the watcher reports and not what these queries read — so the
 * root expression is part of the pattern rather than something to filter out afterwards. */

// The identifiers the daemon builds workspace-root paths from. A `join(dir, ".intentic", …)` where `dir` is a
// REPO is out of scope by construction, which is why this matches on the expression rather than on ".intentic".
const ROOT_EXPRESSIONS = new Set(["workspace.root", "services.workspace.root", "workspaceRoot", "root", "config.workspaceRoot"]);

const SOURCE_ROOT = join(import.meta.dirname, "..");

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

/* `join(<root>, ".intentic", "a", "b")` → the quoted segments after ".intentic".
 *
 * The trailing lookahead — rather than a literal `)` — is what lets a call with a COMPUTED final segment still
 * contribute its literal prefix: `join(workspace.root, ".intentic", "drafts", `${id}.json`)` matches up to
 * "drafts" and stops. Requiring the closing paren skips such a call entirely, which is how a declared directory
 * entry reads as an entry nothing builds. The declared entry is meant to be the directory prefix, not the
 * generated leaf. */
const INTENTIC_JOIN = /join\(\s*([A-Za-z_.]+)\s*,\s*"\.intentic"\s*((?:,\s*"[^"]+"\s*)*)(?=[,)])/g;

const declaredPaths = async (): Promise<{ path: string; source: string }[]> => {
    const files = await sourceFiles(SOURCE_ROOT);
    const found: { path: string; source: string }[] = [];
    for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const match of text.matchAll(INTENTIC_JOIN)) {
            const [, rootExpression = "", rest = ""] = match;
            if (!ROOT_EXPRESSIONS.has(rootExpression)) {
                continue;
            }
            const segments = [...rest.matchAll(/"([^"]+)"/g)].map(([, segment]) => segment);
            if (segments.length === 0) {
                // `join(root, ".intentic")` — the directory itself (the AI-credential root), not a manifest.
                continue;
            }
            found.push({ path: `.intentic/${segments.join("/")}`, source: file.slice(SOURCE_ROOT.length + 1) });
        }
    }
    return found;
};

test("every .intentic path the daemon builds is declared in WORKSPACE_STATE_FILES", async () => {
    const used = await declaredPaths();
    // Sanity: if the pattern ever stops matching, this test would pass vacuously and guard nothing.
    expect(used.length).toBeGreaterThan(10);

    const undeclared = used
        .filter(({ path }) => !WORKSPACE_STATE_FILES.some((file) => path === file.path || path.startsWith(file.path) || `${path}/` === file.path))
        .map(({ path, source }) => `${path} (${source})`);

    expect(
        [...new Set(undeclared)].toSorted(),
        "Add these to WORKSPACE_STATE_FILES in @intentic/sandbox-contract, each saying which browser queries it makes stale (or why it makes none).",
    ).toEqual([]);
});

test("every declared entry is actually built somewhere in the daemon", async () => {
    // The other direction: an entry left behind after its store was deleted is a rule nothing exercises, and it
    // would quietly keep invalidating a query for a file that can no longer change.
    const used = await declaredPaths();
    const unused = WORKSPACE_STATE_FILES.filter(
        (file) => !used.some(({ path }) => path === file.path || path.startsWith(file.path) || `${path}/` === file.path),
    ).map((file) => file.path);

    expect(unused.toSorted(), "These are declared but no daemon source builds them — drop them or fix the path.").toEqual([]);
});
