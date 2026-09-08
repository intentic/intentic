import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS, isAgentWorktreePath, REFERENCE_DIR } from "@intentic/workspace-ignore";
import { STATE_DIR } from "@intentic/constants";
import { ensureSidecar, type Outcome } from "./derive.js";
import { isCandidatePath } from "./formats.js";
import { DERIVED_DIR, removeSidecar } from "./sidecar.js";

// Whole-workspace pass: converges every derivable file and removes every orphaned shadow, making the sidecar tree a
// statement about the workspace as it is now, not as the watcher's incremental view has it.
// Sequential on purpose, since it shares the box with the agent it's shadowing; parallel parses would cost that
// argument.
// Skips what the daemon's watcher skips (machine subtrees, the state dir, the reference shelf), so the two never
// disagree about what's workspace.

const skipDir = (relPath: string, name: string, childRel: string): boolean =>
    IGNORED_DIRS.has(name) || name === STATE_DIR || (relPath === "" && name === REFERENCE_DIR) || isAgentWorktreePath(childRel);

const walk = async (root: string, relPath: string, found: string[]): Promise<void> => {
    const entries = await readdir(join(root, relPath), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const childRel = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
        if (entry.isDirectory()) {
            if (!skipDir(relPath, entry.name, childRel)) {
                await walk(root, childRel, found);
            }
        } else if (entry.isFile() && isCandidatePath(entry.name)) {
            found.push(childRel);
        }
    }
};

// Shadow tree's own walk, for orphan pruning: every `<rel>.md` under derived/ names the source it shadows.
const walkSidecars = async (root: string, relPath: string, found: string[]): Promise<void> => {
    const entries = await readdir(join(root, DERIVED_DIR, relPath), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const childRel = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
        if (entry.isDirectory()) {
            await walkSidecars(root, childRel, found);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
            found.push(childRel.slice(0, -3));
        }
    }
};

export interface SweepResult {
    readonly outcomes: Outcome[];
    /** Sources of shadows whose file vanished since they were derived, removed by this sweep. */
    readonly pruned: string[];
}

export const sweep = async (workspaceRoot: string, onOutcome?: (outcome: Outcome) => void): Promise<SweepResult> => {
    const candidates: string[] = [];
    await walk(workspaceRoot, "", candidates);
    const outcomes: Outcome[] = [];
    for (const relPath of candidates) {
        const outcome = await ensureSidecar(workspaceRoot, join(workspaceRoot, relPath));
        outcomes.push(outcome);
        onOutcome?.(outcome);
    }
    const shadowed: string[] = [];
    await walkSidecars(workspaceRoot, "", shadowed);
    const alive = new Set(candidates);
    const pruned: string[] = [];
    for (const relPath of shadowed) {
        if (!alive.has(relPath) && (await stat(join(workspaceRoot, relPath)).catch(() => undefined)) === undefined) {
            await removeSidecar(workspaceRoot, relPath);
            pruned.push(relPath);
        }
    }
    return { outcomes, pruned };
};
