import { type Paragraph, type Run, SZ_PER_PX, emuToPx } from "./deck-model";
import { colorOf, type Palette } from "./style";
import { attr, flag, kid, kids, num } from "./xml-dom";

/* TEXT, and the cascade behind every word of it. A run on a slide typically states nothing but its characters: its
   size, weight, colour and bullet come from the shape's list style, then the layout placeholder's, then the master's
   text styles for that placeholder kind, then the presentation's default. Resolving that chain is the difference
   between a readable slide and 10pt black text in the corner of every box. */

/** Where a paragraph's properties are looked up, nearest source first. */
export interface TextStyle {
    readonly palette: Palette;
    /** `a:lstStyle` blocks: the shape's own, its layout placeholder's, its master placeholder's. */
    readonly lists: readonly (Element | undefined)[];
    /** The master's `p:titleStyle`/`p:bodyStyle`/`p:otherStyle`, then the presentation's `p:defaultTextStyle`. */
    readonly defaults: readonly (Element | undefined)[];
    /** The colour the shape's theme style names, for text that states none of its own. */
    readonly color: string | undefined;
    /** The theme's major and minor typefaces, which `+mj-lt` and `+mn-lt` stand for. */
    readonly fonts: { readonly major: string | undefined; readonly minor: string | undefined };
}

// PowerPoint's own defaults, used only when nothing in the chain says otherwise.
const DEFAULT_SIZE = 18 * (96 / 72);
const DEFAULT_COLOR = "#000000";
const DEFAULT_LINE_HEIGHT = 1.2;
// Each outline level indents by 0.375", which is what a master with no explicit `marL` means.
const LEVEL_INDENT_EMU = 342_900;

const ALIGNMENTS: Record<string, Paragraph["align"]> = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" };

const levelOf = (properties: Element | undefined): number => Math.min(8, Math.max(0, num(properties, "lvl") ?? 0));

// The `a:lvlNpPr` for this level out of one style block; levels are 1-based in the file and 0-based on a paragraph.
const levelProps = (block: Element | undefined, level: number): Element | undefined => kid(block, `lvl${level + 1}pPr`);

// Nearest first: the paragraph's own properties, then every inherited block's entry for its level.
const cascade = (properties: Element | undefined, level: number, style: TextStyle): (Element | undefined)[] => [
    properties,
    ...style.lists.map((block) => levelProps(block, level)),
    ...style.defaults.map((block) => levelProps(block, level)),
];

