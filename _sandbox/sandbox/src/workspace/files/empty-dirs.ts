import { join, resolve } from "node:path";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope, toRelPath } from "@intentic/workspace-ignore";
import { type DirReads, freshDirReads } from "./dir-reads.js";

// Every workspace directory whose subtree holds no files: debris left by a move, since git tracks no directories to
// clean them up.
// Its own walk rather than the tree walk's output, since that walk's entry budget makes an unlisted directory unknown,
// not empty; emptiness is one cheap readdir instead.
// Content is anything this walk won't descend into:
// - a file, however small
// - a symlink, never followed, always content
// - an ignored directory
// - a locked directory (the daemon's own control plane)
// A directory whose children are all barren is itself barren.
// Fixture exemptions (reference shelf, outbox) are policy in pages/workspace/emptyDirs.ts, not a filesystem fact.

// One readdir each; past this cap the walk under-reports rather than claims ground it never checked.
const MAX_SCAN_DIRS = 20_000;

// A subtree's answer: whether it's barren, and every barren path inside it, parent immediately before the branch it
// heads.
interface Scanned {
    readonly barren: boolean;
    readonly found: readonly string[];
}

const NOTHING: Scanned = { barren: false, found: [] };

// Every barren directory, root-relative, in tree order (parents before children, siblings alphabetical). Complete
// unless the pathological maxDirs cap cuts it to a prefix.
export const scanBarrenDirs = async (root: string, options?: { maxDirs?: number; reads?: DirReads }): Promise<string[]> => {
    const base = resolve(root);
    const reads = options?.reads ?? freshDirReads();
    let budget = options?.maxDirs ?? MAX_SCAN_DIRS;

    const visit = async (abs: string, rel: string, parentScope: IgnoreScope): Promise<Scanned> => {
        if (budget <= 0) {
            return NOTHING;
        }
        budget--;
        const names = await reads.names(abs);
        if (names === undefined) {
            // Unreadable is unknown, not empty; nothing to offer for deletion.
            return NOTHING;
        }
        // Layers this directory's own .gitignore onto its parents', same as the tree walk, so the two agree.
        const scope = parentScope.layer(rel, names.gitignore);
        // Only plain directories are named, so a symlink is content here.
        const children = names.dirs
            .map((name) => ({ name, abs: join(abs, name), path: toRelPath(base, join(abs, name)) }))
            .filter((child) => !scope.isIgnored(child.name, child.path, true) && !isLockedWorkspacePath(child.path));
        // Anything this walk won't descend into is content, which stops the branch here.
        let all = names.others === 0 && children.length === names.dirs.length;
        children.sort((left, right) => left.name.localeCompare(right.name));
        const scanned = await Promise.all(children.map((child) => visit(child.abs, child.path, scope)));

        const found: string[] = [];
        for (const result of scanned) {
            if (!result.barren) {
                all = false;
            }
            found.push(...result.found);
        }
        // The directory itself comes first, ahead of the branch it heads, so the output reads as a tree.
        return all ? { barren: true, found: [rel, ...found] } : { barren: false, found };
    };

    const { found } = await visit(base, "", createIgnoreScope(reads.matchers));
    // The workspace root itself is dropped (empty-string path, nothing to sweep there); everything inside stands.
    return found.filter((path) => path !== "");
};
