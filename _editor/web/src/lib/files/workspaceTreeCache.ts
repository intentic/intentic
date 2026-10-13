import type { WorkspaceTree } from "@intentic/sandbox-contract";
import { rpcKey } from "../queryKeys";
import { queryClient, UNPERSISTED } from "../queryPersistence";

// The workspace tree's cache entries, one per scope: different scopes are different trees. UNPERSISTED: a wide
// workspace runs to tens of thousands of entries, and the mirror structured-cloning it every couple of seconds stalls
// the main thread longer than the paint it saves. Down here, below every feature, so the explorer that stores the tree
// and the file-reference resolver that reads it build one key from one place.

// One scope's tree key; `undefined` is the shared tree.
export const workspaceTreeKeyFor = (agent: string | undefined): unknown[] => rpcKey(`workspace.tree`, { agent }, UNPERSISTED);

// The tree the explorer already holds for one scope, read through the very key it is stored under; undefined until that
// scope's tree has been fetched. A reader that built a key of its own once matched nothing at all, and every file
// mention in chat silently stopped resolving in the browser.
export const cachedWorkspaceTree = (agent: string | undefined): WorkspaceTree | undefined =>
    queryClient.getQueryData<WorkspaceTree>(workspaceTreeKeyFor(agent));
