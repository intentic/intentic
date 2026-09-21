import { type Fence, fenceCovers } from "./fence-paths.js";

// Where a persona card LIVES, and therefore who may act through it. A card is not granted per person any more: a
// person holds areas, an area is folders, and a card whose home those folders cover is one that person may wear.
// Pure and shared, because the daemon refuses on this answer and the Access tab draws the consequence from it, and
// two implementations would disagree at exactly the boundary that matters.

// The two fields a card names a place with; structural rather than the Persona type, so this stays free of the
// schema layer that imports it.
export interface PersonaPlace {
    readonly workspace?:
        | {
              readonly startIn?: string | undefined;
              readonly folders?: readonly string[] | undefined;
          }
        | undefined;
}

/**
 * The card's home as a fence: the folder it opens in, else the folders it may touch, else undefined — the workspace
 * root, which only somebody holding the whole workspace covers.
 * `startIn` wins over `folders` because where a conversation OPENS is the one place the card certainly works; the
 * folders it may touch are a ceiling, usually the whole tree, and reading that as the home would make nearly every
 * card owner-only.
 */
export const personaHome = (card: PersonaPlace): Fence => {
    const startIn = card.workspace?.startIn;
    if (startIn !== undefined && startIn !== "") {
        return [startIn];
    }
    const folders = card.workspace?.folders;
    return folders === undefined || folders.length === 0 ? undefined : folders;
};

/**
 * Whether a person fenced to these folders may act through this card. An unfenced holder reaches every card; a fenced
 * one reaches those homed inside its folders, and never a card that lives at the workspace root.
 */
export const fenceHoldsPersona = (fence: Fence, card: PersonaPlace): boolean => fenceCovers(fence, personaHome(card));
