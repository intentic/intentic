// What a view looked like the last time it had something to show, kept so its next loading placeholder can be drawn
// in that exact form rather than a guessed one: the same elements with the same layout classes, each line of text a
// bar as wide as that line was, and each picture, field and button a block of its measured size. Taken from the live
// DOM (`takeImprint`), drawn by `<SkeletonSnapshot>` (skeletonGhost.ts). No words are kept: an imprint says how long
// a line was, never what it said.

/** Bumped when the encoding below changes; a stored imprint of another version is ignored and taken again. */
export const IMPRINT_VERSION = 1;

/**
 * An element kept as itself. Strings are indices into the imprint's table, so a list's repeated classes cost once.
 * Its optional fields are set one statement at a time as a capture finds them, so they are not readonly.
 */
export interface ImprintElement {
    /** Tag name, from a fixed list (`KEPT_TAGS`); anything else became `div` or `span` by how it laid out. */
    e: string;
    c?: number;
    /** The inline style, minus anything that loads (`url(`) or was mid-animation. */
    s?: number;
    /** Vue's scoped-style markers (`data-v-…`), so a component's scoped rules still reach its ghost. */
    v?: readonly number[];
    /** A table cell's span, which is layout and not paint. */
    x?: readonly [colspan: number, rowspan: number];
    k?: readonly ImprintNode[];
}

/** One run of text: a bar height, and the width of each line it filled. */
export interface ImprintText {
    h: number;
    w: readonly number[];
}

/** Something drawn whole: a picture, an icon, a field, a button, a badge. Measured, with its layout classes kept. */
export interface ImprintBlock {
    b: readonly [width: number, height: number];
    c?: number;
    /** Its corner radius as computed, when it had one. */
    r?: number;
    /** It flowed inline, so it stays inline-block rather than block. */
    i?: 1;
    /** It held its width in a tight row (an icon, a small button), so its ghost does too. */
    n?: 1;
    /** A drawing bigger than a glyph (a graph's edges, an illustration): its space is kept and nothing drawn in it. */
    g?: 1;
}

/** `0` is whitespace between inline things, kept as a space so the bars either side do not touch. */
export type ImprintNode = ImprintElement | ImprintText | ImprintBlock | 0;

export interface SkeletonImprint {
    readonly v: typeof IMPRINT_VERSION;
    /** When it was taken (epoch ms): what the store's pruning reads. */
    readonly at: number;
    readonly t: readonly string[];
    readonly root: ImprintElement;
}

export const isImprintText = (node: Exclude<ImprintNode, 0>): node is ImprintText => `w` in node;
export const isImprintBlock = (node: Exclude<ImprintNode, 0>): node is ImprintBlock => `b` in node;

// A capture stops here, keeping what it has: one view's skeleton is worth a few frames of idle time, never more. The
// clock is only read past the first `MIN_NODES`, so a busy thread still gets a usable imprint and never an empty one.
const MAX_NODES = 1_500;
const MIN_NODES = 100;
const BUDGET_MS = 12;
// What a skeleton can be seen in: two screens' height, from the root's own top, or from half a screen above the
// viewport for a root scrolled into (a transcript read at its end keeps its last turns, not its first). A long list
// keeps the rows a reader could scroll to before the data lands, not its thousandth.
const BAND_ABOVE = 0.5;
const BAND_HEIGHT = 2;
// A text bar is a little thinner than the type it stands for, as SkeletonRows' are.
const BAR_OF_FONT = 0.8;
const MIN_BAR = 6;
const MAX_BAR = 24;
const FALLBACK_FONT = 14;
// A painted control or badge no larger than this is drawn as one block; anything bigger (a clickable card, a row
// with a hover fill) is a container and keeps its insides. Anything painted and no taller than a badge is one, however
// it lays out: a status pill is often a flex row of a dot and a word.
const CHIP_HEIGHT = 40;
const CHIP_WIDTH = 320;
const BADGE_HEIGHT = 28;
// Blocks at most this wide hold their width in a tight row, as an icon or a small button does; a wider one, or a
// form field, may shrink as the element did.
const RIGID_WIDTH = 64;
// An SVG larger than this on either side is a drawing (a graph's edges, a chart, an illustration), not an icon: a grey
// slab the size of a graph's edge layer would cover the nodes the rest of the ghost draws on it.
const DRAWING_SIDE = 64;

