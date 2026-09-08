import type { InjectionKey } from "vue";

// A file's context and its viewer's controls teleport into the view's tab row bar, since the components that
// produce them sit far from the one that owns the bar. Two levels: the breadcrumb rides the view's bar, and
// the viewer's own controls ride the breadcrumb; a surface with neither (phone) draws its own band.

/** Provided by a view whose bar has room for the open file's context. Absent, the breadcrumb draws its own band. */
// `Symbol.for` on both keys: a hot reload of this module must hand a viewer the key its chrome provided (useChat-view.ts).
export const HOISTED_CONTEXT: InjectionKey<boolean> = Symbol.for(`intentic.workspace.hoistedContext`);

// Distinguishes the pane when the editor splits in two; each pane's teleport targets derive from its own scope.
export const CHROME_SCOPE: InjectionKey<string> = Symbol.for(`intentic.workspace.chromeScope`);

/** The element in that bar the breadcrumb teleports into. */
export const contextTarget = (scope: string): string => `ws-viewer-context-${scope}`;

/** The element inside the breadcrumb where a viewer hangs its own controls, so no second toolbar opens below it. */
export const viewerActionsTarget = (scope: string): string => `ws-viewer-actions-${scope}`;
