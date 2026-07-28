import { SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { DELEGATION_NOTE_HEADER } from "./delegation.js";

// Turn preambles: notes the daemon prepends to a user message before it reaches the model — the delegation
// how-to (when stableSystemPrompt keeps it out of the system prompt) and the dependency-readiness notice
// (which must ride the user message because it changes the moment an install finishes, while the system
// prefix stays byte-stable for the prompt cache). They are protocol, not something the user said — but the
// SDK transcript stores the combined prompt verbatim, so a reopened tab would redraw them as the user's own
// words: the "Dependencies are NOT installed" text stapled onto their message after every refresh or sandbox
// rebuild. Builder and stripper live together so restore recognizes exactly what a turn injected — including
// in transcripts written before this module existed, which used the same shape.

const SEPARATOR = "\n\n---\n\n";

export const withTurnPreamble = (notes: readonly string[], prompt: string): string =>
    notes.length === 0 ? prompt : `${notes.join("\n\n")}${SEPARATOR}${prompt}`;

// The restore-side inverse. Anchored, not fuzzy: only a message that STARTS with a known injected note is
// touched, and only up to the FIRST separator — a user who typed `---` themselves keeps their text intact.
export const stripTurnPreamble = (text: string): string => {
    if (!text.startsWith(DELEGATION_NOTE_HEADER) && !text.startsWith(SETUP_NOTICE_HEADER)) {
        return text;
    }
    const separator = text.indexOf(SEPARATOR);
    return separator === -1 ? text : text.slice(separator + SEPARATOR.length);
};
