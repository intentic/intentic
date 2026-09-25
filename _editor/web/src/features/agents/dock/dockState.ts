import type { IconName } from "@intentic/ui";
import { definePreference } from "@intentic/ui/preference";
import type { Ref } from "vue";

// A STATUS DOCK'S MEMORY. Which panel a reader left open and how tall they made it, per host, so a panel opened to
// watch something is still open after a reload, a trip to another view, or a click anywhere else. Nothing is open until
// the reader opens it: the bar says enough at rest.

export interface DockSegment {
    readonly id: string;
    // The panel's heading, and what its segment is named for a screen reader.
    readonly title: string;
    readonly icon: IconName;
    // Sits at the bar's far end.
    readonly end?: boolean;
}

export interface DockState {
    // The one panel open, if any: the bar's segments work as tabs.
    readonly open: Ref<string | undefined>;
    readonly height: Ref<number>;
}

export const DOCK_MIN_HEIGHT = 96;
export const DOCK_MAX_HEIGHT = 720;
export const DOCK_DEFAULT_HEIGHT = 240;

const clampHeight = (px: number): number => Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, Math.round(px)));

// Called once per host at module scope: a preference is one ref per key for the life of the window.
export const defineDockState = (key: string): DockState => ({
    open: definePreference<string | undefined>({
        key: `${key}-open`,
        // Docks once kept several panels open, written as a list in the order they were opened: the latest one wins.
        read: (raw) => raw?.split(`,`).findLast((id) => id !== ``),
        write: (id) => id ?? null,
    }),
    height: definePreference<number>({
        key: `${key}-height`,
        read: (raw) => {
            const px = raw === null ? Number.NaN : Number(raw);
            return Number.isFinite(px) ? clampHeight(px) : DOCK_DEFAULT_HEIGHT;
        },
        write: (px) => (px === DOCK_DEFAULT_HEIGHT ? null : String(clampHeight(px))),
    }),
});

// The board's dock: the one place the main line and the geek metrics are drawn. The chat column carries neither; the
// board is where the sandbox as a whole is watched.
export const boardDock: DockState = defineDockState(`ui-board-dock`);
