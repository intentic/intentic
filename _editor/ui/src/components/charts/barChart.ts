import type { FigureAccent } from "../../markdown/figures.js";

// <BarChart>'s row model, kept in a pure module so callers (and their unit tests) can build rows without booting a
// component graph.
export interface BarItem {
    readonly label: string;
    // Tip label when the raw number needs explanation; absent, the renderer prints the value, thousands-separated.
    readonly value: number;
    readonly display?: string;
    readonly accent?: FigureAccent;
    // v-for identity when labels can collide (e.g. two rows both labeled "other"); absent, the label is the key.
    readonly key?: string;
    // Row names a bucket, not a thing: folded tail or unattributed spend; renders italic/muted, still ranked.
    readonly muted?: boolean;
}
