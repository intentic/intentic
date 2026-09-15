import type { Css } from "../odf/styles";

/* The formatting an RTF reader carries: one set of character properties and one of paragraph properties, saved and
   restored with every group. */

export interface RtfStyle {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    /** Half-points, as RTF counts them: \fs24 is 12pt. */
    size: number | undefined;
    color: string | undefined;
    background: string | undefined;
    font: string | undefined;
    vertical: "super" | "sub" | undefined;
    caps: boolean;
    smallCaps: boolean;
    hidden: boolean;
    /** \uc: how many characters follow a \u escape as its fallback, to be discarded. */
    uc: number;
    align: string | undefined;
    indentLeft: number | undefined;
    indentFirst: number | undefined;
    spaceBefore: number | undefined;
    spaceAfter: number | undefined;
    inTable: boolean;
}

// Every field is stated, undefined included: the reader clears formatting by merging this over what it holds, and
// a field left out of the object would survive the merge instead of being cleared.
export const initialStyle = (): RtfStyle => ({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    caps: false,
    smallCaps: false,
    hidden: false,
    uc: 1,
    inTable: false,
    size: undefined,
    color: undefined,
    background: undefined,
    font: undefined,
    vertical: undefined,
    align: undefined,
    indentLeft: undefined,
    indentFirst: undefined,
    spaceBefore: undefined,
    spaceAfter: undefined,
});

/**
 * \plain: character formatting back to nothing, PARAGRAPH formatting untouched — that is what \pard is for. Without
 * this, a header cell's white text runs on into every cell after it, invisible on a white page.
 */
export const plainStyle = (style: RtfStyle): RtfStyle => ({
    ...initialStyle(),
    inTable: style.inTable,
    align: style.align,
    indentLeft: style.indentLeft,
    indentFirst: style.indentFirst,
    spaceBefore: style.spaceBefore,
    spaceAfter: style.spaceAfter,
});

const TWIPS_PER_INCH = 1440;

/** Twips (RTF's unit: a twentieth of a point) as an inch measurement CSS understands. */
export const twips = (value: number): string => `${(value / TWIPS_PER_INCH).toFixed(3)}in`;

const FLAGS: readonly (readonly [keyof RtfStyle, string, string])[] = [
    [`bold`, `font-weight`, `bold`],
    [`italic`, `font-style`, `italic`],
    [`smallCaps`, `font-variant`, `small-caps`],
    [`caps`, `text-transform`, `uppercase`],
];

const TEXT_VALUES: readonly (readonly [keyof RtfStyle, string])[] = [
    [`color`, `color`],
    [`background`, `background-color`],
    [`font`, `font-family`],
    [`vertical`, `vertical-align`],
];

const decorationOf = (style: RtfStyle): string | undefined => {
    const lines = [style.underline ? `underline` : ``, style.strike ? `line-through` : ``].filter((line) => line !== ``);
    return lines.length === 0 ? undefined : lines.join(` `);
};

// Superscript and subscript are drawn small, whatever size the run declares.
const sizeOf = (style: RtfStyle): string | undefined => {
    if (style.vertical !== undefined) {
        return `0.7em`;
    }
    return style.size === undefined ? undefined : `${style.size / 2}pt`;
};

export const characterCss = (style: RtfStyle): Css => {
    const css: Record<string, string> = {};
    for (const [flag, property, value] of FLAGS) {
        if (style[flag] === true) {
            css[property] = value;
        }
    }
    for (const [key, property] of TEXT_VALUES) {
        const value = style[key];
        if (typeof value === `string`) {
            css[property] = value;
        }
    }
    const decoration = decorationOf(style);
    if (decoration !== undefined) {
        css[`text-decoration-line`] = decoration;
    }
    const size = sizeOf(style);
    if (size !== undefined) {
        css[`font-size`] = size;
    }
    return css;
};

const LENGTHS: readonly (readonly [keyof RtfStyle, string])[] = [
    [`indentLeft`, `margin-left`],
    [`indentFirst`, `text-indent`],
    [`spaceBefore`, `margin-top`],
    [`spaceAfter`, `margin-bottom`],
];

export const paragraphCss = (style: RtfStyle): Css => {
    const css: Record<string, string> = {};
    if (style.align !== undefined) {
        css[`text-align`] = style.align;
    }
    for (const [key, property] of LENGTHS) {
        const value = style[key];
        if (typeof value === `number` && value !== 0) {
            css[property] = twips(value);
        }
    }
    return css;
};
