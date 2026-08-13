import { ref } from "vue";

/* HOW THE CHAT LIST IS CUT INTO GROUPS — by where a chat STANDS, or by who it is ACTING AS.
 *
 * The list has always grouped by the fleet's three lanes, which answers "what needs me next" and is the right
 * default: it is the board's own answer, at the rail's width, and a switcher's first job is routing. What it
 * cannot answer is the other question a workspace with personas raises — "what has Work been doing?" — because
 * a persona's sessions are scattered across all three lanes by construction, and the one thing they have in
 * common is the only thing the lanes don't show.
 *
 * A MODE, NOT A SECOND LIST, and for the same reason the board and this rail are one component in two frames:
 * these are two cuts of one set of chats. Nothing appears in one grouping that is missing from the other — a
 * chat has both a lane and a persona at all times — so the switch changes the headings and the order under
 * them, and nothing else.
 *
 * PERSISTED AND MODULE-WIDE, unlike the list's filter (which is per-instance on purpose, so a query typed in
 * one window cannot narrow another). Grouping is not a search: it is how this reader reads the list, so it
 * holds across the docked sheet, the popped-out rail, and reloads — the same treatment the diff layout and the
 * workspace sidebar's panel get. */

export type ChatGrouping = "lane" | "persona";

const STORAGE_KEY = `ui-chat-grouping`;

// Anything that is not the stored `persona` reads as the lanes: an unset key, a value from a later build, a
// Storage that throws. The lanes are the safe default — they are the grouping that never has an empty answer,
// since every chat has a lane whether or not this workspace uses personas at all.
const read = (): ChatGrouping => {
    try {
        return localStorage.getItem(STORAGE_KEY) === `persona` ? `persona` : `lane`;
    } catch {
        return `lane`;
    }
};

const grouping = ref<ChatGrouping>(read());

const set = (value: ChatGrouping): void => {
    grouping.value = value;
    try {
        localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds for this session.
    }
};

export function useChatGrouping() {
    return { grouping, set };
}
