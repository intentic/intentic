/* Fit-content pruning: walk the body top-down, score every element on text density, link density, tag
 * kind, class/id smell and text mass, and drop the subtrees that score under the threshold. What survives
 * is the readable page — the article without its chrome.
 *
 * The scoring model is a TypeScript port of crawl4ai's PruningContentFilter (Apache-2.0,
 * https://github.com/unclecode/crawl4ai — crawl4ai/content_filter_strategy.py), the composite score with
 * the upstream weights and 0.48 fixed threshold, chosen because those numbers are battle-tested against
 * years of real pages and there is no reason to re-learn them. The mechanics differ where our tree does:
 * upstream re-serializes every node to measure markup length (quadratic on deep trees); here one post-order
 * pass computes text length, approximate markup length and direct-link text per node, and the walk reads
 * the memo. The approximation only feeds a density ratio, so its absolute scale is irrelevant. */
import { attr, childElements, type Element, isElement, isText, remove, textOf } from "./dom.js";

// Never content, removed before scoring — upstream's excluded_tags plus the invisibles our parser keeps.
const EXCLUDED = new Set(["nav", "footer", "header", "aside", "script", "style", "form", "iframe", "noscript", "template", "svg", "canvas"]);

// A class or id that names page chrome. Upstream's negative_patterns, verbatim.
const NEGATIVE = /nav|footer|header|sidebar|ads|comment|promo|advert|social|share/i;

const TAG_WEIGHTS: Record<string, number> = {
    div: 0.5,
    p: 1.0,
    article: 1.5,
    section: 1.0,
    span: 0.3,
    li: 0.5,
    ul: 0.5,
    ol: 0.5,
    h1: 1.2,
    h2: 1.1,
    h3: 1.0,
    h4: 0.9,
    h5: 0.8,
    h6: 0.7,
};

const WEIGHTS = { textDensity: 0.4, linkDensity: 0.2, tagWeight: 0.2, classIdWeight: 0.1, textLength: 0.1 };

export interface PruneOptions {
    /** Composite-score floor an element must clear to survive. Upstream default. */
    readonly threshold?: number;
    /** Fewer words than this in a subtree is an automatic drop (off by default, like upstream). */
    readonly minWords?: number;
}

interface Mass {
    readonly textLen: number;
    readonly markupLen: number;
    readonly linkTextLen: number;
}

/** Prunes IN PLACE under `body`; returns the fraction of text mass removed (for the capsule's honesty line). */
export const pruneTree = (body: Element, options: PruneOptions = {}): number => {
    const threshold = options.threshold ?? 0.48;
    const before = textOf(body).length;
    stripExcluded(body);
    const masses = new Map<Element, Mass>();
    weigh(body, masses);
    for (const child of childElements(body)) {
        pruneNode(child, threshold, options.minWords, masses);
    }
    const after = textOf(body).length;
    return before === 0 ? 0 : (before - after) / before;
};

const stripExcluded = (el: Element): void => {
    for (const child of childElements(el)) {
        if (EXCLUDED.has(child.tagName)) {
            remove(child);
        } else {
            stripExcluded(child);
        }
    }
};

/* One post-order pass: every element's text mass, an approximation of its serialized length (tag names,
 * attributes, brackets), and the text sitting in its DIRECT <a> children — the three inputs of the score. */
const weigh = (el: Element, memo: Map<Element, Mass>): Mass => {
    let textLen = 0;
    let markupLen = 0;
    let linkTextLen = 0;
    for (const child of el.childNodes) {
        if (isText(child)) {
            const trimmed = child.value.trim();
            textLen += trimmed.length;
            markupLen += trimmed.length;
        } else if (isElement(child)) {
            const mass = weigh(child, memo);
            textLen += mass.textLen;
            markupLen += mass.markupLen;
            if (child.tagName === "a") {
                linkTextLen += textOf(child).length;
            }
        }
    }
    // <tag attrs></tag> overhead: 2 brackets + name, twice, plus each attribute's name="value".
    markupLen += 2 * (el.tagName.length + 2) + el.attrs.reduce((sum, a) => sum + a.name.length + a.value.length + 4, 0);
    const mass = { textLen, markupLen, linkTextLen };
    memo.set(el, mass);
    return mass;
};

const pruneNode = (el: Element, threshold: number, minWords: number | undefined, masses: Map<Element, Mass>): void => {
    if (compositeScore(el, minWords, masses) < threshold) {
        remove(el);
        return;
    }
    for (const child of childElements(el)) {
        pruneNode(child, threshold, minWords, masses);
    }
};

const compositeScore = (el: Element, minWords: number | undefined, masses: Map<Element, Mass>): number => {
    const mass = masses.get(el) ?? { textLen: 0, markupLen: 0, linkTextLen: 0 };
    if (minWords !== undefined && textOf(el).split(" ").filter(Boolean).length < minWords) {
        return -1;
    }
    const textDensity = mass.markupLen > 0 ? mass.textLen / mass.markupLen : 0;
    const linkDensity = 1 - (mass.textLen > 0 ? mass.linkTextLen / mass.textLen : 0);
    const tagWeight = TAG_WEIGHTS[el.tagName] ?? 0.5;
    const classId = attr(el, "class") ?? "";
    const id = attr(el, "id") ?? "";
    const classIdScore = (NEGATIVE.test(classId) ? -0.5 : 0) + (NEGATIVE.test(id) ? -0.5 : 0);
    const score =
        WEIGHTS.textDensity * textDensity +
        WEIGHTS.linkDensity * linkDensity +
        WEIGHTS.tagWeight * tagWeight +
        WEIGHTS.classIdWeight * Math.max(0, classIdScore) +
        WEIGHTS.textLength * Math.log(mass.textLen + 1);
    return score / (WEIGHTS.textDensity + WEIGHTS.linkDensity + WEIGHTS.tagWeight + WEIGHTS.classIdWeight + WEIGHTS.textLength);
};
