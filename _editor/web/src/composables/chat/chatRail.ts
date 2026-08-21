/* HOW WIDE THE CHAT LIST'S RAIL IS, the column of chat cards down the right edge of every wide chat surface
 * (ChatTabs draws it and owns the drag; this is only the arithmetic).
 *
 * The numbers live here because two files need them and a copy in each is a drift waiting to happen: the bar
 * that resizes the rail, and the panel that asks its own floating window to widen for a new pane, which can
 * only work out what the panes will get if it knows what the rail takes first (ChatPanel's `fit`).
 *
 * In APP PIXELS, like every other width the app persists (see useLayout's note): the rail holds chat cards, so
 * the width that fits their titles moves with the reader's text size.
 *
 * WHAT THE LIST IS GUARANTEED ELSEWHERE IS WHAT IT OPENS AT HERE. ChatTabList is the same component in both of
 * its hosts, and in the docked sheet it is never asked to be narrower than the chat column's own floor (288,
 * useLayout, where that number is what the column's header content measures at). Out on the rail it used to
 * open at 240 and could be dragged to 176, so the one list had two different ideas of how narrow it can be: at
 * that width a card's title wraps to three lines, its meta row breaks up, and the foot's two buttons drop onto
 * separate rows, a list that looks broken on first sight, before the reader has touched anything.
 *
 * So the floor is the column's floor, and the default clears it: 320 is a card with room for two lines of title
 * and its meta row intact, which is what the rail is FOR, the fleet board in miniature, beside the transcript.
 * A starting width, not a cap; the drag reaches 480 and a double-click comes back to it. */

export const RAIL_WIDTH_KEY = `ui-chat-rail-width`;
export const DEFAULT_RAIL_WIDTH = 320;
const MIN_RAIL_WIDTH = 288;
const MAX_RAIL_WIDTH = 480;

export const clampRailWidth = (px: number): number => Math.round(Math.max(MIN_RAIL_WIDTH, Math.min(px, MAX_RAIL_WIDTH)));
