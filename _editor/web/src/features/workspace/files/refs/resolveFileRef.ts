import { sandboxRpc } from "../../../sandbox/client/sandboxRpc";
import { resolveInTree } from "./fileRefs";
import { type ViewScope, workspaceScope } from "../../health/workspaceScope";

// Falls back to the daemon when the cached tree can't resolve a reference: past its 5000-entry cap, an ignored
// directory, or a file written since the last fetch. Split from fileRefs because this reaches the sandbox client,
// which synchronous markdown rendering must not pull in.

// Resolves to undefined both when nothing matches and when the request fails, so the caller falls back to the literal
// path. `scope` names the tree to resolve in when it is not the one on screen (a hover over another conversation's
// link, a file peeked beside); `{ agent: undefined }` is the shared tree, and absent is the Workspace's. A held tree
// answers only for its own scope, so another scope's reference never resolves against the one on screen.
export const resolveWorkspaceRef = async (path: string, scope: ViewScope = workspaceScope()): Promise<string | undefined> => {
    const local = resolveInTree(path, scope);
    if (local !== undefined) {
        return local;
    }
    // Scoped, so a file that exists only in a conversation's checkout can resolve at all.
    const resolved = await sandboxRpc.workspace.resolve({ path, agent: scope.agent }).catch(() => undefined);
    return resolved?.path;
};