// Elements whose own tag carries layout (a table's, a list's) or default styling the classes assume (a button's).
const KEPT_TAGS = new Set([
    `a`,
    `abbr`,
    `article`,
    `aside`,
    `b`,
    `blockquote`,
    `br`,
    `button`,
    `caption`,
    `code`,
    `col`,
    `colgroup`,
    `dd`,
    `del`,
    `details`,
    `div`,
    `dl`,
    `dt`,
    `em`,
    `fieldset`,
    `figcaption`,
    `figure`,
    `footer`,
    `form`,
    `h1`,
    `h2`,
    `h3`,
    `h4`,
    `h5`,
    `h6`,
    `header`,
    `hr`,
    `i`,
    `ins`,
    `kbd`,
    `label`,
    `legend`,
    `li`,
    `main`,
    `mark`,
    `nav`,
    `ol`,
    `p`,
    `pre`,
    `s`,
    `samp`,
    `section`,
    `small`,
    `span`,
    `strong`,
    `sub`,
    `summary`,
    `sup`,
    `table`,
    `tbody`,
    `td`,
    `tfoot`,
    `th`,
    `thead`,
    `time`,
    `tr`,
    `u`,
    `ul`,
]);
// Drawn whole, whatever they look like: their insides are pixels or a value, not text that wraps.
const BLOCK_TAGS = new Set([`audio`, `canvas`, `embed`, `iframe`, `img`, `input`, `meter`, `object`, `picture`, `progress`, `select`, `svg`, `textarea`, `video`]);
const FIELD_TAGS = new Set([`input`, `select`, `textarea`]);
const SKIPPED_TAGS = new Set([`link`, `meta`, `noscript`, `script`, `style`, `template`]);
const CONTROL_ROLES = new Set([`button`, `checkbox`, `combobox`, `link`, `menuitem`, `option`, `radio`, `slider`, `switch`, `tab`]);

// A block keeps only the classes that place it (margin, flex/grid item, position), never what paints it, so a
// primary button's ghost is a skeleton block and not a grey slab. Display is set from what it computed to.
const LAYOUT_CLASS =
    /^-?(?:m[trblxyse]?|inset(?:-[xy])?|top|right|bottom|left|start|end|z|order|col|row|basis|grow|shrink|flex|self|justify-self|place-self|float|clear|absolute|relative|fixed|sticky|static)(?:-|$)/;
const DISPLAY_CLASS = new Set([`block`, `contents`, `flex`, `grid`, `hidden`, `inline`, `inline-block`, `inline-flex`, `inline-grid`, `table`]);

