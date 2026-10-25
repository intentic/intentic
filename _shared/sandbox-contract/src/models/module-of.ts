import type { WorkspaceModule } from "../schemas/git/git.js";

// Which package a repository-relative path lives in, the one rule every reader buckets files by: the review panels
// group a change list with it, and the sandbox names the packages a conversation's work falls in for its card, so the
// two can never put one file in different packages.

// Longest matching module dir wins, so a nested package claims its own files before its parent.
// dir "" claims what nothing deeper claims; the trailing separator keeps `_apps/webx` from matching `_editor/web`.
export const moduleOf = (path: string, modules: readonly WorkspaceModule[]): WorkspaceModule | undefined => {
    let best: WorkspaceModule | undefined;
    for (const candidate of modules) {
        if (candidate.dir !== `` && !path.startsWith(`${candidate.dir}/`)) {
            continue;
        }
        if (best === undefined || candidate.dir.length > best.dir.length) {
            best = candidate;
        }
    }
    return best;
};