const pick = <T>(sources: readonly (Element | undefined)[], read: (source: Element) => T | undefined): T | undefined => {
    for (const source of sources) {
        const value = source === undefined ? undefined : read(source);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
};

// A run's properties come from the run itself, then from each level's `a:defRPr` in the same order paragraphs use.
const runSources = (runProperties: Element | undefined, paragraphSources: readonly (Element | undefined)[]): (Element | undefined)[] => [
    runProperties,
    ...paragraphSources.map((source) => kid(source, "defRPr")),
];

const fontOf = (sources: readonly (Element | undefined)[], style: TextStyle): string | undefined => {
    const typeface = pick(sources, (source) => attr(kid(source, "latin"), "typeface"));
    if (typeface === undefined) {
        return undefined;
    }
    // `+mj-lt` and `+mn-lt` are the theme's heading and body faces, named rather than spelled out.
    if (typeface === "+mj-lt") {
        return style.fonts.major;
    }
    return typeface === "+mn-lt" ? style.fonts.minor : typeface;
};

const readRun = (node: Element, paragraphSources: readonly (Element | undefined)[], style: TextStyle): Run => {
    const sources = runSources(kid(node, "rPr"), paragraphSources);
    const size = pick(sources, (source) => num(source, "sz"));
    return {
        text: kid(node, "t")?.textContent ?? "",
        size: size === undefined ? DEFAULT_SIZE : size / SZ_PER_PX,
        bold: pick(sources, (source) => flag(source, "b")) ?? false,
        italic: pick(sources, (source) => flag(source, "i")) ?? false,
        underline: (pick(sources, (source) => attr(source, "u")) ?? "none") !== "none",
        color: pick(sources, (source) => colorOf(kid(source, "solidFill"), style.palette)) ?? style.color ?? DEFAULT_COLOR,
        font: fontOf(sources, style),
    };
};

// A bullet is stated once, as one of three mutually exclusive elements, by whichever source in the chain speaks first:
// a paragraph that says `buNone` is not a paragraph the master can put a dot in front of.
const bulletOf = (sources: readonly (Element | undefined)[], index: number): string | undefined =>
    pick(sources, (source) => {
        if (kid(source, "buNone") !== undefined) {
            return "";
        }
        const char = kid(source, "buChar");
        if (char !== undefined) {
            return attr(char, "char") ?? "•";
        }
        const auto = kid(source, "buAutoNum");
        // Numbered lists are counted here rather than by CSS, since the count is per level within one shape.
        return auto === undefined ? undefined : `${(num(auto, "startAt") ?? 1) + index}.`;
    }) || undefined;

const lineHeightOf = (sources: readonly (Element | undefined)[]): number => {
    const spacing = pick(sources, (source) => kid(source, "lnSpc"));
    const percent = num(kid(spacing, "spcPct"), "val");
    if (percent !== undefined) {
        return (percent / 100_000) * DEFAULT_LINE_HEIGHT;
    }
    // Exact point spacing, which a deck uses to pack text: expressed here against the size the run will be drawn at.
    const points = num(kid(spacing, "spcPts"), "val");
    return points === undefined ? DEFAULT_LINE_HEIGHT : Math.max(0.5, points / 100 / 18);
};

const spaceBeforeOf = (sources: readonly (Element | undefined)[]): number => {
    const points = num(kid(pick(sources, (source) => kid(source, "spcBef")), "spcPts"), "val");
    return points === undefined ? 0 : (points / 100) * (96 / 72);
};

// Runs, fields and line breaks in the order the paragraph states them. A field (a slide number, a date) carries its
// last rendered value, which is the only value there is to draw; a break is a run whose text is a newline.
const readRuns = (node: Element, sources: readonly (Element | undefined)[], style: TextStyle): Run[] => {
    const runs: Run[] = [];
    for (const child of node.children) {
        if (child.localName === "r" || child.localName === "fld") {
            runs.push(readRun(child, sources, style));
        } else if (child.localName === "br") {
            runs.push({ ...readRun(child, sources, style), text: "\n" });
        }
    }
    return runs;
};

/** One text body's paragraphs, with numbered items counted per level within this body — the scope a deck numbers in. */
export const readParagraphs = (body: Element | undefined, style: TextStyle): Paragraph[] => {
    const counters = new Map<number, number>();
    return kids(body, "p").map((node) => {
        const properties = kid(node, "pPr");
        const level = levelOf(properties);
        const sources = cascade(properties, level, style);
        const index = counters.get(level) ?? 0;
        counters.set(level, index + 1);
        const runs = readRuns(node, sources, style);
        const marginLeft = pick(sources, (source) => num(source, "marL"));
        return {
            align: ALIGNMENTS[pick(sources, (source) => attr(source, "algn")) ?? ""] ?? "left",
            indent: emuToPx(marginLeft ?? level * LEVEL_INDENT_EMU),
            bullet: runs.length === 0 ? undefined : bulletOf(sources, index),
            spaceBefore: spaceBeforeOf(sources),
            lineHeight: lineHeightOf(sources),
            // An empty paragraph is a blank line the author put there; it keeps the size it would have had.
            runs: runs.length > 0 ? runs : [{ ...readRun(node, sources, style), text: "" }],
        };
    });
};

/** The same text as plain lines, for speaker notes, which are read rather than laid out. */
export const readPlainText = (body: Element | undefined): string[] =>
    kids(body, "p")
        .map((node) =>
            [...node.getElementsByTagName("*")]
                .filter((element) => element.localName === "t")
                .map((element) => element.textContent ?? "")
                .join(""),
        )
        .map((line) => line.trim())
        .filter((line) => line !== "");
