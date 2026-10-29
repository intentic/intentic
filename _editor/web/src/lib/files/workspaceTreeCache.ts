import type { WorkspaceScope, WorkspaceTree } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { rpcKey } from "../queryKeys";
import { queryClient, UNPERSISTED } from "../queryPersistence";

// The workspace tree's cache entries, one per scope: different scopes are different trees. UNPERSISTED: a wide
// workspace runs to tens of thousands of entries, and the mirror structured-cloning it every couple of seconds stalls
// the main thread longer than the paint it saves. Down here, below every feature, so the explorer that stores the tree
// and the file-reference resolver that reads it build one key from one place.

// One scope's tree key; nothing set is the shared tree. Only the scope's own fields, so the shared tree's key is the one
// it always was.
export const workspaceTreeKeyFor = (scope: WorkspaceScope): unknown[] =>
    rpcKey(`workspace.tree`, { agent: scope.agent, branch: scope.branch, repo: scope.repo }, UNPERSISTED);

// The tree the explorer already holds for one scope, read through the very key it is stored under; undefined until that
// scope's tree has been fetched. A reader that built a key of its own once matched nothing at all, and every file
// mention in chat silently stopped resolving in the browser.
export const cachedWorkspaceTree = (scope: WorkspaceScope): WorkspaceTree | undefined =>
    queryClient.getQueryData<WorkspaceTree>(workspaceTreeKeyFor(scope));
