import { attr, child, childElements, descendants, type XmlElement } from "./xml-tree";

/* ODF styles as CSS declarations. ODF measures in cm/in/pt/mm, all of which CSS understands, so lengths pass through
   as written rather than being converted to pixels. */

/** Kebab-case CSS declarations, applied inline: no stylesheet, so no style name can collide with the app's own. */
export type Css = Readonly<Record<string, string>>;

// A document is untrusted input. Nothing here may reach the network (a remote url() would tell whoever hosts it that
// this file was opened) or break out of the one declaration it is written into.
const FORBIDDEN = /url\(|expression|@import|[;{}<>\\]/i;
const safe = (value: string | undefined): string | undefined =>
    value === undefined || value.length > 200 || FORBIDDEN.test(value) ? undefined : value.trim() || undefined;

const TEXT_PROPS: Readonly<Record<string, string>> = {
    "fo:color": `color`,
    "fo:font-size": `font-size`,
    "fo:font-weight": `font-weight`,
    "fo:font-style": `font-style`,
    "fo:font-family": `font-family`,
    "fo:font-variant": `font-variant`,
    "fo:text-transform": `text-transform`,
    "fo:letter-spacing": `letter-spacing`,
    "fo:background-color": `background-color`,
    "fo:text-shadow": `text-shadow`,
};

const BLOCK_PROPS: Readonly<Record<string, string>> = {
    "fo:text-align": `text-align`,
    "fo:text-indent": `text-indent`,
    "fo:margin": `margin`,
    "fo:margin-left": `margin-left`,
    "fo:margin-right": `margin-right`,
    "fo:margin-top": `margin-top`,
    "fo:margin-bottom": `margin-bottom`,
    "fo:line-height": `line-height`,
    "fo:background-color": `background-color`,
    "fo:padding": `padding`,
    "fo:padding-left": `padding-left`,
    "fo:padding-right": `padding-right`,
    "fo:padding-top": `padding-top`,
    "fo:padding-bottom": `padding-bottom`,
    "fo:border": `border`,
    "fo:border-left": `border-left`,
    "fo:border-right": `border-right`,
    "fo:border-top": `border-top`,
    "fo:border-bottom": `border-bottom`,
    "fo:min-height": `min-height`,
    "style:vertical-align": `vertical-align`,
    "style:width": `width`,
    "fo:wrap-option": `white-space`,
};

const NUMBER_FORMAT: Readonly<Record<string, string>> = {
    "1": `decimal`,
    a: `lower-alpha`,
    A: `upper-alpha`,
    i: `lower-roman`,
    I: `upper-roman`,
};

// Word writes its bullets as Symbol/Wingdings code points in the private use area, and a document converted from
// .docx keeps them: rendered as written, every bullet in the list is a missing-glyph box.
const WINGDINGS: Readonly<Record<string, string>> = {
    "\uF0B7": `\u2022`, // Symbol: bullet
    "\uF0A7": `\u25AA`, // Wingdings: filled small square
    "\uF0A8": `\u25AB`,
    "\uF076": `\u2756`,
    "\uF0D8": `\u27A2`,
    "\uF0FC": `\u2714`,
    "\uF0FE": `\u25AA`,
    "\uF02D": `\u2013`,
    "\uF0B0": `\u25E6`,
    "\uF06C": `\u25CF`,
    "\uF0A1": `\u25C6`,
};

// Any other private-use code point is some symbol font's own bullet: a dot is closer than a missing-glyph box.
const unwingdings = (bullet: string): string => WINGDINGS[bullet] ?? (/^[\uE000-\uF8FF]/.test(bullet) ? `\u2022` : bullet);

export interface ListLevel {
    readonly ordered: boolean;
    /** A CSS `list-style-type`: a keyword for numbering, a quoted string for a bullet character. */
    readonly type: string;
    readonly start?: number;
}

export interface PageGeometry {
    readonly width: string;
    readonly height: string;
    readonly margin: Css;
    /** The master page's own fill, which a slide paints under everything on it. */
    readonly background?: string;
}

export interface OdfStyle {
    readonly family: string;
    readonly text: Css;
    readonly block: Css;
    readonly listStyle?: string;
    readonly columnWidth?: string;
    readonly rowHeight?: string;
    /** fo:break-before="page": where a printed copy would start a new sheet. */
    readonly pageBreak: boolean;
}

const EMPTY: OdfStyle = { family: ``, text: {}, block: {}, pageBreak: false };

const mapped = (element: XmlElement | undefined, table: Readonly<Record<string, string>>, into: Record<string, string>): void => {
    if (element === undefined) {
        return;
    }
    for (const [odf, css] of Object.entries(table)) {
        const value = safe(attr(element, odf));
        if (value !== undefined && value !== `transparent`) {
            into[css] = value;
        }
    }
};

// Underline, strike-through and sub/superscript are each spelled across two or three ODF attributes, so they are
// read here rather than through the flat table above.
const decorations = (properties: XmlElement, into: Record<string, string>): void => {
    const lines: string[] = [];
    if ((attr(properties, `style:text-underline-style`) ?? `none`) !== `none`) {
        lines.push(`underline`);
    }
    if ((attr(properties, `style:text-line-through-style`) ?? `none`) !== `none`) {
        lines.push(`line-through`);
    }
    if (lines.length > 0) {
        into[`text-decoration-line`] = lines.join(` `);
    }
    const position = attr(properties, `style:text-position`)?.split(/\s+/)[0];
    if (position !== undefined && position !== `0%`) {
        into[`vertical-align`] = position.startsWith(`-`) ? `sub` : `super`;
        into[`font-size`] = `0.7em`;
    }
};

const cssFor = (properties: XmlElement | undefined, table: Readonly<Record<string, string>>, fonts: ReadonlyMap<string, string>): Css => {
    const css: Record<string, string> = {};
    mapped(properties, table, css);
    if (properties === undefined) {
        return css;
    }
    if (table === TEXT_PROPS) {
        decorations(properties, css);
        const font = fonts.get(attr(properties, `style:font-name`) ?? ``);
        if (font !== undefined) {
            css[`font-family`] = font;
        }
    }
    return css;
};

const ANCHOR: Readonly<Record<string, string>> = { middle: `center`, bottom: `flex-end`, top: `flex-start` };

const borderOf = (properties: XmlElement, stroke: string): string => {
    const width = safe(attr(properties, `svg:stroke-width`)) ?? `1pt`;
    const color = safe(attr(properties, `svg:stroke-color`)) ?? `#000`;
    return `${width} ${stroke === `dash` ? `dashed` : `solid`} ${color}`;
};

// draw:fill and draw:stroke describe a shape the way a drawing program does; CSS says the same thing with a
// background and a border.
const graphics = (properties: XmlElement, css: Record<string, string>): void => {
    const color = safe(attr(properties, `draw:fill-color`));
    if (attr(properties, `draw:fill`) === `solid` && color !== undefined) {
        css[`background-color`] = color;
    }
    const stroke = attr(properties, `draw:stroke`);
    if (stroke !== undefined && stroke !== `none`) {
        css[`border`] = borderOf(properties, stroke);
    }
    const anchor = ANCHOR[attr(properties, `draw:textarea-vertical-align`) ?? ``];
    if (anchor !== undefined) {
        css[`--odf-anchor`] = anchor;
    }
};

const readStyle = (element: XmlElement, fonts: ReadonlyMap<string, string>): OdfStyle => {
    const text = child(element, `style:text-properties`);
    const paragraph = child(element, `style:paragraph-properties`);
    const cell = child(element, `style:table-cell-properties`);
    // A slide's own background is written as drawing-page properties, which are graphic properties by another name.
    const graphic = child(element, `style:graphic-properties`) ?? child(element, `style:drawing-page-properties`);
    const table = child(element, `style:table-properties`);
    const block: Record<string, string> = {};
    for (const source of [table, paragraph, cell, graphic]) {
        Object.assign(block, cssFor(source, BLOCK_PROPS, fonts));
    }
    if (graphic !== undefined) {
        graphics(graphic, block);
    }
    return {
        family: attr(element, `style:family`) ?? ``,
        text: cssFor(text, TEXT_PROPS, fonts),
        block,
        listStyle: attr(element, `style:list-style-name`),
        columnWidth: safe(attr(child(element, `style:table-column-properties`), `style:column-width`)),
        rowHeight: safe(
            attr(child(element, `style:table-row-properties`), `style:row-height`) ??
                attr(child(element, `style:table-row-properties`), `style:min-row-height`),
        ),
        pageBreak: attr(paragraph, `fo:break-before`) === `page`,
    };
};

const listLevel = (element: XmlElement): ListLevel => {
    if (element.tag === `text:list-level-style-number`) {
        const format = attr(element, `style:num-format`) ?? `1`;
        const start = Number.parseInt(attr(element, `text:start-value`) ?? `1`, 10);
        // An EMPTY number format is ODF for "no marker at all", which is how a converter writes a plain paragraph
        // that happens to sit in a list. Read as a missing format it would number every such line "1.".
        return { ordered: true, type: format === `` ? `none` : (NUMBER_FORMAT[format] ?? `decimal`), start: Number.isFinite(start) ? start : 1 };
    }
    const bullet = unwingdings(attr(element, `text:bullet-char`) ?? `•`);
    if (bullet === ``) {
        return { ordered: false, type: `none` };
    }
    // A CSS string list-style-type keeps the document's own glyph instead of substituting a browser default.
    return { ordered: false, type: FORBIDDEN.test(bullet) ? `disc` : `"${bullet.slice(0, 2)}"` };
};

export interface StyleBook {
    /** A style with its parent chain and family default already folded in. */
    style: (name: string | undefined) => OdfStyle;
    /** What an element with no style of its own inherits, e.g. an unstyled `paragraph`. */
    fallback: (family: string) => OdfStyle;
    list: (name: string | undefined, level: number) => ListLevel;
    page: (masterName?: string) => PageGeometry;
}

const A4: PageGeometry = { width: `21cm`, height: `29.7cm`, margin: { padding: `2cm` } };

const pageGeometry = (layout: XmlElement | undefined, background: string | undefined): PageGeometry => {
    const properties = layout === undefined ? undefined : child(layout, `style:page-layout-properties`);
    if (properties === undefined) {
        return background === undefined ? A4 : { ...A4, background };
    }
    const margin: Record<string, string> = {};
    mapped(properties, { "fo:margin-top": `padding-top`, "fo:margin-right": `padding-right`, "fo:margin-bottom": `padding-bottom`, "fo:margin-left": `padding-left` }, margin);
    return {
        width: safe(attr(properties, `fo:page-width`)) ?? A4.width,
        height: safe(attr(properties, `fo:page-height`)) ?? A4.height,
        margin,
        background: background ?? safe(attr(properties, `fo:background-color`)),
    };
};

// First writer wins across documents: content.xml's automatic styles are read before styles.xml's named ones, and
// a name never means two things inside one package.
const indexBy = (present: readonly XmlElement[], tag: string): Map<string, XmlElement> => {
    const found = new Map<string, XmlElement>();
    for (const root of present) {
        for (const element of descendants(root, tag)) {
            const name = attr(element, `style:name`);
            if (name !== undefined && !found.has(name)) {
                found.set(name, element);
            }
        }
    }
    return found;
};

const readFonts = (present: readonly XmlElement[]): Map<string, string> => {
    const fonts = new Map<string, string>();
    for (const [name, face] of indexBy(present, `style:font-face`)) {
        const family = safe(attr(face, `svg:font-family`));
        if (family !== undefined) {
            fonts.set(name, family);
        }
    }
    return fonts;
};

const merge = (own: OdfStyle, base: OdfStyle): OdfStyle => ({
    ...own,
    text: { ...base.text, ...own.text },
    block: { ...base.block, ...own.block },
    listStyle: own.listStyle ?? base.listStyle,
    columnWidth: own.columnWidth ?? base.columnWidth,
    rowHeight: own.rowHeight ?? base.rowHeight,
});

/**
 * Every style in a package: content.xml's automatic styles first, styles.xml's named ones behind them. `roots` is
 * each of those documents' root element.
 */
export const readStyles = (roots: readonly (XmlElement | undefined)[]): StyleBook => {
    const present = roots.filter((root): root is XmlElement => root !== undefined);
    const fonts = readFonts(present);
    const raw = indexBy(present, `style:style`);
    const masters = indexBy(present, `style:master-page`);
    const layouts = indexBy(present, `style:page-layout`);
    const defaults = new Map<string, OdfStyle>();
    for (const root of present) {
        for (const element of descendants(root, `style:default-style`)) {
            defaults.set(attr(element, `style:family`) ?? ``, readStyle(element, fonts));
        }
    }
    const lists = new Map(
        [...indexBy(present, `text:list-style`)].map(([name, element]) => [name, childElements(element).map((level) => listLevel(level))]),
    );

    const resolved = new Map<string, OdfStyle>();
    // `seen` is the chain already being resolved: a style naming itself as its parent would otherwise never return.
    const resolve = (name: string, seen: ReadonlySet<string>): OdfStyle => {
        const cached = resolved.get(name);
        const element = raw.get(name);
        if (cached !== undefined || element === undefined) {
            return cached ?? EMPTY;
        }
        const own = readStyle(element, fonts);
        const parentName = attr(element, `style:parent-style-name`);
        const parent = parentName === undefined || seen.has(parentName) ? undefined : resolve(parentName, new Set([...seen, name]));
        const merged = merge(own, parent ?? defaults.get(own.family) ?? EMPTY);
        resolved.set(name, merged);
        return merged;
    };

    return {
        style: (name) => (name === undefined ? EMPTY : resolve(name, new Set())),
        fallback: (family) => defaults.get(family) ?? EMPTY,
        list: (name, level) => {
            const levels = name === undefined ? undefined : lists.get(name);
            return levels?.[Math.min(level, levels.length - 1)] ?? { ordered: false, type: `disc` };
        },
        page: (masterName) => {
            const master = (masterName === undefined ? undefined : masters.get(masterName)) ?? [...masters.values()][0];
            const layout = master === undefined ? undefined : layouts.get(attr(master, `style:page-layout-name`) ?? ``);
            const drawing = master === undefined ? undefined : resolve(attr(master, `draw:style-name`) ?? ``, new Set());
            return pageGeometry(layout, drawing?.block[`background-color`]);
        },
    };
};
