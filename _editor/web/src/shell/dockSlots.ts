import { shallowRef } from "vue";

/* WHERE THE SHELL LENDS THE FLOATING PANELS A PLACE TO SIT.
 *
 * The chat and the sandbox-global terminal are mounted ABOVE the router (shell/PoppablePanels.vue), not inside
 * the workspace shell, because a popped-out panel is a PAGE-level surface: its DOM lives in another window and
 * its lifetime is this page's, not the current route's. They used to be children of ShellDesktop, and that made
 * every route outside the shell — /setup, which is where "Add sandbox" goes, an invite link, the desktop
 * sign-in handoff, tear the chrome down and close the floating window with it, mid-conversation.
 *
 * So the shell no longer OWNS the panels; it publishes a place for them. An empty element in the chat grid
 * column, another below the workspace where the terminal docks, and the panel is teleported into whichever slot
 * is published, or into its pop-out window when it has one, or the parking stage when there is neither. It is
 * never unmounted, so a trip to /setup costs nothing: not the streaming turn, not the attached xterm, not even
 * a scroll position.
 *
 * Both slots are `display: contents` elements, they generate no box at all, so the panel itself stays the grid
 * item its own classes were written against and this indirection changes no layout.
 *
 * Module refs rather than props because publisher and consumer sit on opposite sides of the router outlet, and
 * the publisher is the half that comes and goes. Null is the honest empty value: it is what Vue writes into a
 * template ref when the element it named goes away. */

export const chatDock = shallowRef<HTMLElement | null>(null);
// The chat's FULL-WINDOW home, published by the /chat area (pages/ChatArea.vue) while it is on screen, and
// preferred over the docked column when both exist: standing in the chat area IS the ask to see the chat fill
// it. The pop-out window still outranks both (PoppablePanels holds the priority in one place).
export const chatFullDock = shallowRef<HTMLElement | null>(null);
// The preview panel's only in-shell home, published by the /preview area (pages/PreviewArea.vue). It has no
// side-column slot: the panel is either filling this area, floating in its own window, or parked.
export const previewDock = shallowRef<HTMLElement | null>(null);
export const terminalDock = shallowRef<HTMLElement | null>(null);
