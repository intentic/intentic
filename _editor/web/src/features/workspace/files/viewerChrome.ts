import type { InjectionKey } from "vue";

/* WHERE A FILE'S CONTEXT AND ITS VIEWER'S CONTROLS ARE DRAWN, when the view around them already has a bar.
 *
 * The workspace used to open four horizontal bands before a document's first line: the scope banner, the tab
 * row, the breadcrumb, and the markdown surface's own toolbar. Three of them were one line of controls each,
 * and two of them named the same file: the tab said `across-sandboxes-design.md` and the breadcrumb, twenty
 * pixels below it, said `intentic › docs › across-sandboxes-design.md`.
 *
 * A band costs the scarce dimension to buy the abundant one. So the bands collapse into the tab row, which is
 * always rendered and already has empty space on its right, and the pieces reach it by teleport, because the
 * things that produce them (a viewer chosen at open time, a markdown surface two levels down) are nowhere near
 * the component that owns the bar.
 *
 * Two levels, because they nest: the breadcrumb rides the view's bar, and the viewer's own controls ride the
 * breadcrumb. A surface that has neither, the phone, provides nothing, `hoisted` is false, and the breadcrumb
 * draws its own band exactly as it always did.
 */

/** Provided by a view whose bar has room for the open file's context. Absent ⇒ the breadcrumb draws its own band. */
export const HOISTED_CONTEXT: InjectionKey<boolean> = Symbol(`workspace.hoistedContext`);

/* WHICH BAR, once there are two. The editor area splits into two panes, each with a bar of its own and each
 * possibly rendering a viewer, and a teleport addresses its target by DOM id: with one fixed id per target, both
 * panes would write into whichever seat the document happened to hold first, so the companion pane's breadcrumb
 * would land above the main pane's file. Each pane provides its own scope and the ids are derived from it. */
export const CHROME_SCOPE: InjectionKey<string> = Symbol(`workspace.chromeScope`);

/** The element in that bar the breadcrumb teleports into. */
export const contextTarget = (scope: string): string => `ws-viewer-context-${scope}`;

/** The element INSIDE the breadcrumb where a viewer hangs its own controls, so no second toolbar opens below it. */
export const viewerActionsTarget = (scope: string): string => `ws-viewer-actions-${scope}`;
