import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import { unstubbed } from "@intentic/testing";
import { workspaceExtensionsRoot } from "../../../capabilities/extension-dirs.js";
import { approveExtension } from "../../../capabilities/extension-inventory/extension-approvals.js";
import type { Services } from "../../../composition.js";
import { stateRelPath } from "../../../state-paths.js";
import type { IsolatedAgent } from "../../registry/agents-store.js";
import { landingExtensionsOf } from "./review-extensions.js";

// The review says, before the press, which workspace extensions landing turns on: read from the conversation's own copy
// of each folder its rows touch, judged against the approvals as they stand.

const MANIFEST = { publisher: "acme", name: "toolbox", version: "1.0.0", engines: { intentic: "^0.2.0" }, permissions: { sandbox: ["GET /panels"] } };
const WIDER = { ...MANIFEST, version: "1.1.0", permissions: { sandbox: ["GET /panels", "POST /panels/*/start"] } };

const MANIFEST_PATH = stateRelPath(".intentic/config/workspace-extensions/", "toolbox", "intentic-extension.json");
const rowsOf = (...paths: string[]) => [{ repo: "root", changes: paths.map((path) => ({ path })) }];

// The conversation's copy of the root repository holding `manifest`, and an approval ledger beside it.
const copyWith = async (manifest: object) => {
    const copy = mkdtempSync(join(tmpdir(), "review-ext-copy-"));
    const historyRoot = mkdtempSync(join(tmpdir(), "review-ext-history-"));
    const dir = join(workspaceExtensionsRoot(copy), "toolbox");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(manifest));
    const deps = {
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { worktreeDir: () => copy }),
        config: { historyRoot },
    };
    // SAFETY: only `id` is read of the record, to name its copy.
    const entry = { id: "conv-1" } as IsolatedAgent;
    return { deps, entry, historyRoot };
};

test("a new workspace extension in the work is listed with every power landing gives it", async () => {
    const { deps, entry } = await copyWith(MANIFEST);

    expect(await landingExtensionsOf(deps, entry, rowsOf(MANIFEST_PATH, "README.md"))).toEqual([
        { id: "acme.toolbox", dir: "toolbox", powers: [expect.stringContaining("GET /panels")], approvedBefore: false },
    ]);
});

test("one already approved for what it declares is not listed, and one asking for more lists only what it gains", async () => {
    const { deps, entry, historyRoot } = await copyWith(MANIFEST);
    await approveExtension(historyRoot, "acme.toolbox", ExtensionManifestSchema.parse(MANIFEST));
    expect(await landingExtensionsOf(deps, entry, rowsOf(MANIFEST_PATH))).toEqual([]);

    const wider = await copyWith(WIDER);
    await approveExtension(wider.historyRoot, "acme.toolbox", ExtensionManifestSchema.parse(MANIFEST));
    expect(await landingExtensionsOf(wider.deps, wider.entry, rowsOf(MANIFEST_PATH))).toEqual([
        { id: "acme.toolbox", dir: "toolbox", powers: [expect.stringContaining("POST /panels/*/start")], approvedBefore: true },
    ]);
});

test("work that touches no extension folder, or only another repository's, lists none", async () => {
    const { deps, entry } = await copyWith(MANIFEST);

    expect(await landingExtensionsOf(deps, entry, rowsOf("README.md"))).toEqual([]);
    expect(await landingExtensionsOf(deps, entry, [{ repo: "app", changes: rowsOf(MANIFEST_PATH)[0]?.changes ?? [] }])).toEqual([]);
});
