/* What <PersonaFace> needs of a persona, and nothing more, so a folder card, a rail row. */
export interface PersonaLike {
    readonly id: string;
    readonly label?: string;
}

// A glyph is one shape; a face is a dozen, and in a glyph's box they collapse — drawn 22px wide, an adventurer's
// mouth renders 2.1 CSS px tall and its freckles 1.1. So a face gets its own box, named by what the surface is
// rather than by a tier, and the surface pays for it out of its own vertical padding: nothing here makes a row taller.
export const FACE_SIZES = {
    /** A toolbar pill or a closed picker: the label beside it names the persona, so this need only be recognisable. */
    pill: 22,
    /** A row in a list or a panel, where the face is what tells one row from the next. */
    row: 36,
    /** A card of its own: the chat persona rail. */
    card: 56,
} as const;
