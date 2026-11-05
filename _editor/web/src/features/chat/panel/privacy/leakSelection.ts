import { PRIVACY_LEAK_CONTEXT_REACH, PRIVACY_LEAK_VALUE_MAX } from "@intentic/sandbox-contract/schemas/privacy-leaks";

// WHAT A SELECTION IN THE TRANSCRIPT OFFERS TO REPORT AS A LEAK (LeakSelectionReport.vue): a value inside the words of one
// message, and the stretch of that message around it, which the daemon keeps with the leak so the owner can read it
// where it stood. A selection that crosses from one message into another, or reaches past the words into a card or a
// tool row, offers nothing: what it holds is not one value somebody sent.

// A message's own words as drawn (ChatMessageView.vue): a prompt's bubble, or a reply's markdown.
const MESSAGE_TEXT = `[data-message-text]`;

const VALUE_MIN = 2;

// The daemon keeps PRIVACY_LEAK_CONTEXT_REACH characters each side of the value; sent with room to spare for words it
// trims at, and never the whole of a long reply, which the route refuses past 20 000 characters.
const CONTEXT_SENT = PRIVACY_LEAK_CONTEXT_REACH * 4;

// The stretch of `text` around `value`, found where the selection put it (`near`), or its first occurrence when the
// drawn text and the selection disagree on where that is; undefined when it is not in the text at all.
export const leakContext = (text: string, value: string, near: number): string | undefined => {
    const at = near >= 0 && text.startsWith(value, near) ? near : text.indexOf(value);
    return at < 0 ? undefined : text.slice(Math.max(0, at - CONTEXT_SENT), at + value.length + CONTEXT_SENT);
};

export interface SelectedLeak {
    readonly value: string;
    readonly context: string | undefined;
    // Where it is drawn, in its window's client coordinates, for the press that offers to report it.
    readonly rect: DOMRect;
}

const wordsHolding = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement)?.closest(MESSAGE_TEXT) ?? null;

// The selection in `root`'s document as a leak to report, when it lies inside one message's words and holds a value of
// a length the route takes.
export const selectedLeak = (root: HTMLElement): SelectedLeak | undefined => {
    const doc = root.ownerDocument;
    const selection = doc.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
        return undefined;
    }
    const range = selection.getRangeAt(0);
    const words = wordsHolding(range.startContainer);
    if (words === null || words !== wordsHolding(range.endContainer) || !root.contains(words)) {
        return undefined;
    }
    const raw = range.toString();
    const value = raw.trim();
    if (value.length < VALUE_MIN || value.length > PRIVACY_LEAK_VALUE_MAX) {
        return undefined;
    }
    // Counted as textContent counts, which is what the context is cut from.
    const before = doc.createRange();
    before.setStart(words, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const near = before.toString().length + (raw.length - raw.trimStart().length);
    return { value, context: leakContext(words.textContent ?? ``, value, near), rect: range.getBoundingClientRect() };
};
