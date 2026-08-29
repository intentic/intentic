import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS, isAgentWorktreePath, REFERENCE_DIR } from "@intentic/workspace-ignore";
import { STATE_DIR } from "@intentic/constants";
import { ensureSidecar, type Outcome } from "./derive.js";
import { isCandidatePath } from "./formats.js";
import { DERIVED_DIR, removeSidecar } from "./sidecar.js";

/* The whole-workspace pass: every derivable file converged, every orphaned shadow removed. This is what makes
 * the sidecar tree a statement about the workspace as it IS rather than as it has changed since someone
 * started watching — the daemon runs it at enablement and after mass changes the watcher could only report as
 * "many things moved", and `fileq sweep` is the same pass by hand.
 *
 * Sequential on purpose: a sweep shares the box with the agent whose files it is shadowing, and eight pdf
 * parses in parallel is a way to lose that argument. The walk skips what the daemon's watcher skips (machine
 * subtrees, the state dir, the root reference shelf) so the two can never disagree about what is workspace. */

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

// The shadow tree's own walk, for orphan pruning: every `<rel>.md` under derived/ names the source it shadows.
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
