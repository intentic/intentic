import { blocksOf, type Context } from "./content";
import { textOfBlock, type Block } from "./document-model";
import { bodyOf, toCentimetres, type OdfPackage } from "./pkg";
import { readStyles, type Css } from "./styles";
import { attr, child, childElements, descendant, textOf, type XmlElement } from "./xml-tree";

/* A presentation or drawing as slides of positioned shapes. Positions are ODF's own absolute lengths, kept as
   written: the viewer scales the whole slide rather than recomputing every box. */

export interface Shape {
    /** Position, size, fill and border, ready to put on an absolutely positioned box. */
    readonly css: Css;
    readonly blocks: readonly Block[];
    readonly image?: { readonly src: string; readonly alt: string };
}

export interface Slide {
    readonly name: string;
    readonly shapes: readonly Shape[];
    readonly notes: readonly Block[];
    readonly background: string | undefined;
}

export interface Deck {
    readonly slides: readonly Slide[];
    /** Slide size in centimetres, which is what the viewer scales from. */
    readonly width: number;
    readonly height: number;
    readonly title: string | undefined;
}

// Shapes with a geometry ODF writes as x/y/width/height. A line or a connector is a pair of endpoints instead, and
// is left out rather than drawn as a box where it is not.
const SHAPES = new Set([`draw:frame`, `draw:custom-shape`, `draw:rect`, `draw:ellipse`, `draw:circle`, `draw:polygon`, `draw:regular-polygon`, `draw:caption`]);

const ROUND = new Set([`draw:ellipse`, `draw:circle`]);

const placement = (element: XmlElement): Record<string, string> => {
    const css: Record<string, string> = { position: `absolute` };
    const geometry: Readonly<Record<string, string>> = { "svg:x": `left`, "svg:y": `top`, "svg:width": `width`, "svg:height": `height` };
    for (const [name, property] of Object.entries(geometry)) {
        const value = attr(element, name);
        if (value !== undefined && /^-?[\d.]+(cm|mm|in|pt|pc|px)$/.test(value)) {
            css[property] = value;
        }
    }
    return css;
};

// The frame's OWN picture, which is a direct child: a picture sitting in one cell of a table inside this frame
// belongs to that cell, and hoisting it here would stretch it across the whole shape.
const imageOf = (element: XmlElement, context: Context): Shape["image"] => {
    const href = attr(child(element, `draw:image`), `xlink:href`);
    const src = href === undefined ? undefined : context.image(href);
    if (src === undefined) {
        return undefined;
    }
    const title = child(element, `svg:title`) ?? child(element, `svg:desc`);
    return { src, alt: title === undefined ? `` : textOf(title) };
};

const shapeOf = (element: XmlElement, context: Context): Shape => {
    const style = context.styles.style(attr(element, `draw:style-name`));
    const css: Record<string, string> = { ...style.block, ...placement(element) };
    if (ROUND.has(element.tag)) {
        css[`border-radius`] = `50%`;
    }
    // A frame's text lives in its text box; a drawn shape carries its paragraphs directly, and a frame around a
    // table has the table as its child. Reading the box when there is one and the shape otherwise covers all three.
    const box = descendant(element, `draw:text-box`);
    const blocks = blocksOf(box ?? element, context);
    // A frame holding a table also carries a PICTURE of that table, which writers leave for readers that cannot lay
    // one out. Drawing both would stack the same table twice, so live content wins wherever there is any.
    const hasText = blocks.some((block) => textOfBlock(block).trim() !== ``);
    return { css, blocks, image: hasText ? undefined : imageOf(element, context) };
};

const shapesOf = (page: XmlElement, context: Context, into: Shape[]): void => {
    for (const element of childElements(page)) {
        if (element.tag === `draw:g`) {
            // A group only nests: its children carry their own absolute positions on the page.
            shapesOf(element, context, into);
            continue;
        }
        if (SHAPES.has(element.tag)) {
            into.push(shapeOf(element, context));
        }
    }
};

const notesOf = (page: XmlElement, context: Context): Block[] => {
    const notes = descendant(page, `presentation:notes`);
    if (notes === undefined) {
        return [];
    }
    const frames: Shape[] = [];
    shapesOf(notes, context, frames);
    // A notes page carries a copy of the slide's number in its own placeholder; a bare digit is that, not a note.
    return frames.flatMap((frame) => frame.blocks).filter((block) => !/^\d+$/.test(textOfBlock(block).trim()));
};

/** An .odp or .odg as slides. A drawing is a presentation with one page and no notes, so both read the same way. */
export const readPresentation = (pkg: OdfPackage): Deck => {
    const styles = readStyles([pkg.content, pkg.styles]);
    const context: Context = { styles, image: pkg.image, notes: [] };
    const body = bodyOf(pkg.content, `office:presentation`) ?? bodyOf(pkg.content, `office:drawing`);
    const pages = body === undefined ? [] : childElements(body).filter((page) => page.tag === `draw:page`);
    const geometry = styles.page(attr(pages[0], `draw:master-page-name`));

    const slides = pages.map((page, index) => {
        const shapes: Shape[] = [];
        shapesOf(page, context, shapes);
        return {
            name: attr(page, `draw:name`) ?? `Slide ${index + 1}`,
            shapes,
            notes: notesOf(page, context),
            background: styles.style(attr(page, `draw:style-name`)).block[`background-color`] ?? styles.page(attr(page, `draw:master-page-name`)).background,
        };
    });

    return {
        slides,
        width: toCentimetres(geometry.width, 28),
        height: toCentimetres(geometry.height, 15.75),
        title: pkg.title,
    };
};
