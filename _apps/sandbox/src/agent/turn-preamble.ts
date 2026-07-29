import { SETUP_NOTICE_HEADER } from "../workspace/workspace-setup.js";
import { DELEGATION_NOTE_HEADER } from "./delegation.js";

// Turn preambles: notes the daemon prepends to a user message before it reaches the model — the delegation
// how-to (when stableSystemPrompt keeps it out of the system prompt), the dependency-readiness notice (which
// must ride the user message because it changes the moment an install finishes, while the system prefix stays
// byte-stable for the prompt cache), and the literal-slash note below. They are protocol, not something the
// user said — but the SDK transcript stores the combined prompt verbatim, so a reopened tab would redraw them
// as the user's own words: the "Dependencies are NOT installed" text stapled onto their message after every
// refresh or sandbox rebuild. Builder and stripper live together so restore recognizes exactly what a turn
// injected — including in transcripts written before this module existed, which used the same shape.

const SEPARATOR = "\n\n---\n\n";

/* The note a `/`-leading prompt earns when the name is no command this session has (agent-commands.ts owns
 * that call). Its job is positional before it is semantic: with anything ahead of it the user's text no longer
 * opens the message, so the CLI's slash parser never claims it and the words reach the model instead of being
 * answered with "Unknown command" and dropped. It says something true and useful while it is there — the model
 * would otherwise have to guess whether `/workspace` names a command, a route, or a path. */
export const LITERAL_SLASH_NOTE_HEADER = "## Reading the message below";

export const LITERAL_SLASH_NOTE =
    `${LITERAL_SLASH_NOTE_HEADER}\n\n` +
    "It opens with `/` but names no slash command available here — the leading token is the user's own words " +
    "(a route, a path, a filename). Read the whole message as ordinary prose.";

export const withTurnPreamble = (notes: readonly string[], prompt: string): string =>
    notes.length === 0 ? prompt : `${notes.join("\n\n")}${SEPARATOR}${prompt}`;

// The restore-side inverse. Anchored, not fuzzy: only a message that STARTS with a known injected note is
// touched, and only up to the FIRST separator — a user who typed `---` themselves keeps their text intact.
export const stripTurnPreamble = (text: string): string => {
    const injected = [DELEGATION_NOTE_HEADER, SETUP_NOTICE_HEADER, LITERAL_SLASH_NOTE_HEADER];
    if (!injected.some((header) => text.startsWith(header))) {
        return text;
    }
    const separator = text.indexOf(SEPARATOR);
    return separator === -1 ? text : text.slice(separator + SEPARATOR.length);
};
