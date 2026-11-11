import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

export type IconRailSize = "compact" | "comfortable";

/* THE RAIL'S WIDTH, written down once: the tile (railFrame.ts) plus a thin margin of the rail's wash either side,
   5px compact (34px tile in 44px), 6px comfortable (38px tile in 50px). */
export const ICON_RAIL_WIDTH_REM: Record<IconRailSize, number> = { compact: 2.875, comfortable: 3.125 };
export const iconRailScreenPx = (size: IconRailSize): number => ICON_RAIL_WIDTH_REM[size] * 16;

const STORAGE_KEY = `ui-icon-rail-size`;

/* Icon rail width and spacing are shared account preferences. */

const isIconRailSize = (value: unknown): value is IconRailSize => value === `compact` || value === `comfortable`;

const iconRailSize: Ref<IconRailSize> = definePreference<IconRailSize>({
    key: STORAGE_KEY,
    read: (raw) => (isIconRailSize(raw) ? raw : `compact`),
    write: (value) => value,
});

export function useIconRailSize() {
    return { iconRailSize };
}
