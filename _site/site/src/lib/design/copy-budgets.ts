// THE WORD BUDGETS every kit component holds its visible copy to (DESIGN.md, "Words").
//
// The site shows; it does not explain on the surface. A slot that runs over its budget is not a layout problem to be
// solved with a smaller font: the rest of what it wanted to say belongs in a Tip, which the reader opens by pointing
// at the thing (or tapping it on a phone), the way the app's hover cards work. So the budget is enforced where the
// words are rendered: a kit component passes each string through `held`, and a string over budget fails the page's
// render — in `astro dev` as the error overlay, in `astro build` as a failed build — naming the slot, the count and
// the way out. Nothing downstream has to remember the rule.
//
// Counted in words, not characters, for the same reason the app's tooltip check is (_tools/checks/tooltip-words.mjs):
// a reader skims words, and a long word is not the problem a long sentence is.

/** Each slot of visible copy, its ceiling, and what it is for. `aim` is what a good one usually comes in at. */
export const COPY_BUDGETS = {
    /** The spaced capitals over a heading: names the band's subject, never a sentence. */
    eyebrow: { max: 3, aim: 2 },
    /** A band's heading or an inner page's h1: the claim, at most two lines at display size. */
    heading: { max: 10, aim: 7 },
    /** The one sentence under a heading. A second sentence is a Tip. */
    lede: { max: 20, aim: 14 },
    /** A tile's, a node's or a step's name. */
    title: { max: 4, aim: 3 },
    /** The one line under a title. */
    line: { max: 12, aim: 8 },
    /** A stat's label, a chip, a node's mono sub-label. */
    label: { max: 4, aim: 2 },
    /** What a button or a link says: a verb first. */
    action: { max: 4, aim: 2 },
    /** The line under an exhibit, a figure's caption. */
    caption: { max: 14, aim: 10 },
    /** A Tip's heading. The app's tooltip title holds to the same three. */
    tipTitle: { max: 3, aim: 2 },
    /** A Tip's body: the detail the surface left out, two short sentences at most. */
    tipBody: { max: 40, aim: 25 },
    /** One label of a Tip's label/value rows. */
    tipRow: { max: 2, aim: 1 },
} as const satisfies Record<string, { max: number; aim: number }>;

export type CopySlot = keyof typeof COPY_BUDGETS;

/** A word is a run between spaces that has a letter or a digit in it, so "—", "·" and "→" count for nothing. */
export const countWords = (text: string): number =>
    text
        .trim()
        .split(/\s+/u)
        .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;

/** The string over budget, the slot it was for, and where it was used. */
export class CopyBudgetError extends Error {
    readonly slot: CopySlot;
    readonly words: number;

    constructor(slot: CopySlot, words: number, text: string, where: string) {
        const { max } = COPY_BUDGETS[slot];
        const quoted = text.length > 90 ? `${text.slice(0, 87)}...` : text;
        super(
            `${where}: the ${slot} "${quoted}" is ${words} words, and a ${slot} holds ${max}. ` +
                `Cut it to what the reader needs at a glance, and move the rest into a Tip (DESIGN.md, "Words").`,
        );
        this.name = "CopyBudgetError";
        this.slot = slot;
        this.words = words;
    }
}

/** Returns `text` unchanged when it fits its slot; throws `CopyBudgetError` when it does not. */
export const held = <Text extends string | undefined>(slot: CopySlot, text: Text, where: string): Text => {
    if (text === undefined) {
        return text;
    }
    const words = countWords(text);
    if (words > COPY_BUDGETS[slot].max) {
        throw new CopyBudgetError(slot, words, text, where);
    }
    return text;
};
