import { WORKSPACE_TREE } from "../../../lib/queryKeys";
import { UNPERSISTED } from "../../../lib/queryPersistence";
import { workspaceAgent } from "../health/workspaceScope";

// The tree's cache entries, apart from the explorer so a reader of the tree needs no more than its key. Scope is part
// of the key: different scopes are different trees. UNPERSISTED: a wide workspace runs to tens of thousands of entries,
// and the mirror structured-cloning it every couple of seconds stalls the main thread longer than the paint it saves.

const treeKeyOf = (scope: string): unknown[] => WORKSPACE_TREE.of(scope, UNPERSISTED);

// The tree on screen, read live: the prefetch loader asks before anything mounts.
export const workspaceTreeKey = (): unknown[] => treeKeyOf(workspaceAgent.value ?? `shared`);

// The shared tree whichever checkout is on screen, under the very entry the explorer reads it through when unscoped.
export const sharedWorkspaceTreeKey = (): unknown[] => treeKeyOf(`shared`);
