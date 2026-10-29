import { sandboxShallowRef } from "@intentic/extension-api";
import type { RepoBranch } from "@intentic/sandbox-contract/schemas/shared";
import { computed, inject, type InjectionKey, type Ref } from "vue";
import { projectScope } from "./projectScope";

/**
 * Which copy of the workspace one read names: the shared /work tree (nothing set), a conversation's private checkout
 * (`agent`), or a branch of one repository (`repo` + `branch`: inside that repository from the branch, everywhere else
 * from the shared tree). The fields are the daemon's own (WorkspaceScopeSchema), so a scope rides a read as it is.
 */
export type ViewScope =
    | { readonly agent?: undefined; readonly branch?: undefined; readonly repo?: undefined }
    | { readonly agent: string; readonly branch?: undefined; readonly repo?: undefined }
    | { readonly agent?: undefined; readonly branch: string; readonly repo: string };

export const SHARED_SCOPE: ViewScope = {};

/** A conversation's copy, or the shared tree for none. */
export const agentScope = (agent: string | undefined): ViewScope => (agent === undefined ? SHARED_SCOPE : { agent });

/** A branch of one repository, or the shared tree for none. */
export const branchScope = (from: RepoBranch | undefined): ViewScope => (from === undefined ? SHARED_SCOPE : { repo: from.repo, branch: from.branch });

/** Whether a scope is the shared tree, the default checkout. */
export const isShared = (scope: ViewScope): boolean => scope.agent === undefined && scope.branch === undefined;

/** A branch as the reader names it: the branch alone for the workspace's own repository, its folder first for another. */
export const branchLabel = (from: RepoBranch): string => (from.repo === `root` ? from.branch : `${from.repo} · ${from.branch}`);

/** One string per scope, for a cache entry or a version key: two scopes are one read only when this matches. */
export const scopeKey = (scope: ViewScope): string =>
    scope.agent !== undefined ? `agent:${scope.agent}` : scope.branch !== undefined ? `branch:${scope.repo}\n${scope.branch}` : ``;

export const sameScope = (a: ViewScope, b: ViewScope): boolean => scopeKey(a) === scopeKey(b);

/** The scope as a read's input fields: only the set ones, so the shared tree's reads stay as they were. */
export const scopeFields = (scope: ViewScope): { agent?: string; branch?: string; repo?: string } =>
    scope.agent !== undefined ? { agent: scope.agent } : scope.branch !== undefined ? { branch: scope.branch, repo: scope.repo } : {};

// Which copy the Workspace shows. A per-person view, kept in this browser: nothing moves on disk, and the shared
// checkout stays on its main line whatever anyone looks at. Module-level singleton, since consumers span outside the
// Workspace (chat sets it, the route mirrors it); one sandbox's, so a switch goes back to the shared tree.
export const workspaceView = sandboxShallowRef<ViewScope>(() => SHARED_SCOPE);

// The conversation whose copy is on screen, undefined for the shared tree or a branch. Writing one switches the view to
// that copy (or, undefined, back to the shared tree).
export const workspaceAgent = computed<string | undefined>({
    get: () => workspaceView.value.agent,
    set: (agent) => {
        if (agent !== workspaceView.value.agent || agent === undefined) {
            workspaceView.value = agentScope(agent);
        }
    },
});

// The Workspace's own scope, as a read names it: what a read that names none reads.
export const workspaceScope = (): ViewScope => workspaceView.value;

// Whose copy one SURFACE reads, for a surface showing a file outside the Workspace's scope: a file peeked in the side
// panel from a conversation's chat reads that conversation's copy without switching the Workspace to it. Provided around
// the surface, read by the viewers under it; unprovided, it is the Workspace's own. `Symbol.for`, so a hot reload of this
// module hands a viewer the key its surface provided.
export const VIEW_SCOPE: InjectionKey<Readonly<Ref<ViewScope>>> = Symbol.for(`intentic.workspace.viewScope`);

export const useViewScope = (): Readonly<Ref<ViewScope>> => inject(VIEW_SCOPE, workspaceView);

// Scope as query parameters for routes that take them (`agent`, or `branch` + `repo`); appends nothing for the shared
// tree, so existing URLs stay unchanged.
export const scopeQuery = (query: URLSearchParams, scope: ViewScope = workspaceScope()): URLSearchParams => {
    for (const [name, value] of Object.entries(scopeFields(scope))) {
        query.set(name, value);
    }
    return query;
};

// The directory the desktop view is rooted at, "" for the whole tree: the open project (app/projectScope.ts) shows as
// its own tree, with a chip back to everything. The phone's drill-down (`?dir=`) is its own thing: a folder being
// looked into, not the project being worked on.
export const workspaceDir = computed<string>(() => projectScope.value ?? ``);
