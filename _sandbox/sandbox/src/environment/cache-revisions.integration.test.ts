// The daemon's offer to bring an approved block within the apt cache rule: written as an ordinary draft named after the
// block, never twice, never over a draft already waiting, and never again once the owner has answered that exact
// revision. Real files in a temporary workspace, through the same store the sweep uses.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { readWorkspaceFile, writeWorkspaceFile } from "../workspace/files/workspace-files.js";
import { synthesizeCacheRevisions } from "./cache-revisions.js";
import { fileRuntimeInstallsStore } from "./runtime-installs.js";

const CUSTOM = `# ---- ffmpeg ----
# ffmpeg — encoding screen recordings.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends ffmpeg \\
    && rm -rf /var/lib/apt/lists/*

# ---- gh ----
# GitHub CLI.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\
    apt-get update && apt-get install -y --no-install-recommends gh

# ---- bun ----
RUN curl -fsSL https://bun.sh/install | bash
`;

const setup = async () => {
    const root = mkdtempSync(join(tmpdir(), "cache-revisions-"));
    await writeWorkspaceFile(join(root, ".intentic/config/environment.custom.Dockerfile"), CUSTOM);
    const runtimeInstalls = fileRuntimeInstallsStore(join(root, "runtime-installs.json"));
    return { root, deps: { workspace: { root }, files: { read: readWorkspaceFile, write: writeWorkspaceFile }, runtimeInstalls } };
};

const draftPath = (root: string, block: string) => join(root, ".intentic/config/environment.d", `${block}.Dockerfile`);

test("drafts a revision for the block that breaks the rule, and only that one", async () => {
    const { root, deps } = await setup();
    expect(await synthesizeCacheRevisions(deps)).toEqual(["ffmpeg"]);
    const draft = await readWorkspaceFile(draftPath(root, "ffmpeg"));
    expect(draft).toContain("--mount=type=cache,target=/var/lib/apt/lists,sharing=locked");
    expect(draft).not.toContain("rm -rf");
    // The block's own words come through: the card shows them as the replacement's purpose.
    expect(draft?.startsWith("# ffmpeg — encoding screen recordings.\n")).toBe(true);
    expect(await readWorkspaceFile(draftPath(root, "gh"))).toBeUndefined();
    expect(await readWorkspaceFile(draftPath(root, "bun"))).toBeUndefined();
});

test("a draft already waiting for the block is the owner's to answer first", async () => {
    const { root, deps } = await setup();
    await writeWorkspaceFile(draftPath(root, "ffmpeg"), "RUN echo an agent's own revision\n");
    expect(await synthesizeCacheRevisions(deps)).toEqual([]);
    expect(await readWorkspaceFile(draftPath(root, "ffmpeg"))).toBe("RUN echo an agent's own revision\n");
});

test("a revision the owner declined is not offered again", async () => {
    const { root, deps } = await setup();
    await synthesizeCacheRevisions(deps);
    const offered = (await readWorkspaceFile(draftPath(root, "ffmpeg"))) ?? "";
    // What rejectDraft records: the block's name and the hash of exactly the steps it was shown.
    await deps.runtimeInstalls.settle([{ tool: "ffmpeg", hash: sha256Hex(offered.trim()) }], Date.now());
    const otherRoot = mkdtempSync(join(tmpdir(), "cache-revisions-"));
    await writeWorkspaceFile(join(otherRoot, ".intentic/config/environment.custom.Dockerfile"), CUSTOM);
    expect(await synthesizeCacheRevisions({ ...deps, workspace: { root: otherRoot } })).toEqual([]);
});
