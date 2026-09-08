import { ref, type Ref } from "vue";

// Rail width, shared by every column of session cards (ChatTabs, Subagents.vue) so a drag on one is the width the other
// opens at, in app pixels. Floor (288) matches ChatTabList's own docked-sheet floor; default (320) fits two lines of
// title plus the meta row; drag reaches 480.

const RAIL_WIDTH_KEY = `ui-chat-rail-width`;
export const DEFAULT_RAIL_WIDTH = 320;
// Exported so `<ResizeSeam>` and the clamp below share one number instead of two that could drift.
export const MIN_RAIL_WIDTH = 288;
export const MAX_RAIL_WIDTH = 480;

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
