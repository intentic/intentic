import { computed, ref } from "vue";
import type { Router } from "vue-router";
import { chatFullDock } from "../../../shell/window/dockSlots";
import { useChatFloating } from "./chatFloating";
import { useLayout } from "../../../shell/window/useLayout";

// Which of the panel's three homes (side column, rail, own window) is in effect, derived from where it's drawn, never a
// stored mode.
// - chatWide: on a wide surface (own window, or the full-window area); turns onto its side.
// - chatOnRail: home is the rail, wherever the panel currently sits; the side column never opens.

const floating = useChatFloating();
const layout = useLayout();

export const chatWide = computed(() => floating.floats.value || chatFullDock.value !== null);
export const chatOnRail = computed(() => layout.chatHome.value === `rail`);

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
