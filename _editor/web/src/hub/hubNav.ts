import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui";

/* <HubLayout>'s row model, in a plain module for the reason <NavRail>'s own group model lives in one (see
 * navRail.ts): a hub builds its rows in a computed from its own data, and a type it can only reach through a
 * .vue file is a type it cannot import without the component graph coming along. The groups themselves are
 * NavGroup<HubTab> — the hub is a caller of the index column, not a second implementation of one. */
export interface HubTab {
    /** The `:tab` route param this row selects, and what marks it current. */
    readonly slug: string;
    readonly label: string;
    /** Every row carries one. A column of glyphs is what lets a twelve-row index be scanned at a glance
     *  instead of read top to bottom — the affordance the horizontal strip had no pixels for. */
    readonly icon: IconName;
    /** The trailing chip, in the same shape the rail's tiles use, so a count, a glyph and a tone mean the
     *  same thing on both surfaces. Absent ⇒ the nominal case, which stays silent. */
    readonly badge?: ViewBadge | undefined;
}
