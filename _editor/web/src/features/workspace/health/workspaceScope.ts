import { sandboxRef } from "@intentic/extension-api";
import { computed, inject, type InjectionKey, type Ref } from "vue";
import { projectScope } from "../../../app/projectScope";

// Whose copy of the workspace this view shows: a conversation's checkout, or the shared /work tree (undefined).
// Module-level singleton, since consumers span outside the Workspace (chat sets it, the route mirrors it); one
// sandbox's conversation, so a switch goes back to the shared tree. Read-only, since the daemon refuses writes into a
// checkout.
export const workspaceAgent = sandboxRef<string | undefined>(() => undefined);

/** Whose copy one read names: a conversation's checkout, or the shared tree (`agent` undefined). */
export interface ViewScope {
    readonly agent: string | undefined;
}

// The Workspace's own scope, as a read names it: what a read that names none reads.
export const workspaceScope = (): ViewScope => ({ agent: workspaceAgent.value });

// Whose copy one SURFACE reads, for a surface showing a file outside the Workspace's scope: a file peeked in the side
// panel from a conversation's chat reads that conversation's copy without switching the Workspace to it. Provided around
// the surface, read by the viewers under it; unprovided, it is the Workspace's own. `Symbol.for`, so a hot reload of this
// module hands a viewer the key its surface provided.
export const VIEW_SCOPE: InjectionKey<Readonly<Ref<string | undefined>>> = Symbol.for(`intentic.workspace.viewScope`);

export const useViewScope = (): Readonly<Ref<string | undefined>> => inject(VIEW_SCOPE, workspaceAgent);

// Scope as a query parameter for routes that take one; appends nothing for the shared tree, so existing
// URLs stay unchanged.
export const scopeQuery = (query: URLSearchParams, scope: ViewScope = workspaceScope()): URLSearchParams => {
    if (scope.agent !== undefined) {
        query.set(`agent`, scope.agent);
    }
    return query;
};

// The directory the desktop view is rooted at, "" for the whole tree: the open project (app/projectScope.ts) shows as
// its own tree, with a chip back to everything. The phone's drill-down (`?dir=`) is its own thing: a folder being
// looked into, not the project being worked on.
export const workspaceDir = computed<string>(() => projectScope.value ?? ``);

