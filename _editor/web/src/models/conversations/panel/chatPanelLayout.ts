import { boolPreference } from "@intentic/ui/preference";
import { computed, shallowRef } from "vue";
import { chatFullSlot } from "../../../workbench/window/panelSlots";
import { useChatFloating } from "./chatFloating";

// WHERE THE CHAT IS DRAWN. It has one home: the side panel, at the right of every page of a sandbox. The only ways to put
// it out of the way are a window of its own (chatFloating.ts) and folding it into the strip at the window's edge
// (`chatTucked`), which keeps it mounted, so it comes back as it was left. Until 2026-11-23 it could also live behind a
// rail tile as a full-window /chat; the Agents board beside the docked chat replaced that page.
// - chatWide: on a wide surface (its own window, or Home's page, which lends it the whole area); panes and a run's
//   diagram have room there.
// - chatInSidePanel: the side panel holds the chat, not a window of its own.

const floating = useChatFloating();

export const chatWide = computed(() => floating.floats.value || chatFullSlot.value !== null);
export const chatInSidePanel = computed(() => !floating.floats.value);

/** Folded into the strip at the window's edge (shell/side/ChatTucked.vue): the reader's own choice, kept like its width. */
export const chatTucked = boolPreference(`ui-chat-tucked`, false);
export const setChatTucked = (tucked: boolean): void => {
    chatTucked.value = tucked;
};
export const toggleChatTucked = (): void => setChatTucked(!chatTucked.value);
/** A press that asks to see a chat's turns (a board card's, a run it follows): the chat comes back out of its strip. */
export const showChat = (): void => setChatTucked(false);

// WHETHER THE CHAT'S OWN SIDE RAIL (its checklist, then Usage left) IS DRAWN IN THIS WINDOW, written by the panel
// (ChatPanel.vue `showsRail`). The Agents board puts Usage left under itself only while it is not (features/agents/fleet/Agents.vue),
// so the figures are on screen once, wherever there is room for them.
// allow(module-state): what this window's one chat panel draws, published for a page beside it to read
export const chatRailDrawn = shallowRef(false);
/** The chat's side rail is on screen here: drawn, and not folded away with the chat into the strip. */
export const chatRailOnScreen = computed(() => chatRailDrawn.value && (floating.here.value || !chatTucked.value));

// Puts the chat in its own window, or brings it back. Every explicit control already routes through the surface's own
// toggle; nothing else to coordinate here.
export const toggleChatFloating = (): void => {
    floating.toggle();
};

