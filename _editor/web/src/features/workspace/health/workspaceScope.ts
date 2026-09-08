import { ref } from "vue";

// Whose copy of the workspace this view shows: a conversation's checkout, or the shared /work tree (undefined).
// Module-level singleton, since consumers span outside the Workspace (chat sets it, the route mirrors it).
// One scope at a time: switching re-points the whole view, and it is read-only, since the daemon refuses writes into a
// checkout.
export const workspaceAgent = ref<string | undefined>(undefined);

// Scope as a query parameter for routes that take one; appends nothing for the shared tree, so existing
// URLs stay unchanged.
export const scopeQuery = (query: URLSearchParams): URLSearchParams => {
    if (workspaceAgent.value !== undefined) {
        query.set(`agent`, workspaceAgent.value);
    }
    return query;
};
