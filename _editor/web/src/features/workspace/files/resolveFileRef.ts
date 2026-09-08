import type { WorkspaceResolveResponse } from "@intentic/api-contract";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { resolveInTree } from "./fileRefs";
import { scopeQuery } from "../health/workspaceScope";

// Falls back to the daemon when the cached tree can't resolve a reference: past its 5000-entry cap, an ignored
// directory, or a file written since the last fetch. Split from fileRefs because this reaches the sandbox client,
// which synchronous markdown rendering must not pull in.

// Resolves to undefined both when nothing matches and when the request fails, so the caller falls back to the literal
// path.
export const resolveWorkspaceRef = async (path: string): Promise<string | undefined> => {
    const local = resolveInTree(path);
    if (local !== undefined) {
        return local;
    }
    // Scoped, so a file that exists only in a conversation's checkout can resolve at all.
    const query = scopeQuery(new URLSearchParams({ path }));
    const resolved = await sandboxJson<WorkspaceResolveResponse>(`/workspace/resolve?${query.toString()}`).catch(() => undefined);
    return resolved?.path;
};
