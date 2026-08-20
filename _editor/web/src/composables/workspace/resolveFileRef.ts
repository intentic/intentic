import type { WorkspaceResolveResponse } from "@intentic-app/api-contract";
import { sandboxJson } from "../sandbox/sandboxClient";
import { resolveInTree } from "./fileRefs";
import { scopeQuery } from "./workspaceScope";

/* The last word on where a named file reference points, for the moment a user actually clicks one.
 *
 * The cached tree answers almost every reference for free (resolveInTree), so this exists for what that copy
 * cannot see: a workspace whose tree walk hit its 5000-entry cap, a file under an ignored dir the explorer
 * lazy-loads, or a file written since the last tree fetch. The daemon matches with the SAME rules against the
 * iq engine's full sweep, so the two never disagree about a reference both can see.
 *
 * Split from fileRefs because it reaches the sandbox client: markdown RENDERING resolves against the tree
 * synchronously and must not pull the request/auth graph in, only the click does. */

// The workspace path a reference means, or undefined when nothing in the workspace matches it. A failed
// request resolves to undefined rather than throwing: the caller falls back to the literal path, which lands on
// the file viewer's not-found state, the same place an unresolvable reference has always landed.
export const resolveWorkspaceRef = async (path: string): Promise<string | undefined> => {
    const local = resolveInTree(path);
    if (local !== undefined) {
        return local;
    }
    // Scoped, so a file that exists ONLY in a conversation's checkout resolves at all, which is the whole
    // point of a link written inside that conversation (see workspaceScope).
    const query = scopeQuery(new URLSearchParams({ path }));
    const resolved = await sandboxJson<WorkspaceResolveResponse>(`/workspace/resolve?${query.toString()}`).catch(() => undefined);
    return resolved?.path;
};
