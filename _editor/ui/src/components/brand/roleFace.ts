/* What <RoleFace> needs of a role, and nothing more, so a folder card, a rail row. */
export interface RoleLike {
    readonly id: string;
    readonly label?: string;
}

// Face sizes follow their surface. Toolbar faces stay still; the rail gives the illustrated crown and props room.
export const FACE_SIZES = {
    /** A toolbar pill or a closed picker: the label beside it names the role, so this need only be recognisable. */
    pill: 22,
    /** A row in a list or a panel, where the face is what tells one row from the next. */
    row: 36,
    /** A card of its own: the chat role rail. */
    card: 64,
} as const;
