import {
    type Box,
    type Cell,
    type Deck,
    emuToPx,
    type Frame,
    type ImageBox,
    type Outline,
    type Paragraph,
    type Slide,
    type TextBox,
} from "./deck-model";
import { openPackage, type Package, relatedOfType, relatedPart } from "./parts";
import { colorOf, hasNoFill, type Palette, readPalette, solidFillOf, styleFillOf, styleLineColorOf, styleTextColorOf } from "./style";
import { readParagraphs, readPlainText, type TextStyle } from "./text";
import { attr, find, kid, kids, num, relAttr } from "./xml-dom";
import { t } from "../i18n.js";

/* A .pptx TO SLIDES. Everything a shape does not say for itself is said by its layout, its master or the theme, so
   almost every read here is a walk up that chain rather than a lookup. What cannot be drawn in a browser is emitted
   as a labelled box, never dropped: a slide with a silent hole in it misrepresents the file. */

// A 16:9 deck, which is what a file with no readable slide size is overwhelmingly likely to be.
const DEFAULT_SIZE = { cx: 12_192_000, cy: 6_858_000 };

// `p:sp` shapes carry these three variants of the same idea; the master holds one style for each kind, not each name.
const KINDS: Record<string, "title" | "body" | "other"> = { title: "title", ctrTitle: "title", body: "body", subTitle: "body", obj: "body" };
const ANCHORS: Record<string, TextBox["anchor"]> = { t: "start", ctr: "center", b: "end" };
// The preset geometries worth telling apart; everything else is drawn as its bounding rectangle, which it nearly is.
const GEOMETRIES: Record<string, TextBox["shape"]> = {
    ellipse: "ellipse",
    flowChartConnector: "ellipse",
    roundRect: "round",
    round1Rect: "round",
    round2SameRect: "round",
    round2DiagRect: "round",
};
// What a browser can actually draw. A deck's other picture formats (emf, wmf) are Windows metafiles, and saying so
// beats a broken image.
const MIMES: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    svg: "image/svg+xml",
};
const GRAPHICS: Record<string, string> = { chart: "Chart", diagram: "SmartArt diagram", ole: "Embedded object" };

/** A shape's box, mapped out of whatever coordinate space its groups nest it in. */
type Mapper = (frame: Frame) => Frame;
const IDENTITY: Mapper = (frame) => frame;

interface Placeholder {
    readonly type: string;
    readonly idx: string | undefined;
}

interface SlideContext {
    readonly pack: Package;
    /** The slide part itself, since its own relationships are where its pictures live. */
    readonly path: string;
    readonly palette: Palette;
    readonly layout: Element | undefined;
    readonly master: Element | undefined;
    readonly masterStyles: Element | undefined;
    readonly presentationStyle: Element | undefined;
    readonly fonts: TextStyle["fonts"];
    readonly whole: Frame;
}

const frameOf = (xfrm: Element | undefined): Frame | undefined => {
    const x = num(kid(xfrm, "off"), "x");
    const y = num(kid(xfrm, "off"), "y");
    const cx = num(kid(xfrm, "ext"), "cx");
    const cy = num(kid(xfrm, "ext"), "cy");
    if (x === undefined || y === undefined || cx === undefined || cy === undefined) {
        return undefined;
    }
    // Rotation is in sixtieths of a thousandth of a degree, the same unit everywhere in DrawingML.
    return { x: emuToPx(x), y: emuToPx(y), width: emuToPx(cx), height: emuToPx(cy), rotation: (num(xfrm, "rot") ?? 0) / 60_000 };
};

// A group states its own box and, separately, the coordinate space its children were authored in; children are placed
// by mapping one onto the other. Without this, every grouped shape lands wherever it sat before it was grouped.
const groupMapper = (group: Element, outer: Mapper): Mapper => {
    const xfrm = kid(kid(group, "grpSpPr"), "xfrm");
    const box = frameOf(xfrm);
    const childWidth = num(kid(xfrm, "chExt"), "cx");
    const childHeight = num(kid(xfrm, "chExt"), "cy");
    if (box === undefined || childWidth === undefined || childHeight === undefined || childWidth === 0 || childHeight === 0) {
        return outer;
    }
    const originX = emuToPx(num(kid(xfrm, "chOff"), "x") ?? 0);
    const originY = emuToPx(num(kid(xfrm, "chOff"), "y") ?? 0);
    const scaleX = box.width / emuToPx(childWidth);
    const scaleY = box.height / emuToPx(childHeight);
    return (frame) =>
        outer({
            x: box.x + (frame.x - originX) * scaleX,
            y: box.y + (frame.y - originY) * scaleY,
            width: frame.width * scaleX,
            height: frame.height * scaleY,
            rotation: frame.rotation,
        });
};

