/* WHAT A SLIDE IS, once the OOXML is resolved: boxes at pixel positions, already inherited from layout and master,
   already coloured from the theme. The parse does every lookup; the component only draws, and can draw nothing the
   parse did not already decide. */

/** 914400 EMU to the inch, 96 CSS pixels to the inch. Every position and size in a deck arrives in EMU. */
export const EMU_PER_PX = 9525;

/** Font sizes arrive in hundredths of a point; a point is 4/3 of a CSS pixel. */
export const SZ_PER_PX = 75;

export const emuToPx = (emu: number): number => emu / EMU_PER_PX;

export interface Deck {
    /** The slide canvas in pixels; every box's position is inside it, and the component scales the whole thing to fit. */
    readonly width: number;
    readonly height: number;
    readonly slides: readonly Slide[];
}

export interface Slide {
    /** 1-based, as a reader counts them, and as the deck's own slide order gives them. */
    readonly number: number;
    readonly background: string | undefined;
    readonly boxes: readonly Box[];
    /** Speaker notes as plain paragraphs; empty when the slide carries none. */
    readonly notes: readonly string[];
}

export interface Frame {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    /** Degrees clockwise about the box's centre. */
    readonly rotation: number;
}

export interface Run {
    readonly text: string;
    /** Pixels, already resolved through the run, its paragraph, its placeholder's layout and the master. */
    readonly size: number;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly underline: boolean;
    readonly color: string;
    /** The typeface the deck asked for; `undefined` means "whatever this app renders in". */
    readonly font: string | undefined;
}

export interface Paragraph {
    readonly align: "left" | "center" | "right" | "justify";
    /** Pixels of indent from the box's left edge, which is how a deck states its outline levels. */
    readonly indent: number;
    /** The bullet glyph or number to draw, or `undefined` for a paragraph that has none. */
    readonly bullet: string | undefined;
    readonly spaceBefore: number;
    /** A multiple of the font size. */
    readonly lineHeight: number;
    readonly runs: readonly Run[];
}

export interface Outline {
    readonly color: string;
    readonly width: number;
}

export interface TextBox extends Frame {
    readonly kind: "text";
    readonly fill: string | undefined;
    readonly outline: Outline | undefined;
    /** The few preset geometries worth distinguishing; everything else draws as its bounding rectangle. */
    readonly shape: "rect" | "round" | "ellipse";
    /** Where the text sits vertically in the box — a title is usually centred in its own. */
    readonly anchor: "start" | "center" | "end";
    readonly paragraphs: readonly Paragraph[];
}

export interface ImageBox extends Frame {
    readonly kind: "image";
    readonly bytes: Uint8Array;
    readonly mime: string;
    /** The alt text the deck carries, which is all a screen reader ever gets from a picture in a deck. */
    readonly description: string | undefined;
}

export interface Cell {
    readonly paragraphs: readonly Paragraph[];
    readonly fill: string | undefined;
    readonly colSpan: number;
    readonly rowSpan: number;
}

export interface Row {
    readonly height: number;
    readonly cells: readonly Cell[];
}

export interface TableBox extends Frame {
    readonly kind: "table";
    /** Column widths in pixels, from the table's own grid. */
    readonly columns: readonly number[];
    readonly rows: readonly Row[];
}

// A chart, a SmartArt diagram or an embedded object: real content this viewer cannot draw. Shown as a labelled box
// rather than dropped, because a slide with a hole in it silently lies about what is on it.
export interface UnsupportedBox extends Frame {
    readonly kind: "unsupported";
    readonly label: string;
}

export type Box = TextBox | ImageBox | TableBox | UnsupportedBox;
