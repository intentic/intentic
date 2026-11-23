import { computed, type ComputedRef, type Ref } from "vue";
import { onRail } from "../../workbench/views/registry";
import { type RailPins, useRailPins } from "./railPins";
import type { SectionTile } from "./sectionTiles";

// WHICH SECTIONS A RAIL DRAWS AND WHICH IT KEEPS BEHIND MORE, for both rails: the desktop's (ShellDesktop.vue) and the
// phone's (MobileRail.vue). onRail (registry.ts) holds the rule; this supplies its live facts, the reader's pins and the
// page on screen, so a section the desktop keeps off its rail is off the phone's too.
export interface RailSplit {
    readonly pins: RailPins;
    /** On the rail now: permanent, pinned, badging, or the page being visited. In rail order, as `tiles` came. */
    readonly onRailTiles: ComputedRef<readonly SectionTile[]>;
    /** Off the rail AT REST, alphabetically. A visited section stays here (marked as where you are) while its tile also sits
     *  on the rail, so the list keeps the same rows in the same places between openings. */
    readonly moreTiles: ComputedRef<readonly SectionTile[]>;
}

export function useRailSplit(tiles: Readonly<Ref<readonly SectionTile[]>>, isNavActive: (to: string) => boolean): RailSplit {
    const pins = useRailPins();
    const onRailTiles = computed<readonly SectionTile[]>(() =>
        tiles.value.filter((tile) => onRail(tile, { pinned: pins.isPinned(tile.to), active: isNavActive(tile.to) })),
    );
    const moreTiles = computed<readonly SectionTile[]>(() =>
        tiles.value
            .filter((tile) => !onRail(tile, { pinned: pins.isPinned(tile.to), active: false }))
            .toSorted((left, right) => left.label.localeCompare(right.label)),
    );
    return { pins, onRailTiles, moreTiles };
}
