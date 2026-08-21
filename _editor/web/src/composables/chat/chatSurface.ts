import { computed, ref } from "vue";
import type { Router } from "vue-router";
import { chatFullDock } from "../../shell/dockSlots";
import { useChatFloating } from "./chatFloating";
import { useLayout } from "../useLayout";

/* WHICH FORM THE ONE CHAT PANEL TAKES, derived from where it is actually being drawn, never a stored mode.
 * The panel has three homes and exactly one is in effect at a time: the side column, the rail (the full-screen
 * /chat area behind the rail's Chat tile, useLayout.chatHome holds that CHOICE), and its own window. These
 * readings are the whole vocabulary the rest of the app needs:
 *
 *   · chatWide      , the panel is on a WIDE surface (its own window or the full-window area), so it turns on
 *                      its side: the tab bar becomes a left rail of chat cards, panes stand side by side, and a
 *                      workflow run may take the pane area for its diagram. The docked column keeps the stacked
 *                      form.
 *   · chatOnRail    , the HOME is the rail, whatever is on screen right now: the rail carries the Chat tile,
 *                      the side column never opens, and away from /chat the panel waits parked behind the tile
 *                      (still streaming, parking is how it already survives routes with no shell).
 *
 * Both are facts about the PANEL and read the same in every window, which is what lets a surface that isn't
 * drawing the chat (the fleet board, deciding whether the panel is showing a run's diagram rather than a
 * conversation) reason about its form at all. */

const floating = useChatFloating();
const layout = useLayout();

export const chatWide = computed(() => floating.floats.value || chatFullDock.value !== null);
export const chatOnRail = computed(() => layout.chatHome.value === `rail`);

/* Where leaving the rail-docked chat RETURNS to, the last in-shell route that wasn't the chat area, tracked by
 * the desktop shell. A ref rather than router.back(): history may start ON /chat (a reload, a shared link), and
 * a "dock back to the side" that leaves the app is not a way back. Defaults to the fleet board, the shell's own
 * landing view. */
export const lastAreaPath = ref(`/agents`);

/* The one move behind every "dock chat to rail / dock chat back to the side" control, the palette command, the
 * chat bar's button and its menu row, so they cannot drift. Docking to the rail goes THERE as part of the move
 * (choosing a home you are then not looking at would read as the chat vanishing), and from a floating window it
 * docks first: those words asked for the chat in the rail, and landing on the area's "your chat is elsewhere"
 * notice instead would make the press a riddle. Docking back to the side restores the column everywhere, so it
 * only needs to navigate when standing in the area the column replaces. The router comes from the caller, this
 * module is a singleton, and the app's router belongs to the app. */
export const toggleChatHome = (router: Router): void => {
    if (chatOnRail.value) {
        layout.setChatHome(`side`);
        if (router.currentRoute.value.name === `chat`) {
            void router.push(lastAreaPath.value);
        }
        return;
    }
    if (floating.floats.value) {
        floating.dock();
    }
    layout.setChatHome(`rail`);
    void router.push(`/chat`);
};

/* Put the chat in a window of its own, or bring it back. Every explicit control routes through the surface's
 * own toggle (F9, the bar menus' row, the palette): there is nothing to add here, because "a docked chat has to
 * land somewhere visible" is not this door's business any more, it is one watch that covers every door
 * (shell/PoppablePanels.vue). */
export const toggleChatFloating = (): void => {
    floating.toggle();
};
