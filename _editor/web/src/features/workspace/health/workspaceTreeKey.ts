import { workspaceTreeKeyFor } from "../../../lib/files/workspaceTreeCache";
import { workspaceAgent } from "../../../app/workspaceScope";

// The tree's cache entries, apart from the explorer so a reader of the tree needs no more than its key. The key itself
// is lib/files/workspaceTreeCache.ts's, shared with the file-reference resolver; these name the scopes the Workspace
// reads by.

// The tree on screen, read live: the prefetch loader asks before anything mounts.
export const workspaceTreeKey = (): unknown[] => workspaceTreeKeyFor(workspaceAgent.value);

// The shared tree whichever checkout is on screen, under the very entry the explorer reads it through when unscoped.
export const sharedWorkspaceTreeKey = (): unknown[] => workspaceTreeKeyFor(undefined);
