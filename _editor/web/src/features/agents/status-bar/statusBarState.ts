import { definePreference } from "@intentic/ui/preference";
import { computed, ref } from "vue";

// THE BOARD'S STATUS BAR, REMEMBERED. Which panel the reader left open and how tall they made it, so a panel opened to
// watch something is still open after a reload, a trip to another view, or a click anywhere else. Nothing is open until
// the reader opens it: the bar says enough at rest.

// The bar's two segments, which are also the two panels it can open.
export type StatusSegment = `mainline` | `metrics`;

export const PANEL_MIN_HEIGHT = 96;
export const PANEL_DEFAULT_HEIGHT = 240;
// The tallest a panel may be anywhere, before the window's own half says less.
const PANEL_CEILING = 720;

// The window's height, kept current, for the one maximum the seam drags to and the panel is drawn at.
// allow(module-state): the window's own height, the same whichever sandbox is open
const viewport = ref(window.innerHeight);
window.addEventListener(`resize`, () => {
    viewport.value = window.innerHeight;
});

/** The tallest a panel is drawn and dragged to: half the window, and never past 720px. */
export const panelMaxHeight = computed(() => Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_CEILING, Math.floor(viewport.value / 2))));

const clampHeight = (px: number): number => Math.min(PANEL_CEILING, Math.max(PANEL_MIN_HEIGHT, Math.round(px)));

// The one panel open, if any: the bar's segments work as tabs.
export const openPanel = definePreference<StatusSegment | undefined>({
    key: `ui-board-dock-open`,
    read: (raw) => (raw === `mainline` || raw === `metrics` ? raw : undefined),
    write: (id) => id ?? null,
});

export const panelHeight = definePreference<number>({
    key: `ui-board-dock-height`,
    read: (raw) => {
        const px = raw === null ? Number.NaN : Number(raw);
        return Number.isFinite(px) ? clampHeight(px) : PANEL_DEFAULT_HEIGHT;
    },
    write: (px) => (px === PANEL_DEFAULT_HEIGHT ? null : String(clampHeight(px))),
});