const placeholderOf = (shape: Element | undefined): Placeholder | undefined => {
    const node = find(shape, "ph");
    // A placeholder with no stated type is a body one, which is the file format's own default, not a guess.
    return node === undefined ? undefined : { type: attr(node, "type") ?? "body", idx: attr(node, "idx") };
};

const kindOf = (placeholder: Placeholder | undefined): "title" | "body" | "other" => KINDS[placeholder?.type ?? ""] ?? "other";

// The shape in a layout or master that this slide shape inherits from: by index where the slide gives one, since a
// layout can hold two bodies, and by kind otherwise.
const inheritedShape = (tree: Element | undefined, wanted: Placeholder | undefined): Element | undefined => {
    if (wanted === undefined) {
        return undefined;
    }
    const shapes = kids(tree, "sp");
    const byIndex = wanted.idx === undefined ? undefined : shapes.find((shape) => placeholderOf(shape)?.idx === wanted.idx);
    const byType = shapes.find((shape) => placeholderOf(shape)?.type === wanted.type);
    return byIndex ?? byType ?? shapes.find((shape) => kindOf(placeholderOf(shape)) === kindOf(wanted));
};

const treeOf = (root: Element | undefined): Element | undefined => kid(kid(root, "cSld"), "spTree");

const chainOf = (shape: Element, context: SlideContext): readonly (Element | undefined)[] => {
    const placeholder = placeholderOf(shape);
    return [shape, inheritedShape(treeOf(context.layout), placeholder), inheritedShape(treeOf(context.master), placeholder)];
};

const textStyleOf = (chain: readonly (Element | undefined)[], context: SlideContext): TextStyle => ({
    palette: context.palette,
    lists: chain.map((shape) => kid(kid(shape, "txBody"), "lstStyle")),
    defaults: [kid(context.masterStyles, `${kindOf(placeholderOf(chain[0]))}Style`), context.presentationStyle],
    color: styleTextColorOf(chain[0], context.palette),
    fonts: context.fonts,
});

// Geometry inherits the same way text does: a title that states no position of its own takes the layout's, and a
// layout that states none takes the master's. Without the walk, half the shapes on a slide stack at the origin.
const boxOf = (chain: readonly (Element | undefined)[], context: SlideContext, map: Mapper): Frame => {
    for (const shape of chain) {
        const frame = frameOf(kid(kid(shape, "spPr"), "xfrm"));
        if (frame !== undefined) {
            return map(frame);
        }
    }
    return context.whole;
};

const checkpointOf = (chain: readonly (Element | undefined)[]): TextBox["anchor"] => {
    for (const shape of chain) {
        const anchor = ANCHORS[attr(kid(kid(shape, "txBody"), "bodyPr"), "anchor") ?? ""];
        if (anchor !== undefined) {
            return anchor;
        }
    }
    return "start";
};

const fillOf = (shape: Element, palette: Palette): string | undefined => {
    const properties = kid(shape, "spPr");
    // An explicit "no fill" beats the theme style the shape would otherwise take its colour from.
    return hasNoFill(properties) ? undefined : (solidFillOf(properties, palette) ?? styleFillOf(shape, palette));
};

const outlineOf = (shape: Element, palette: Palette): Outline | undefined => {
    const line = kid(kid(shape, "spPr"), "ln");
    if (hasNoFill(line)) {
        return undefined;
    }
    const color = solidFillOf(line, palette) ?? styleLineColorOf(shape, palette);
    // A hairline in the file is still a line on screen; below one pixel it would vanish entirely.
    return color === undefined ? undefined : { color, width: Math.max(1, emuToPx(num(line, "w") ?? 9525)) };
};

const hasWords = (paragraphs: readonly Paragraph[]): boolean => paragraphs.some((paragraph) => paragraph.runs.some((run) => run.text.trim() !== ""));

