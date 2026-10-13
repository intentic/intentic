import type { WorkspaceResolve } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { matchesInTree } from "../../../../lib/files/fileRefs";
import { type ViewScope, workspaceScope } from "../../../../app/workspaceScope";

// Falls back to the daemon when the cached tree can't resolve a reference: past its 5000-entry cap, an ignored
// directory, a file written since the last fetch, or a conversation's copy whose tree was never fetched here. Split
// from fileRefs because this reaches the sandbox client, which synchronous markdown rendering must not pull in.

// What a reference means in one copy: the daemon's answer (one file, several, or none with what it may have meant), or
// undefined when nobody could be asked, which is no answer at all rather than "no such file". `scope` names the tree to
// resolve in when it is not the one on screen (a hover over another conversation's link, a file peeked beside);
// `{ agent: undefined }` is the shared tree, and absent is the Workspace's. A held tree answers only for its own scope,
// so another scope's reference never resolves against the one on screen.
export const lookUpWorkspaceRef = async (path: string, scope: ViewScope = workspaceScope()): Promise<WorkspaceResolve | undefined> => {
    const [best, ...others] = matchesInTree(path, scope) ?? [];
    if (best !== undefined) {
        return others.length === 0 ? { path: best } : { path: best, others: [...others] };
    }
    // Scoped, so a file that exists only in a conversation's checkout can resolve at all.
    return sandboxRpc.workspace.resolve({ path, agent: scope.agent }).catch(() => undefined);
};

// The one file a reference most likely means, or undefined both when nothing matches and when the request fails, so
// the caller falls back to the literal path.
export const resolveWorkspaceRef = async (path: string, scope: ViewScope = workspaceScope()): Promise<string | undefined> =>
    (await lookUpWorkspaceRef(path, scope))?.path;
