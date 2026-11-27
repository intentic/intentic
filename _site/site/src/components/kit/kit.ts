// What the kit's components share at render time: the shapes their copy arrives in, and ids for the parts that point
// at each other (a Tip's trigger and its card, a glyph's gilt and its strokes).

import { held } from "../../lib/design/copy-budgets";
import type { GlyphName } from "../../lib/navIcons";

/** A Tip's words (DESIGN.md, "Detail on demand"): a title, a body, optional label/value rows and at most one link. */
export interface TipContent {
    /** At most three words: the app's tooltip title holds to the same. */
    title: string;
    /** At most forty words: the detail the surface left out. */
    body: string;
    /** Facts as label/value pairs. A label is a word or two; a value is a figure or a name. */
    rows?: readonly { label: string; value: string }[];
    /** The one door out of the card. */
    link?: { label: string; href: string };
}

/** One node of a Flow: a small niche glyph, a title, an optional mono label and an optional Tip. */
export interface FlowNode {
    glyph: GlyphName;
    title: string;
    /** A mono sub-label: a command, a route, a source. */
    label?: string;
    tip?: TipContent;
}

/** The one action a section head may carry (DESIGN.md, "Band compositions": one primary per band). */
export interface KitAction {
    label: string;
    href: string;
    /** `link` is gold text with an arrow; `button` the plain cartouche; `primary` the bronze one. */
    kind?: "link" | "button" | "primary";
}

/** A run of a lede: plain words, or a term (words with a dotted gold rule that open a Tip of their own). */
export type LedePart = { kind: "text"; text: string } | { kind: "term"; text: string; tip: TipContent };

/** Cuts a sentence at its terms' first appearances. A term the sentence does not contain is a mistake, not a no-op. */
export const splitTerms = (sentence: string, terms: Readonly<Record<string, TipContent>>, where: string): LedePart[] => {
    const found = Object.entries(terms)
        .map(([text, tip]) => ({ text, tip, at: sentence.indexOf(text) }))
        .toSorted((a, b) => a.at - b.at);
    const parts: LedePart[] = [];
    let cursor = 0;
    for (const term of found) {
        if (term.at < cursor) {
            throw new Error(`${where}: the term "${term.text}" is not in its sentence, or overlaps another term.`);
        }
        if (term.at > cursor) {
            parts.push({ kind: "text", text: sentence.slice(cursor, term.at) });
        }
        parts.push({ kind: "term", text: term.text, tip: term.tip });
        cursor = term.at + term.text.length;
    }
    if (cursor < sentence.length) {
        parts.push({ kind: "text", text: sentence.slice(cursor) });
    }
    return parts;
};

/** Each Tip's words through their budgets, so a card cannot grow into the paragraph it exists to replace. */
export const heldTip = (tip: TipContent, where: string): TipContent => ({
    title: held("tipTitle", tip.title, where),
    body: held("tipBody", tip.body, where),
    rows: tip.rows?.map((row) => ({ label: held("tipRow", row.label, where), value: row.value })),
    link: tip.link && { label: held("action", tip.link.label, where), href: tip.link.href },
});

/** Is this link leaving the site? It then opens beside the page, as every outbound link on the site does. */
export const isExternal = (href: string): boolean => /^https?:\/\//u.test(href);

let serial = 0;

/** A page-unique id. A counter, not a hash: two identical Tips on one page still need two cards. */
export const kitId = (prefix: string): string => {
    serial += 1;
    return `${prefix}-${serial.toString(36)}`;
};
