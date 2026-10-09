import { join } from "node:path";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { withAptCaches } from "./apt-cache-rule.js";
import { draftFileName } from "./auto-drafts.js";
import { splitBlocks, uniqueBlocks } from "./overlay-blocks.js";
import type { RuntimeInstallsStore } from "./runtime-installs.js";
import { statePath } from "../state-paths.js";

// Offers the owner a corrected copy of every approved block that breaks the apt cache rule (apt-cache-rule.ts). The rule
// is checked when an agent proposes, but blocks approved before it existed were never checked again, and each one
// commits every .deb it installs into the image and downloads them all again on every rebuild. The fix is mechanical
// (two mount flags, one deletion fewer), so the daemon drafts it rather than waiting for an agent to notice.
//
// A revision is an ordinary draft named after the block it revises, so the existing pipeline does the rest: the
// Environment card shows it as that block's pending replacement, approving it replaces the block (a draft file is named
// by its tool), and declining it settles it, after which this pass leaves that exact revision alone. Nothing is changed
// without the owner's approval, and nothing about the block other than the cache handling changes.

interface CacheRevisionDeps {
    readonly workspace: { readonly root: string };
    readonly files: {
        readonly read: (path: string) => Promise<string | undefined>;
        readonly write: (path: string, content: string) => Promise<void>;
    };
    readonly runtimeInstalls: Pick<RuntimeInstallsStore, "read">;
}

const customPathOf = (root: string): string => statePath(root, ".intentic/config/environment.custom.Dockerfile");
const draftsDirOf = (root: string): string => statePath(root, ".intentic/config/environment.d/");

// Writes a revision draft for every approved block that needs one and has none waiting; returns the blocks drafted, for
// the sweep's log line. Spawn-free, file reads only, so it rides the drift sweep's tick.
export const synthesizeCacheRevisions = async (deps: CacheRevisionDeps): Promise<string[]> => {
    const custom = (await deps.files.read(customPathOf(deps.workspace.root))) ?? "";
    const settled = new Set(((await deps.runtimeInstalls.read()).settled ?? []).map((entry) => `${entry.tool}\u0000${entry.hash}`));
    const drafted: string[] = [];
    for (const block of uniqueBlocks(splitBlocks(custom.trim()))) {
        const file = draftFileName(block.name);
        // An unnamed block (text before the first marker) cannot be replaced by name, so it has no draft to be.
        if (block.name === "" || file === undefined || file.slice(0, -".Dockerfile".length) !== block.name) {
            continue;
        }
        const revised = withAptCaches(block.body);
        if (revised === undefined || settled.has(`${block.name}\u0000${sha256Hex(revised.trim())}`)) {
            continue;
        }
        const path = join(draftsDirOf(deps.workspace.root), file);
        // A draft already waiting for this block, an agent's or an earlier pass's, is the owner's to answer first.
        if ((await deps.files.read(path)) !== undefined) {
            continue;
        }
        await deps.files.write(path, `${revised.trim()}\n`);
        drafted.push(block.name);
    }
    return drafted;
};
