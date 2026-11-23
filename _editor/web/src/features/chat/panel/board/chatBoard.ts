import { boolPreference, numberPreference } from "@intentic/ui/preference";
import { computed, ref } from "vue";

// THE BOARD BESIDE THE CHAT. The full-window /chat can stand the Agents board in its left column in place of the rail's
// list of chats: the same board /agents draws (lanes, search, owner filter, geek metrics, night), the chat on its right,
// and Usage left under the board. The reader's choice, kept like the rail's width and followed by every window.
// Only the /chat route draws it (shell/chat/ChatWithBoard.vue, beside ChatSection.vue), and while it does the panel draws neither its rail list nor its
// side rail (ChatPanel.vue): the board already lists the chats, and the column under it holds the usage.

/** On: /chat shows the board beside the chat. */
export const chatBoardChosen = boolPreference(`ui-chat-board`, false);

// How much of the section the board takes, in thousandths, so a split chosen on a laptop reads the same on a wide
// screen. The floor leaves the board its stacked lanes; the ceiling leaves the chat a column. Below either side's own
// minimum width (ChatBoardColumn, the chat pane's MIN_PANE_PX) the layout holds the minimum instead.
export const MIN_BOARD_SHARE = 250;
export const MAX_BOARD_SHARE = 800;
export const DEFAULT_BOARD_SHARE = 550;
const clampShare = (share: number): number => Math.round(Math.max(MIN_BOARD_SHARE, Math.min(share, MAX_BOARD_SHARE)));

/** The board's share of the /chat section, in thousandths. */
export const chatBoardShare = numberPreference(`ui-chat-board-share`, clampShare, () => DEFAULT_BOARD_SHARE);

export const setChatBoardShare = (share: number): void => {
    chatBoardShare.value = clampShare(share);
};

// Whether this window's /chat section is on screen with the chat in it (not popped out into a window of its own): the
// only place the board can stand beside it. Written by ChatSection while it is mounted.
// allow(module-state): a surface's presence, published by the section for the panel above the router to read
export const chatSectionHere = ref(false);

/** Where the toggle is offered: the panel is drawn in this window's /chat section. */
export const chatBoardOffered = computed(() => chatSectionHere.value);

/** The board is standing beside the chat right now, so the panel leaves its list and usage to it. */
export const chatBoardBeside = computed(() => chatSectionHere.value && chatBoardChosen.value);

export const toggleChatBoard = (): void => {
    chatBoardChosen.value = !chatBoardChosen.value;
};
