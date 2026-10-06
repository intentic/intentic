import type { Ref } from "vue";
import { definePreference } from "@intentic/ui/preference";

export type IconRailSize = "compact" | "comfortable";

/* THE RAIL'S WIDTH, written down once. */
export const ICON_RAIL_WIDTH_REM: Record<IconRailSize, number> = { compact: 3.5, comfortable: 4 };
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
