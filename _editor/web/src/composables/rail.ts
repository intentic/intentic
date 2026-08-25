import { ref, type Ref } from "vue";

/* HOW WIDE THE RAIL IS: the column of session cards down the left edge of every surface that lists agents
 * (components/RailColumn.vue draws it and owns the drag; this is the number and the arithmetic).
 *
 * ONE WIDTH, EVERY RAIL. Two surfaces draw this column: the chat's list of open conversations, in a floating
 * window or in the /chat area (ChatTabs), and the agents this sandbox's agents started (pages/Subagents.vue).
 * They hold the same cards on the same lanes and are read minutes apart by one eye, so a width dragged on one
 * is the width the other opens at: two remembered numbers would be the same column disagreeing with itself
 * across a tab switch. The Subagents rail used to be a hardcoded 288 that could not be dragged at all.
 *
 * The numbers live here rather than in the component because two other files need them: the panel that asks
 * its own floating window to widen for a new pane, which can only work out what the panes get if it knows what
 * the rail takes first (ChatPanel's `fit`), and every host that puts a rail on screen.
 *
 * In APP PIXELS, like every other width the app persists (see useLayout's note): the rail holds cards, so the
 * width that fits their titles moves with the reader's text size.
 *
 * WHAT THE LIST IS GUARANTEED ELSEWHERE IS WHAT IT OPENS AT HERE. ChatTabList is the same component in the
 * rail and in the docked sheet, and in the sheet it is never asked to be narrower than the chat column's own
 * floor (288, useLayout, where that number is what the column's header content measures at). Out on the rail
 * it used to open at 240 and could be dragged to 176, so the one list had two different ideas of how narrow it
 * can be: at that width a card's title wraps to three lines, its meta row breaks up, and the foot's two
 * buttons drop onto separate rows: a list that looks broken on first sight, before the reader has touched
 * anything.
 *
 * So the floor is the column's floor, and the default clears it: 320 is a card with room for two lines of
 * title and its meta row intact, which is what the rail is FOR, the fleet board in miniature, beside the
 * transcript. A starting width, not a cap; the drag reaches 480 and a double-click comes back to it. */

const RAIL_WIDTH_KEY = `ui-chat-rail-width`;
export const DEFAULT_RAIL_WIDTH = 320;
const MIN_RAIL_WIDTH = 288;
const MAX_RAIL_WIDTH = 480;

export const clampRailWidth = (px: number): number => Math.round(Math.max(MIN_RAIL_WIDTH, Math.min(px, MAX_RAIL_WIDTH)));

const storedRailWidth = (): number => {
    try {
        const parsed = Number.parseInt(localStorage.getItem(RAIL_WIDTH_KEY) ?? ``, 10);
        return Number.isFinite(parsed) ? clampRailWidth(parsed) : DEFAULT_RAIL_WIDTH;
    } catch {
        return DEFAULT_RAIL_WIDTH;
    }
};

/** The live width, shared by every rail in this window: a drag on one moves the other in the same frame. */
export const railWidth: Ref<number> = ref(storedRailWidth());

export const setRailWidth = (px: number): void => {
    railWidth.value = clampRailWidth(px);
    try {
        localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth.value));
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};
