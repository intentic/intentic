import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceManifests, readWorkspaceManifestsAsync } from "./workspace-manifests.js";

const scaffold = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "workspace-manifests-"));
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(dir, path, ".."), { recursive: true });
        await writeFile(join(dir, path), content);
    }
    return dir;
};

const pkg = (name: string, blocks: Record<string, Record<string, string>> = {}): string => JSON.stringify({ name, ...blocks });

// The chores rail reads manifests without blocking; it must find the same packages, in the same order, as the sync
// reader dependency drift uses, or the two would disagree about what a package is.
test("the async manifest reader finds exactly what the sync one does", async () => {
    const dir = await scaffold({
        "pnpm-workspace.yaml": `packages:\n  - "_libs/*"\n  - "!_libs/private"\n  - "nested/**"\n  - "docs"\n  - "_apps/*"\n  - "missing/*"\n`,
        "_libs/ui/package.json": pkg("@shop/ui", { dependencies: { vue: "catalog:" } }),
        "_libs/broken/package.json": "{ not json",
        "_libs/private/package.json": pkg("@shop/private"),
        "_libs/scratch/notes.md": "",
        "nested/deep/pkg/package.json": pkg("@shop/deep"),
        "docs/package.json": pkg("@shop/docs"),
        // A name two dirs claim stays with the first.
        "_apps/web/package.json": pkg("@shop/ui"),
        "_apps/site/package.json": pkg("@shop/site"),
    });
    const sync = readWorkspaceManifests(dir);
    expect(sync.map((entry) => entry.dir).toSorted()).toEqual(["_apps/site", "_libs/ui", "docs"]);
    expect(await readWorkspaceManifestsAsync(dir)).toEqual(sync);
    expect(await readWorkspaceManifestsAsync(join(dir, "nowhere"))).toEqual([]);
    expect(readWorkspaceManifests(join(dir, "nowhere"))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
});
