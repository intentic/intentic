import { computed, ref } from "vue";
import type { Router } from "vue-router";
import { chatFullDock } from "../../shell/dockSlots";
import { useChatPopout } from "./useChatPopout";

/* WHICH FORM THE ONE CHAT PANEL TAKES, derived from where it is actually being drawn — never a stored mode.
 * The panel has three homes (the docked column, the /chat area filling the window, its own pop-out window) and
 * exactly one is in effect at a time; these two readings are the whole vocabulary the rest of the app needs:
 *
 *   · chatWide       — the panel is on a WIDE surface (the pop-out window or the full-window area), so it turns
 *                      on its side: the tab bar becomes a left rail of chat cards, panes stand side by side,
 *                      and a workflow run may take the pane area for its diagram. The docked column keeps the
 *                      stacked form. Everything that used to ask "popped out?" to pick a LAYOUT asks this now;
 *                      what asks about window identity (which document, which clock) still asks poppedOut.
 *   · chatFullscreen — the narrower fact: the panel is filling the /chat area of the main window. What the
 *                      shell collapses its chat column for, and the only form with an in-app way back.
 *
 * Both derive from chatFullDock (the /chat area's published slot) and the pop-out state, so they can never
 * disagree with where the Teleport actually put the panel. */

const popout = useChatPopout();

export const chatFullscreen = computed(() => !popout.poppedOut.value && chatFullDock.value !== null);
export const chatWide = computed(() => popout.poppedOut.value || chatFullDock.value !== null);

/* Where leaving full-screen chat RETURNS to — the last in-shell route that wasn't the chat area, tracked by the
 * desktop shell. A ref rather than router.back(): history may start ON /chat (a reload, a shared link), and a
 * "back to side panel" that leaves the app is not a way back. Defaults to the fleet board, the shell's own
 * landing view. */
export const lastAreaPath = ref(`/agents`);

/* The one toggle behind every "fill the window / back to side panel" control — the palette command, the header
 * button's counterpart on the bar menu — so the two can't drift. Standing in the area, it is the way back;
 * anywhere else it is the way in, and from a pop-out window it docks first: those words asked for the chat
 * HERE, and landing on the area's "your chat is elsewhere" notice instead would make the press a riddle. The
 * router comes from the caller — this module is a singleton, and the app's router belongs to the app. */
export const toggleChatFullscreen = (router: Router): void => {
    if (router.currentRoute.value.name === `chat`) {
        void router.push(lastAreaPath.value);
        return;
    }
    if (popout.poppedOut.value) {
        popout.dock();
    }
    void router.push(`/chat`);
};
