import { TOKEN_MAX_LENGTH } from "../../tokens.js";
import type { RestoreText } from "../shield-types.js";

// A streamed text can split a token anywhere: `⟦PER` in one delta, `SON_12⟧` in the next. Restoring each delta on its
// own would forward both halves untouched, so the end of each delta that could still grow into a token is held until
// the next one shows whether it does.

export interface Holdback {
    // Restored text that is safe to emit now: everything but a tail that may be the start of a token.
    readonly push: (text: string) => string;
    // Everything still held, restored: the text has ended, so no token can complete it.
    readonly flush: () => string;
}

// A tail that could still grow into a token in either spelling: `⟦`, `⟦PERS`, `⟦PERSON_1`, `[`, `[[`, `[[PERSON_12]`.
// Matching the token's grammar rather than holding from any open bracket keeps code like `items[0]` flowing.
const TOKEN_PREFIX = /^(?:⟦(?:[A-Z][A-Z_]*(?:_\d{1,7})?)?|\[(?:\[(?:[A-Z][A-Z_]*(?:_\d{1,7}\]?)?)?)?)$/u;

// Where the held tail starts: the earliest opener in reach whose tail is a token's prefix, else the text's end. A
// prefix is always shorter than a whole token, so nothing further back can matter.
const heldFrom = (text: string): number => {
    for (let start = Math.max(0, text.length - TOKEN_MAX_LENGTH + 1); start < text.length; start += 1) {
        const char = text.charAt(start);
        if ((char === "⟦" || char === "[") && TOKEN_PREFIX.test(text.slice(start))) {
            return start;
        }
    }
    return text.length;
};

export const createHoldback = (restore: RestoreText): Holdback => {
    let held = "";
    return {
        push: (text) => {
            const pending = held + text;
            const cut = heldFrom(pending);
            held = pending.slice(cut);
            return cut === 0 ? "" : restore(pending.slice(0, cut));
        },
        flush: () => {
            const rest = held;
            held = "";
            return rest === "" ? "" : restore(rest);
        },
    };
};
