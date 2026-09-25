import type { IconName } from "@intentic/ui";
import { definePreference } from "@intentic/ui/preference";
import type { Ref } from "vue";

// A STATUS DOCK'S MEMORY. Which of its panels a reader left open and how tall they made them, per host, so a panel
// opened to watch something is still open after a reload, a trip to another view, or a click anywhere else. Nothing is
// open until the reader opens it: the bar says enough at rest.

export interface DockSegment {
    readonly id: string;
    // The panel's heading, and what its segment is named for a screen reader.
    readonly title: string;
    readonly icon: IconName;
    // What the panel is about, one hover away from its heading rather than a paragraph under every reading.
    readonly hint?: string;
    // Sits at the bar's far end, with its panel last.
    readonly end?: boolean;
    // Its panel's share of the width when several are open; 1 unless said.
    readonly weight?: number;
}

export interface DockState {
    readonly open: Ref<readonly string[]>;
    readonly height: Ref<number>;
}

export const DOCK_MIN_HEIGHT = 96;
export const DOCK_MAX_HEIGHT = 720;
export const DOCK_DEFAULT_HEIGHT = 240;

const clampHeight = (px: number): number => Math.min(DOCK_MAX_HEIGHT, Math.max(DOCK_MIN_HEIGHT, Math.round(px)));

// Called once per host at module scope: a preference is one ref per key for the life of the window.
export const defineDockState = (key: string): DockState => ({
    open: definePreference<readonly string[]>({
        key: `${key}-open`,
        read: (raw) => (raw === null ? [] : raw.split(`,`).filter((id) => id !== ``)),
        write: (ids) => (ids.length === 0 ? null : ids.join(`,`)),
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

// The board's dock (main line and geek metrics) and the chat column's (main line alone) remember separately: the column
// is narrow and often beside the board, where a panel opened in one would otherwise open twice.
export const boardDock: DockState = defineDockState(`ui-board-dock`);
export const railDock: DockState = defineDockState(`ui-rail-dock`);
