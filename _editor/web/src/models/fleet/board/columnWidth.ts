import type { Ref } from "vue";
import { numberPreference } from "@intentic/ui/preference";

// Rail width, the chat rail's column of session cards (ChatTabs, RailColumn), and the width the chat panel sets aside for
// it (ChatPanel), in app pixels. Floor (288) matches ChatTabList's own docked-sheet floor; default (320) fits two lines of
// title plus the meta row; drag reaches 480.

const RAIL_WIDTH_KEY = `ui-chat-rail-width`;
export const DEFAULT_RAIL_WIDTH = 320;
// Exported so `<ResizeSeam>` and the clamp below share one number instead of two that could drift.
export const MIN_RAIL_WIDTH = 288;
export const MAX_RAIL_WIDTH = 480;

export const clampRailWidth = (px: number): number => Math.round(Math.max(MIN_RAIL_WIDTH, Math.min(px, MAX_RAIL_WIDTH)));

/** The live width, shared by every rail in this window and kept across windows: a drag on one moves the other in the same frame. */
export const railWidth: Ref<number> = numberPreference(RAIL_WIDTH_KEY, clampRailWidth, () => DEFAULT_RAIL_WIDTH);

export const setRailWidth = (px: number): void => {
    railWidth.value = clampRailWidth(px);
};
