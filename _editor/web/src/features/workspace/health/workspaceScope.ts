import { computed, ref } from "vue";
import { projectScope } from "../../../app/projectScope";

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

// The directory the desktop view is rooted at, "" for the whole tree: the open project (app/projectScope.ts) shows as
// its own tree, with a chip back to everything. The phone's drill-down (`?dir=`) is its own thing: a folder being
// looked into, not the project being worked on.
export const workspaceDir = computed<string>(() => projectScope.value ?? ``);

