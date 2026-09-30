// A release note as the update card lists it. Notes are written as one sentence that often carries two things: the
// change, and after a semicolon what it replaces or where the old thing went ("Approve a plan from the bar above the
// composer; those buttons no longer appear on the plan card"). Drawn as one run of text, a list of six of them is a
// wall; drawn as the change with its aftermath a shade back under it, it is a list someone can scan.

export interface NoteLines {
    /** The change itself, without the full stop that would end it mid-list. */
    readonly head: string;
    /** What it replaces or where the old thing went, as a sentence of its own; absent when the note is one thought. */
    readonly detail: string | undefined;
}

// Either side shorter than this is not a clause of its own but a list or an abbreviation that happens to hold a
// semicolon ("fix: a; b"), and splitting there would strand a fragment on a line by itself.
const MIN_CLAUSE = 12;

// A detail begins mid-sentence, so its first word is lowercased; capitalised only when that word is all lower-case
// letters, so a name with a capital inside it (macOS) or one in code quotes (`ic`) keeps its spelling.
const sentenceCase = (clause: string): string => (/^[a-z]+(?=[\s,.:;]|$)/.test(clause) ? `${clause.charAt(0).toUpperCase()}${clause.slice(1)}` : clause);

const withoutStop = (text: string): string => (text.endsWith(`.`) && !text.endsWith(`..`) ? text.slice(0, -1) : text);

export const noteLines = (note: string): NoteLines => {
    const text = note.trim();
    const cut = text.indexOf(`; `);
    const rest = cut === -1 ? `` : text.slice(cut + 2).trim();
    if (cut < MIN_CLAUSE || rest.length < MIN_CLAUSE) {
        return { head: withoutStop(text), detail: undefined };
    }
    return { head: text.slice(0, cut), detail: sentenceCase(rest) };
};
