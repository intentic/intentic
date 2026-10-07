import { sandboxRef } from "@intentic/extension-api";
import { computed, ref } from "vue";
import type { Router } from "vue-router";
import type { ScreenPoint } from "../../../workbench/window/floating";
import { chatFullSlot } from "../../../workbench/window/panelSlots";
import { useChatFloating } from "./chatFloating";
import { useLayout } from "../../../workbench/window/useLayout";

// Which of the panel's three homes (the side panel, the rail, its own window) is in effect, derived from where it's
// drawn, never a stored mode.
// - chatWide: on a wide surface (own window, or the full-window section); turns onto its side.
// - chatOnRail: home is the rail, wherever the panel currently sits; the side panel holds no chat.
// - chatParked: this window draws the chat but no surface on it is showing the panel.

const floating = useChatFloating();
const layout = useLayout();

export const chatWide = computed(() => floating.floats.value || chatFullSlot.value !== null);
export const chatOnRail = computed(() => layout.chatHome.value === `rail`);
// The rail's home with this page drawing it: the chat is the rail tile's full-window /chat, not a window of its own.
export const chatOnRailTile = computed(() => chatOnRail.value && !floating.floats.value);
// The side home in effect: the chat lives in the side panel, under whatever was opened beside it (shell/side). Neither
// homed on the rail nor in a window of its own.
export const chatInSidePanel = computed(() => !chatOnRail.value && !floating.floats.value);

// The rail's home has no column, so off /chat the panel has nowhere to go. This says so, and is what decides whether
// the quick bar draws — which is how "which views show the quick bar" is answered by shape rather than by a list of
// routes: every surface where no composer is already on screen. The same three facts pick the teleport target in
// PoppablePanels, so the strip cannot draw over a panel that went somewhere else.
export const chatParked = computed(() => floating.shows.value && chatOnRail.value && chatFullSlot.value === null);

// A surface outside the chat asking the parked chat to show its focused conversation's turns now (a board card's click,
// which otherwise only swapped the pill's title): the quick bar draws no turns, so ChatQuickBar answers with /chat. A
// counter, since the same ask twice must act twice. Nothing happens where the chat has a column or a window of its own:
// it is on screen.
// allow(module-state): a one-way ask across the teleport, like the dock slots
export const quickBarShowAsk = ref(0);
export const showParkedChat = (): void => {
    if (chatParked.value) {
        quickBarShowAsk.value += 1;
    }
};

// Last in-shell route before the chat, to return to; not router.back(), since history can start on /chat. It names one
// sandbox's file or agent, so a switch starts it over.
export const lastSectionPath = sandboxRef(() => `/agents`);

// Single source of truth for every dock/undock control. Docking to rail also navigates there; from floating it docks
// first. Docking to the side only navigates away from the section the column replaces.
export const toggleChatHome = (router: Router): void => {
    if (chatOnRail.value) {
        layout.setChatHome(`side`);
        if (router.currentRoute.value.name === `chat`) {
            void router.push(lastSectionPath.value);
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

// The same pop-out, from the rail tile dragged off the rail (shell/rail/chatTileDrag.ts): the window opens with its
// top-left at `at`, where the tile was let go. False when the browser's popup blocker refused the window.
export const floatChatAt = (at: ScreenPoint): boolean => floating.open(at);
