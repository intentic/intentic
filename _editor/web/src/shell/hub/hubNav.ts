import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui";

/* <HubLayout>'s row model, in a plain module for the reason <NavRail>'s own group model lives in one (see navRail.ts). */
export interface HubTab {
    /** The `:tab` route param this row selects, and what marks it current. */
    readonly slug: string;
    readonly label: string;
/** Every row carries one. */
    readonly icon: IconName;
/** The trailing chip, in the same shape the rail's tiles use, so a count, a glyph and a tone mean the same thing on both surfaces. */
    readonly badge?: ViewBadge | undefined;
}