const textBoxOf = (shape: Element, context: SlideContext, map: Mapper): TextBox | undefined => {
    const chain = chainOf(shape, context);
    const paragraphs = readParagraphs(kid(shape, "txBody"), textStyleOf(chain, context));
    const fill = fillOf(shape, context.palette);
    const outline = outlineOf(shape, context.palette);
    const words = hasWords(paragraphs);
    // An empty placeholder is the layout's prompt to its author ("Click to add title"), not content: a deck is full of
    // them and a rendered deck must not be.
    if (!words && fill === undefined && outline === undefined) {
        return undefined;
    }
    return {
        kind: "text",
        ...boxOf(chain, context, map),
        fill,
        outline,
        shape: GEOMETRIES[attr(kid(kid(shape, "spPr"), "prstGeom"), "prst") ?? ""] ?? "rect",
        anchor: checkpointOf(chain),
        paragraphs: words ? paragraphs : [],
    };
};

const imageBoxOf = (picture: Element, context: SlideContext, map: Mapper): Box | undefined => {
    const frame = boxOf([picture], context, map);
    const part = relatedPart(context.pack, context.path, relAttr(find(kid(picture, "blipFill"), "blip"), "embed"));
    const bytes = part === undefined ? undefined : context.pack.bytes(part);
    if (part === undefined || bytes === undefined) {
        return undefined;
    }
    const mime = MIMES[part.split(".").pop()?.toLowerCase() ?? ""];
    if (mime === undefined) {
        return { kind: "unsupported", ...frame, label: t(`deck.pictureInFormatBrowsers`) };
    }
    const properties = find(kid(picture, "nvPicPr"), "cNvPr");
    return { kind: "image", ...frame, bytes, mime, description: attr(properties, "descr") ?? attr(properties, "name") } satisfies ImageBox;
};

const cellsOf = (row: Element, style: TextStyle, palette: Palette): Cell[] =>
    kids(row, "tc")
        // A merged cell's continuations carry no content of their own; the origin cell spans over them.
        .filter((cell) => attr(cell, "hMerge") === undefined && attr(cell, "vMerge") === undefined)
        .map((cell) => ({
            paragraphs: readParagraphs(kid(cell, "txBody"), style),
            fill: solidFillOf(kid(cell, "tcPr"), palette),
            colSpan: num(cell, "gridSpan") ?? 1,
            rowSpan: num(cell, "rowSpan") ?? 1,
        }));

const tableBoxOf = (table: Element, frame: Frame, context: SlideContext): Box => {
    // A table's own text has no placeholder to inherit from, so it resolves against the theme alone.
    const style: TextStyle = { palette: context.palette, lists: [], defaults: [context.presentationStyle], color: undefined, fonts: context.fonts };
    return {
        kind: "table",
        ...frame,
        columns: kids(kid(table, "tblGrid"), "gridCol").map((column) => emuToPx(num(column, "w") ?? 0)),
        rows: kids(table, "tr").map((row) => ({ height: emuToPx(num(row, "h") ?? 0), cells: cellsOf(row, style, context.palette) })),
    };
};

// A graphic frame holds whatever is not a shape or a picture: tables, which are drawn, and charts, diagrams and
// embedded objects, which are named.
const graphicBoxOf = (holder: Element, context: SlideContext, map: Mapper): Box | undefined => {
    const frame = map(frameOf(kid(holder, "xfrm")) ?? context.whole);
    const data = find(holder, "graphicData");
    const table = find(data, "tbl");
    if (table !== undefined) {
        return tableBoxOf(table, frame, context);
    }
    const uri = attr(data, "uri") ?? "";
    const label = Object.entries(GRAPHICS).find(([kind]) => uri.includes(`/${kind}`))?.[1];
    return label === undefined ? undefined : { kind: "unsupported", ...frame, label };
};

// What each kind of child in a shape tree becomes. Anything else on a slide (a connector, an ink annotation) draws
// nothing: an approximate line in the wrong place is worse than no line.
const BOXES: Record<string, (shape: Element, context: SlideContext, map: Mapper) => Box | undefined> = {
    sp: textBoxOf,
    pic: imageBoxOf,
    graphicFrame: graphicBoxOf,
};

const collectBoxes = (tree: Element | undefined, context: SlideContext, map: Mapper, out: Box[]): void => {
    for (const shape of tree?.children ?? []) {
        // A group is the one child that recurses: it nests a coordinate space of its own inside its box.
        if (shape.localName === "grpSp") {
            collectBoxes(shape, context, groupMapper(shape, map), out);
            continue;
        }
        const box = BOXES[shape.localName]?.(shape, context, map);
        if (box !== undefined) {
            out.push(box);
        }
    }
};

