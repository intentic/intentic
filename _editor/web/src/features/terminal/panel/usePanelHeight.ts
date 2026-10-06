import { computed } from "vue";
import { numberPreference } from "@intentic/ui/preference";

// The docked panel's height, remembered per surface and clamped between a floor and about 80% of the viewport. There is
// no collapsed state: the toolbar's × already hides the panel without killing a session. It is the one dimension kept in
// screen pixels (it is compared with innerHeight, and the terminal paints from a number), so nothing here converts units.

export const DEFAULT_HEIGHT = 240;
export const MIN_HEIGHT = 96;

// The cap, as a share of the viewport.
const MAX_SHARE = 0.8;

const clampHeight = (px: number): number => Math.round(Math.max(MIN_HEIGHT, Math.min(px, window.innerHeight * MAX_SHARE)));

// A preference, so a height dragged in one window is the height a popped-out one opens at too.
export const usePanelHeight = (storageKey: string) => {
    const height = numberPreference(`ui-${storageKey}-terminal-height`, clampHeight, () => DEFAULT_HEIGHT);
    // What the seam drags: clamped, then remembered.
    const seamHeight = computed<number>({
        get: () => height.value,
        set: (px) => {
            height.value = clampHeight(px);
        },
    });
    // The cap as the seam first reads it.
    const maxHeight = computed(() => Math.round(window.innerHeight * MAX_SHARE));
    return { height, seamHeight, maxHeight };
};
