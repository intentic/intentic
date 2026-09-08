import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { repoRoot } from "@intentic/constants/node";
import { ExtensionManifestSchema, type FileContribution } from "@intentic/extension-manifest";
import { WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { isWatchIgnored } from "./workspace-watch.js";

// Pins that every declared file binding names a path the workspace watcher (isWatchIgnored) doesn't blanket-exclude, or
// the binding is a silent no-op. Only in-repo builtins are checked here.

const EXTENSIONS_ROOT = join(repoRoot(import.meta.url), "_extensions");

// The path a real change under this binding would arrive at: a directory keeps its trailing slash, a name-family prefix
// ends mid-name, so neither alone is a file the watcher emits; probes with a plausible child instead.
const probePath = (path: string): string => join(WORKSPACE_ROOT, path.endsWith("/") ? `${path}probe` : path);

const builtinBindings = async (): Promise<{ owner: string; binding: FileContribution }[]> => {
    const packages = (await readdir(EXTENSIONS_ROOT, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const found = await Promise.all(
        packages.map(async ({ name }) => {
            let text: string;
            try {
                text = await readFile(join(EXTENSIONS_ROOT, name, "intentic-extension.json"), "utf8");
            } catch {
                // Not an extension package (a stray dir, the shelf's README); nothing to check.
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
    // Sanity: this guard is worthless if the manifests stopped being found or parsed.
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
    // Same invariant for the core half; a no-invalidations entry is exempt, often because it's rightly unwatched.
    const dead = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.length > 0 && isWatchIgnored(WORKSPACE_ROOT, probePath(file.path))).map(
        (file) => file.path,
    );

    expect(dead.toSorted(), "These declare invalidations for paths the watcher excludes — the queries can never be made stale.").toEqual([]);
});
