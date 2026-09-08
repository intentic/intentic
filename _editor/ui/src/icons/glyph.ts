/** Source drawings for Intentic's icon pack. Two-unit strokes, square ends, cut corners, open interiors.
 * Ornament belongs in the silhouette; controls must still read at 12–16px. All geometry uses a 24-unit grid. */
export interface Glyph {
    readonly outline: string;
    readonly solid?: string;
}

/** SVG text for diagram renderers; Vue controls bind these same paths as native elements. */
export const glyphBody = ({ outline, solid }: Glyph): string =>
    `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="2">${outline ? `<path d="${outline}"/>` : ``}</g>${solid ? `<path d="${solid}" fill="currentColor"/>` : ``}`;
