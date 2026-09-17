import { computed, ref } from "vue";
import type { Router } from "vue-router";
import { chatFullDock } from "../../../shell/window/dockSlots";
import { useChatFloating } from "./chatFloating";
import { useLayout } from "../../../shell/window/useLayout";

// Which of the panel's three homes (side column, rail, own window) is in effect, derived from where it's drawn, never a
// stored mode.
// - chatWide: on a wide surface (own window, or the full-window area); turns onto its side.
// - chatOnRail: home is the rail, wherever the panel currently sits; the side column never opens.
// - chatParked: this window draws the chat but no surface on it is showing the panel.

const floating = useChatFloating();
const layout = useLayout();

export const chatWide = computed(() => floating.floats.value || chatFullDock.value !== null);
export const chatOnRail = computed(() => layout.chatHome.value === `rail`);

// The rail's home has no column, so off /chat the panel has nowhere to go. This says so, and is what decides whether
// the bottom strip draws — which is how "which views show the strip" is answered by shape rather than by a list of
// routes: every surface where no composer is already on screen. The same three facts pick the teleport target in
// PoppablePanels, so the strip cannot draw over a panel that went somewhere else.
export const chatParked = computed(() => floating.shows.value && chatOnRail.value && chatFullDock.value === null);

// The strip's transcript, while a pointer is asking to read it (ChatQuickBar's handle). A module ref for the same
// reason the dock slots are: the pill that asks and the panel that answers sit on opposite sides of the teleport.
// What it turns on is the pane's own turns — never a second transcript.
export const chatBarPeek = ref(false);

// Last in-shell route before the chat, to return to; not router.back(), since history can start on /chat.
export const lastAreaPath = ref(`/agents`);

// Single source of truth for every dock/undock control. Docking to rail also navigates there; from floating it docks
// first. Docking to the side only navigates away from the area the column replaces.
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

// Puts the chat in its own window, or brings it back. Every explicit control already routes through the surface's own
// toggle; nothing else to coordinate here.
export const toggleChatFloating = (): void => {
    floating.toggle();
};
