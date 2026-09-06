import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema, type FileContribution } from "@intentic/extension-manifest";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { isWatchIgnored } from "./workspace-watch.js";

/* A DECLARED FILE BINDING MUST NAME A PATH THE WATCHER ACTUALLY REPORTS.
 *
 * Two independent lists say "this file backs that view": WORKSPACE_STATE_FILES for the core surfaces, and each
 * extension's `contributes.files` for its own. Both are only worth anything if a change to the named path
 * reaches the browser, and the thing that decides that is a predicate in ANOTHER package
 * (workspace-watch.isWatchIgnored), which blanket-excludes the daemon's machine state for good reasons that have
 * nothing to do with either list. Nothing connected the two, so a binding could name a path the watcher silently
 * drops: a declaration with no effect, indistinguishable from a working one until someone notices the view never
 * refreshes.
 *
 * That is not hypothetical. The agent's memory notes live at `.intentic/records/sessions/claude/projects/<slug>/memory/**`, under
 * the `.intentic/records/sessions/claude` prefix the watcher excludes wholesale (session transcripts are rewritten on every
 * streamed token). Declaring `{ path: ".intentic/records/sessions/claude/...", invalidates: ["memory"] }` would read as a fix and
 * do nothing. This test fails on it instead.
 *
 * Scope note: only the in-repo builtins can be checked here, a git-installed third-party manifest arrives at
 * runtime. The constraint is the same for them, which is what FileContributionSchema's comment says.
 *
 * (Why the memory dirs stay excluded rather than the exclusion being narrowed: reaching them means letting the
 * watcher descend `.intentic/records/sessions/claude` → `projects` → all 116 project slugs, measured as +119 watched directories
 * against ~593 today (a 20% rise) with 314 continuously-rewritten transcripts inside the newly-watched set, to
 * make ONE directory live. The /memory view polls instead, deliberately.) */

const EXTENSIONS_ROOT = join(repoRoot(import.meta.url), "_extensions");

// The path a real change under this binding would arrive at. A directory entry keeps its trailing slash so it
// can't prefix-match a sibling (see FileContributionSchema), and a name family ends mid-name: neither is a file
// the watcher would ever emit, so probe with a plausible child instead of the prefix itself.
const probePath = (path: string): string => join(WORKSPACE_ROOT, path.endsWith("/") ? `${path}probe` : path);

const builtinBindings = async (): Promise<{ owner: string; binding: FileContribution }[]> => {
    const packages = (await readdir(EXTENSIONS_ROOT, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const found = await Promise.all(
        packages.map(async ({ name }) => {
            let text: string;
            try {
                text = await readFile(join(EXTENSIONS_ROOT, name, "intentic-extension.json"), "utf8");
            } catch {
                // Not an extension package (the shelf's README, a stray dir): nothing to check.
                return [];
            }
            const manifest = ExtensionManifestSchema.parse(JSON.parse(text));
            return (manifest.contributes?.files ?? []).map((binding) => ({ owner: name, binding }));
        }),
    );
    return found.flat();
};

test("every extension's contributes.files path is one the workspace watcher reports", async () => {
    const bindings = await builtinBindings();
    // Sanity: the guard is worthless if the manifests stopped being found or parsed.
    expect(bindings.length).toBeGreaterThan(0);

    const dead = bindings
        .filter(({ binding }) => isWatchIgnored(WORKSPACE_ROOT, probePath(binding.path)))
        .map(({ owner, binding }) => `${owner}: ${binding.path}`);

    expect(
        dead.toSorted(),
        "The watcher never emits these paths, so the invalidations declared for them can never fire. Either narrow the exclusion in workspace-watch.ts (weigh the descent cost) or drop the binding and say why the view polls.",
    ).toEqual([]);
});

test("every core WORKSPACE_STATE_FILES entry that invalidates something names a watched path", async () => {
    // The same invariant on the core half. An entry with no invalidations is exempt by construction: most of
    // them exist precisely BECAUSE the path is daemon machine state the watcher is right to drop.
    const dead = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.length > 0 && isWatchIgnored(WORKSPACE_ROOT, probePath(file.path))).map(
        (file) => file.path,
    );

    expect(dead.toSorted(), "These declare invalidations for paths the watcher excludes — the queries can never be made stale.").toEqual([]);
});
