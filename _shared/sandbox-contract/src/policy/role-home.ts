import { type Fence, fenceCovers } from "./fence-paths.js";

// Where a role card LIVES, and therefore who may act through it. A card is not granted per person any more: a
// person holds areas, an area is folders, and a card whose home those folders cover is one that person may wear.
// Pure and shared, because the daemon refuses on this answer and the Access tab draws the consequence from it, and
// two implementations would disagree at exactly the boundary that matters.

// The field a card names a place with; structural rather than the Role type, so this stays free of the schema
// layer that imports it.
export interface RolePlace {
    readonly workspace?: { readonly startIn?: string | undefined } | undefined;
}

/**
 * The card's home as a fence: the folder it opens in, else undefined, the workspace root, which only somebody holding
 * the whole workspace covers. Where a conversation OPENS is the one place the card certainly works. (Until 2026-11-18 a
 * card with no `startIn` was homed in its own folder list; those folders are a profile's areas now, and the step that
 * moved them gave a card with a single folder that folder as its `startIn`.)
 */
export const roleHome = (card: RolePlace): Fence => {
    const startIn = card.workspace?.startIn;
    return startIn !== undefined && startIn !== "" ? [startIn] : undefined;
};

/**
 * Whether a person fenced to these folders may act through this card. An unfenced holder reaches every card; a fenced
 * one reaches those homed inside its folders, and never a card that lives at the workspace root.
 */
export const fenceHoldsRole = (fence: Fence, card: RolePlace): boolean => fenceCovers(fence, roleHome(card));