const backgroundOf = (root: Element | undefined, palette: Palette): string | undefined => {
    const background = kid(kid(root, "cSld"), "bg");
    // `bgRef` points into the theme's fill styles; its own colour is the part of that a flat background can honour.
    return solidFillOf(kid(background, "bgPr"), palette) ?? colorOf(kid(background, "bgRef"), palette);
};

const notesOf = (pack: Package, slidePath: string): string[] => {
    const part = relatedOfType(pack, slidePath, "notesSlide");
    const tree = treeOf(part === undefined ? undefined : pack.xml(part));
    const body = kids(tree, "sp").find((shape) => placeholderOf(shape)?.type === "body");
    return readPlainText(kid(body, "txBody"));
};

const fontsOf = (theme: Element | undefined): TextStyle["fonts"] => {
    const scheme = kid(kid(theme, "themeElements"), "fontScheme");
    return {
        major: attr(kid(kid(scheme, "majorFont"), "latin"), "typeface"),
        minor: attr(kid(kid(scheme, "minorFont"), "latin"), "typeface"),
    };
};

const readSlide = (pack: Package, path: string, number_: number, whole: Frame, presentationStyle: Element | undefined): Slide => {
    const root = pack.xml(path);
    const layoutPath = relatedOfType(pack, path, "slideLayout");
    const layout = layoutPath === undefined ? undefined : pack.xml(layoutPath);
    const masterPath = layoutPath === undefined ? undefined : relatedOfType(pack, layoutPath, "slideMaster");
    const master = masterPath === undefined ? undefined : pack.xml(masterPath);
    const themePath = masterPath === undefined ? undefined : relatedOfType(pack, masterPath, "theme");
    const theme = themePath === undefined ? undefined : pack.xml(themePath);
    const palette = readPalette(theme, kid(master, "clrMap"));
    const context: SlideContext = {
        pack,
        path,
        palette,
        layout,
        master,
        masterStyles: kid(master, "txStyles"),
        presentationStyle,
        fonts: fontsOf(theme),
        whole,
    };
    const boxes: Box[] = [];
    // Drawn back to front: the master's furniture, then the layout's, then the slide's own, which is paint order.
    collectBoxes(treeOf(master), context, IDENTITY, boxes);
    collectBoxes(treeOf(layout), context, IDENTITY, boxes);
    collectBoxes(treeOf(root), context, IDENTITY, boxes);
    return {
        number: number_,
        background: backgroundOf(root, palette) ?? backgroundOf(layout, palette) ?? backgroundOf(master, palette),
        boxes,
        notes: notesOf(pack, path),
    };
};

// The deck's own slide order, which is the only thing that gives it; part names are an approximation used when the
// index is missing or broken, and a deck whose slides were reordered would otherwise be read in the wrong order.
const slidePathsOf = (pack: Package, presentation: Element | undefined): string[] => {
    const ordered = kids(kid(presentation, "sldIdLst"), "sldId")
        .map((node) => relatedPart(pack, "ppt/presentation.xml", relAttr(node, "id")))
        .filter((path): path is string => path !== undefined);
    if (ordered.length > 0) {
        return ordered;
    }
    return pack.names
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .toSorted((left, right) => Number(/\d+/.exec(left)?.[0] ?? 0) - Number(/\d+/.exec(right)?.[0] ?? 0));
};

/** A presentation's bytes as slides ready to draw. Throws only when the file is not a readable zip. */
export const readDeck = (source: Uint8Array): Deck => {
    const pack = openPackage(source);
    const presentation = pack.xml("ppt/presentation.xml");
    const size = kid(presentation, "sldSz");
    const width = emuToPx(num(size, "cx") ?? DEFAULT_SIZE.cx);
    const height = emuToPx(num(size, "cy") ?? DEFAULT_SIZE.cy);
    const whole: Frame = { x: 0, y: 0, width, height, rotation: 0 };
    const defaultStyle = kid(presentation, "defaultTextStyle");
    return {
        width,
        height,
        slides: slidePathsOf(pack, presentation).map((path, index) => readSlide(pack, path, index + 1, whole, defaultStyle)),
    };
};
