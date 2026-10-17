import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui";

/* <HubLayout>'s row model, in a plain module for the reason <NavRail>'s own group model lives in one (see navRail.ts). */
export interface HubTab {
    /** The `:tab` route param this row selects, and what marks it current. A row with parts is no route: this is its key. */
    readonly slug: string;
    readonly label: string;
    /** Every row carries one. */
    readonly icon: IconName;
    /** The trailing chip, in the same shape the rail's tiles use, so a count, a glyph and a tone mean the same thing on both surfaces. */
    readonly badge?: ViewBadge | undefined;
    /**
     * The sections this one row stands for, in tab order: drawn as tabs above whichever of them is open, the row current
     * while any is. The row opens the first. Never empty; a row left with nothing to open leaves the index instead.
     */
    readonly parts?: readonly HubTab[] | undefined;
}

/** The sections a row opens: its parts, or the row itself. */
export const hubRowSections = (row: HubTab): readonly HubTab[] => row.parts ?? [row];

/** The row a section is drawn under, if any row holds it. */
export const hubRowOf = (rows: readonly HubTab[], slug: string): HubTab | undefined =>
    rows.find((row) => hubRowSections(row).some((section) => section.slug === slug));
