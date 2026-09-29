import type { IconName } from "../../icons/iconSets.js";
import type { TooltipValue } from "../../lib/tooltip.js";

/* <OverflowActions>'s and <ActionSheet>'s item model, in a plain module for the reason <NavRail>'s lives in navRail.ts: a caller builds these out of its own state in a computed. */
export interface ActionItem {
    /** Stable key for :key. */
    readonly id: string;
    /** The press's name: the icon button's accessible name, and the sheet row's words. */
    readonly label: string;
    readonly icon: IconName;
    /** The icon button's hover, where there is one; the label when absent. A phone never sees it. */
    readonly hint?: TooltipValue;
    /** A line under the label in the sheet, for what the hover said that a phone would otherwise never read. */
    readonly note?: string;
    /** A press that destroys something, inked as one. */
    readonly danger?: boolean;
    readonly disabled?: boolean;
    /** What the press does, handed the element it came from, for a caller that hangs a panel off it. */
    readonly run: (from: HTMLElement) => void;
}
