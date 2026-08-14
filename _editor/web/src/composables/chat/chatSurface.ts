import { computed, ref } from "vue";
import type { Router } from "vue-router";
import { chatFullDock } from "../../shell/dockSlots";
import { useChatPopout } from "./useChatPopout";
import { useLayout } from "../useLayout";

/* WHICH FORM THE ONE CHAT PANEL TAKES, derived from where it is actually being drawn — never a stored mode.
 * The panel has three homes and exactly one is in effect at a time: the side column, the rail (the full-screen
 * /chat area behind the rail's Chat tile — useLayout.chatHome holds that CHOICE), and its own pop-out window.
 * These readings are the whole vocabulary the rest of the app needs:
 *
 *   · chatWide       — the panel is on a WIDE surface (the pop-out window or the full-window area), so it turns
 *                      on its side: the tab bar becomes a right-edge rail of chat cards, panes stand beside,
 *                      and a workflow run may take the pane area for its diagram. The docked column keeps the
 *                      stacked form. Everything that used to ask "popped out?" to pick a LAYOUT asks this now;
 *                      what asks about window identity (which document, which clock) still asks poppedOut.
 *   · chatFullscreen — the narrower fact: the panel is filling the /chat area of the main window. What drops
 *                      the panel's own left border, and the only form with in-app controls for the way out.
 *   · chatOnRail     — the HOME is the rail, whatever is on screen right now: the rail carries the Chat tile,
 *                      the side column never opens, and away from /chat the panel waits parked behind the tile
 *                      (still streaming — parking is how it already survives routes with no shell).
 *
 * The first two derive from chatFullDock (the /chat area's published slot) and the pop-out state, so they can
 * never disagree with where the Teleport actually put the panel. */

const popout = useChatPopout();
const layout = useLayout();

export const chatFullscreen = computed(() => !popout.poppedOut.value && chatFullDock.value !== null);
export const chatWide = computed(() => popout.poppedOut.value || chatFullDock.value !== null);
export const chatOnRail = computed(() => layout.chatHome.value === `rail`);

/* Where leaving the rail-docked chat RETURNS to — the last in-shell route that wasn't the chat area, tracked by
 * the desktop shell. A ref rather than router.back(): history may start ON /chat (a reload, a shared link), and
 * a "dock back to the side" that leaves the app is not a way back. Defaults to the fleet board, the shell's own
 * landing view. */
export const lastAreaPath = ref(`/agents`);

/* The one move behind every "dock chat to rail / dock chat back to the side" control — the palette command, the
 * chat bar's button and its menu row — so they cannot drift. Docking to the rail goes THERE as part of the
 * move (choosing a home you are then not looking at would read as the chat vanishing), and from a pop-out
 * window it docks first: those words asked for the chat in the rail, and landing on the area's "your chat is
 * elsewhere" notice instead would make the press a riddle. Docking back to the side restores the column
 * everywhere, so it only needs to navigate when standing in the area the column replaces. The router comes
 * from the caller — this module is a singleton, and the app's router belongs to the app. */
export const toggleChatHome = (router: Router): void => {
    if (chatOnRail.value) {
        layout.setChatHome(`side`);
        if (router.currentRoute.value.name === `chat`) {
            void router.push(lastAreaPath.value);
        }
        return;
    }
    if (popout.poppedOut.value) {
        popout.dock();
    }
    layout.setChatHome(`rail`);
    void router.push(`/chat`);
};

/* The pop-out toggle every explicit control routes through (F9, the bar menus' "Dock chat back" row): docking
 * back lands the chat in its HOME. With the side column that is the window toggle alone; with the rail as home
 * the panel would land parked behind its tile — technically docked, visibly vanished — so a press that said
 * "bring the chat back" also walks to the area where it now is. A window closed by its own × keeps the plain
 * dock (usePopout's keeper): that press said only "close this window", and the tile is the chat's presence. */
export const toggleChatPopout = (router: Router): void => {
    const wasOut = popout.poppedOut.value;
    popout.toggle();
    if (wasOut && chatOnRail.value && router.currentRoute.value.name !== `chat`) {
        void router.push(`/chat`);
    }
};
