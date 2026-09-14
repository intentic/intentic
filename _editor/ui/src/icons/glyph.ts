/** Source drawings for Intentic's icon pack. */
export interface Glyph {
    readonly outline: string;
    readonly solid?: string;
}

/** SVG text for diagram renderers; Vue controls bind these same paths as native elements. */
export const glyphBody = ({ outline, solid }: Glyph): string =>
    `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="2">${outline ? `<path d="${outline}"/>` : ``}</g>${solid ? `<path d="${solid}" fill="currentColor"/>` : ``}`;