// Inline declarations that would load something, or replay a transition into every later skeleton. A transform stays:
// it is where a graph's nodes and a virtual list's rows are placed, and a capture waits for movement to settle.
const DROPPED_STYLE = /url\(|image-set\(|expression\(|@import|^\s*(?:transition|animation|will-change)\b/i;

/** The alpha of a computed colour: `transparent`, `rgba(…, a)`, and the slash forms (`color(srgb … / a)`, `oklch(… / a)`). */
export const alphaOf = (color: string): number => {
    if (color === `` || color === `transparent`) {
        return 0;
    }
    const slashed = /\/\s*([\d.]+)(%?)\s*\)\s*$/.exec(color);
    if (slashed !== null) {
        const value = Number(slashed[1]);
        return slashed[2] === `%` ? value / 100 : value;
    }
    const rgba = /^rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)$/.exec(color);
    return rgba === null ? 1 : Number(rgba[1]);
};

const VISIBLE_ALPHA = 0.02;

const ruled = (width: string, style: string, color: string): boolean => Number.parseFloat(width) > 0 && style !== `none` && alphaOf(color) > VISIBLE_ALPHA;

const painted = (style: CSSStyleDeclaration): boolean =>
    alphaOf(style.backgroundColor) > VISIBLE_ALPHA ||
    (style.backgroundImage !== `` && style.backgroundImage !== `none`) ||
    (style.boxShadow !== `` && style.boxShadow !== `none`) ||
    ruled(style.borderTopWidth, style.borderTopStyle, style.borderTopColor) ||
    ruled(style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor);

const isEmpty = (element: Element): boolean => element.children.length === 0 && !/\S/.test(element.textContent);

// A painted thing a reader would call a control, a label or a mark rather than a region: a button, a badge, a pill, a
// status dot, a meter's fill. Drawn as a neutral block, so no colour a stale state painted (a green dot, an accent
// fill) is shown as if it were current.
const isChip = (element: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean => {
    // A shaded cell or row stays what it is: a block in its place would take the table's layout apart.
    if (!painted(style) || style.display.startsWith(`table`)) {
        return false;
    }
    // A mark with nothing in it, as short or as narrow as a badge: a dot, an accent rule, a meter's fill. A large empty
    // surface (a graph's pane, a backdrop) stays itself, since a slab of skeleton grey would lie over everything on it.
    if (isEmpty(element) && (rect.height <= BADGE_HEIGHT || rect.width <= BADGE_HEIGHT)) {
        return true;
    }
    if (rect.height > CHIP_HEIGHT || rect.width > CHIP_WIDTH) {
        return false;
    }
    if (rect.height <= BADGE_HEIGHT) {
        return true;
    }
    const role = element.getAttribute(`role`);
    return element.localName === `button` || element.localName === `a` || (role !== null && CONTROL_ROLES.has(role)) || style.display.startsWith(`inline`);
};

const baseOf = (token: string): string => token.slice(token.lastIndexOf(`:`) + 1).replace(/^!/, ``);

/** The classes of `classes` that place an element rather than paint it, which a block keeps. */
export const layoutClasses = (classes: string): string =>
    classes
        .split(/\s+/)
        .filter((token) => {
            const base = baseOf(token);
            return base !== `` && !DISPLAY_CLASS.has(base) && LAYOUT_CLASS.test(base);
        })
        .join(` `);

/** An inline style with anything that loads, or animates, taken out. */
export const sanitizeStyle = (style: string): string =>
    style
        .split(`;`)
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration !== `` && !DROPPED_STYLE.test(declaration))
        .join(`; `);

const round = (value: number): number => Math.round(value * 2) / 2;

interface Capture {
    readonly table: string[];
    readonly indices: Map<string, number>;
    readonly range: Range;
    readonly top: number;
    readonly bottom: number;
    readonly deadline: number;
    nodes: number;
}

const intern = (capture: Capture, value: string): number => {
    const known = capture.indices.get(value);
    if (known !== undefined) {
        return known;
    }
    const index = capture.table.push(value) - 1;
    capture.indices.set(value, index);
    return index;
};

const spent = (capture: Capture): boolean => capture.nodes >= MAX_NODES || (capture.nodes >= MIN_NODES && performance.now() > capture.deadline);

const outsideBand = (capture: Capture, top: number, bottom: number): boolean => bottom < capture.top || top > capture.bottom;

interface Line {
    readonly top: number;
    readonly bottom: number;
    left: number;
    right: number;
}

// The lines a text node filled: its client rects, joined where several share a line (a bidi run, an inline break).
const linesOf = (capture: Capture, node: Text): Line[] => {
    capture.range.selectNodeContents(node);
    const lines: Line[] = [];
    for (const rect of capture.range.getClientRects()) {
        const last = lines.at(-1);
        if (rect.width < 0.5) {
            continue;
        }
        if (last !== undefined && Math.abs(rect.top - last.top) < rect.height / 2) {
            last.left = Math.min(last.left, rect.left);
            last.right = Math.max(last.right, rect.right);
        } else {
            lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
        }
    }
    return lines;
};

// One bar per line the text filled inside the band, as tall as its type makes it.
const textOf = (capture: Capture, node: Text, fontSize: number): ImprintText | undefined => {
    const widths = linesOf(capture, node)
        .filter((line) => !outsideBand(capture, line.top, line.bottom))
        .map((line) => round(line.right - line.left));
    if (widths.length === 0) {
        return undefined;
    }
    return { h: round(Math.min(MAX_BAR, Math.max(MIN_BAR, fontSize * BAR_OF_FONT))), w: widths };
};

const blockOf = (capture: Capture, element: Element, style: CSSStyleDeclaration, rect: DOMRect): ImprintBlock => {
    const block: ImprintBlock = { b: [round(rect.width), round(rect.height)] };
    const layout = layoutClasses(element.getAttribute(`class`) ?? ``);
    if (layout !== ``) {
        block.c = intern(capture, layout);
    }
    if (style.borderRadius !== `` && style.borderRadius !== `0px`) {
        block.r = intern(capture, style.borderRadius);
    }
    if (style.display.startsWith(`inline`)) {
        block.i = 1;
    }
    if (rect.width <= RIGID_WIDTH && !FIELD_TAGS.has(element.localName)) {
        block.n = 1;
    }
    if (element.localName === `svg` && (rect.width > DRAWING_SIDE || rect.height > DRAWING_SIDE)) {
        block.g = 1;
    }
    return block;
};

const tagOf = (element: Element, style: CSSStyleDeclaration): string => {
    if (KEPT_TAGS.has(element.localName)) {
        return element.localName;
    }
    return style.display.startsWith(`inline`) ? `span` : `div`;
};

const spansOf = (element: Element): readonly [number, number] | undefined => {
    if (!(element instanceof HTMLTableCellElement)) {
        return undefined;
    }
    return element.colSpan > 1 || element.rowSpan > 1 ? [element.colSpan, element.rowSpan] : undefined;
};

const elementOf = (capture: Capture, element: Element, style: CSSStyleDeclaration): ImprintElement => {
    const kept: ImprintElement = { e: tagOf(element, style) };
    const classes = element.getAttribute(`class`)?.trim() ?? ``;
    if (classes !== ``) {
        kept.c = intern(capture, classes);
    }
    const inline = sanitizeStyle(element.getAttribute(`style`) ?? ``);
    if (inline !== ``) {
        kept.s = intern(capture, inline);
    }
    const scoped = element.getAttributeNames().filter((name) => name.startsWith(`data-v-`));
    if (scoped.length > 0) {
        kept.v = scoped.map((name) => intern(capture, name));
    }
    const spans = spansOf(element);
    if (spans !== undefined) {
        kept.x = spans;
    }
    const children = childrenOf(capture, element, style);
    if (children.length > 0) {
        kept.k = children;
    }
    return kept;
};

const childOf = (capture: Capture, element: Element): ImprintNode | undefined => {
    if (SKIPPED_TAGS.has(element.localName) || element.hasAttribute(`hidden`)) {
        return undefined;
    }
    const style = getComputedStyle(element);
    if (style.display === `none`) {
        return undefined;
    }
    capture.nodes += 1;
    // A `display: contents` element has no box of its own to measure; its children do.
    if (style.display === `contents`) {
        return elementOf(capture, element, style);
    }
    const rect = element.getBoundingClientRect();
    if (outsideBand(capture, rect.top, rect.bottom)) {
        return undefined;
    }
    if (BLOCK_TAGS.has(element.localName) || isChip(element, style, rect)) {
        return blockOf(capture, element, style, rect);
    }
    return elementOf(capture, element, style);
};

// What one child node becomes: whitespace a space (`0`), text its bars, an element itself or a block.
const nodeOf = (capture: Capture, node: ChildNode, fontSize: number): ImprintNode | undefined => {
    if (node instanceof Text) {
        if (!/\S/.test(node.data)) {
            return 0;
        }
        capture.nodes += 1;
        return textOf(capture, node, fontSize);
    }
    return node instanceof Element ? childOf(capture, node) : undefined;
};

const childrenOf = (capture: Capture, parent: Element, style: CSSStyleDeclaration): ImprintNode[] => {
    const fontSize = Number.parseFloat(style.fontSize) || FALLBACK_FONT;
    const kids: ImprintNode[] = [];
    for (const node of parent.childNodes) {
        if (spent(capture)) {
            break;
        }
        const kid = nodeOf(capture, node, fontSize);
        // One space between things, never leading or doubled: a collapsed run draws nothing more.
        if (kid !== undefined && (kid !== 0 || (kids.length > 0 && kids.at(-1) !== 0))) {
            kids.push(kid);
        }
    }
    if (kids.at(-1) === 0) {
        kids.pop();
    }
    return kids;
};

interface Box {
    readonly top: number;
    readonly height: number;
}

// Where the root sits. A `display: contents` root (a run of grid items wrapped only so they can be imprinted together,
// beside a live item that must stay live) has no box of its own; its children's together stand in for it.
const boxOf = (root: Element, style: CSSStyleDeclaration): Box | undefined => {
    const rects =
        style.display === `contents`
            ? [...root.children].map((child) => child.getBoundingClientRect()).filter((rect) => rect.width >= 1 && rect.height >= 1)
            : [root.getBoundingClientRect()].filter((rect) => rect.width >= 1 && rect.height >= 1);
    if (rects.length === 0) {
        return undefined;
    }
    const top = Math.min(...rects.map((rect) => rect.top));
    return { top, height: Math.max(...rects.map((rect) => rect.bottom)) - top };
};

export interface ImprintOptions {
    /** When it is taken (epoch ms); now by default. */
    readonly now?: number;
    /** How long the walk may run before it keeps what it has; `BUDGET_MS` by default. */
    readonly budgetMs?: number;
}

/**
 * The imprint of what `root` shows right now, or undefined when it shows nothing measurable (not laid out, zero-sized,
 * or the DOM has no layout at all, as under a test DOM). Synchronous and bounded (`MAX_NODES`, `BUDGET_MS`); call it
 * once the content has settled, from idle time.
 */
export const takeImprint = (root: Element, { now = Date.now(), budgetMs = BUDGET_MS }: ImprintOptions = {}): SkeletonImprint | undefined => {
    if (!root.isConnected) {
        return undefined;
    }
    const style = getComputedStyle(root);
    const box = boxOf(root, style);
    if (box === undefined) {
        return undefined;
    }
    const viewport = globalThis.innerHeight || box.height;
    const top = Math.max(box.top, -viewport * BAND_ABOVE);
    const capture: Capture = {
        table: [],
        indices: new Map(),
        range: document.createRange(),
        top,
        bottom: top + viewport * BAND_HEIGHT,
        deadline: performance.now() + budgetMs,
        nodes: 0,
    };
    const imprinted = elementOf(capture, root, style);
    capture.range.detach();
    // A root holding nothing measurable would draw as an empty box, which says less than the hand-drawn fallback.
    if (imprinted.k === undefined) {
        return undefined;
    }
    return { v: IMPRINT_VERSION, at: now, t: capture.table, root: imprinted };
};

/** Whether two imprints would draw the same, ignoring when each was taken. */
export const sameImprint = (left: SkeletonImprint, right: SkeletonImprint): boolean =>
    JSON.stringify(left.root) === JSON.stringify(right.root) && JSON.stringify(left.t) === JSON.stringify(right.t);
