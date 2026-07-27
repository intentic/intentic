/* HOW A CONVERSATION NAMES ITSELF from its opening prompt — the title a chat tab, a fleet card and the agent
 * detail header wear from the first keystroke of a turn until something better arrives.
 *
 * The naive rule (collapse whitespace, cut at N) reads the prompt as if it were a headline, and opening
 * prompts are not headlines. They are pasted stack traces, links dropped in with two words of context,
 * politeness that eats half the budget before the ask begins, and multi-line asks whose first line is throat-
 * clearing. Cutting those at 40 characters yields `Error: ENOENT: no such file or directo…` — a title that
 * names the paste rather than the work, and that reads identically for every one of the day's five pastes.
 *
 * So the prompt is read as prose FIRST and cut second: quoted material and fenced code are not the ask, the
 * opener is not the ask, and a reference is worth only its last segment. What survives is the earliest line
 * that still says something, cut on a sentence or a word rather than mid-syllable.
 *
 * Both sides derive: the browser names a conversation the instant it sends (conversation.ts), and the daemon
 * names a turn that arrived without one — an automation, a Discord message, a webchat visitor (agents-
 * registry.ts). One rule, because two would let the same prompt open under two different names depending on
 * where it entered. Nothing here calls a model: the title has to exist before the first frame comes back. */

// The header-sized budget. Every surface truncates in CSS anyway, so this is about how much SIGNAL a glance
// gets, not about fitting a box — past roughly this length a tab strip shows the same prefix for every tab.
const MAX_LENGTH = 40;
// Below this a sentence-shaped cut is more likely an abbreviation (`e.g.`, `i.e.`) than a sentence, so the
// length clamp takes over.
const MIN_SENTENCE = 12;
// A word-boundary cut this far back strands a fragment; better to cut mid-word than to title a conversation
// with two characters and an ellipsis.
const MIN_WORD_CUT = MAX_LENGTH * 0.6;

// Markdown's two fence syntaxes, and the quote marker. Both open and close on the same shape, so a fence line
// toggles rather than matching a pair — an UNTERMINATED fence (a paste the user never closed) then swallows
// the rest of the prompt, which is what it visually does too.
const FENCE = /^\s*(?:```|~~~)/;
const QUOTE = /^\s*>/;

// The ways an ask opens without starting. Stripped repeatedly, so `Hey, can you please …` unwinds one layer
// per pass; a line that unwinds to nothing was pure throat-clearing and the next line carries the ask.
const OPENERS: readonly RegExp[] = [
    /^(?:hey|hi|hello|yo|ok|okay|so|well|also|btw)\b[\s,.:;!—–-]*/i,
    /^(?:please|pls)\b[\s,.:;!—–-]*/i,
    /^(?:can|could|would|will)\s+(?:you|u|we)\b\s*(?:please|pls)?[\s,.:;!—–-]*/i,
    /^i(?:'d|\s+would)?\s+(?:want|need|like)\s+(?:you\s+)?to\b[\s,.:;!—–-]*/i,
    /^(?:let'?s|lets)\b[\s,.:;!—–-]*/i,
    /^we\s+(?:need|have|ought)\s+to\b[\s,.:;!—–-]*/i,
    /^(?:quick\s+(?:one|question|q)|one\s+more\s+thing)\b[\s,.:;!—–-]*/i,
];

// A sentence ends on terminal punctuation that is actually followed by a break — which is what holds `v1.2`
// and `foo.ts` together while still ending `Why is it red?`.
const SENTENCE_END = /[.!?](?=\s|$)/;

const collapse = (text: string): string =>
    text
        .replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replaceAll(/\s+/g, " ")
        .trim();

// The prompt minus everything the user pasted rather than wrote. Fenced blocks and quoted blocks are evidence
// attached to the ask, never the ask itself.
const proseLines = (prompt: string): string[] => {
    const lines: string[] = [];
    let fenced = false;
    for (const line of prompt.split(/\r?\n/)) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (!fenced && !QUOTE.test(line)) {
            lines.push(line);
        }
    }
    return lines;
};

/* Peel the openers off a line, but only keep the peeling when something with shape is left underneath.
 *
 * Three outcomes, and the difference between them is the whole point. A remnant of SEVERAL words is the ask —
 * `Can you please fix the auth tests?` was carrying `fix the auth tests?`. A remnant of NOTHING was pure
 * greeting (`Hey, quick one —`), and returning empty is how the caller learns to read the next line instead.
 * A remnant of ONE word means the opener was load-bearing — `Hi there` is not a conversation about `there`,
 * and `So what?` is not one about `what?` — so the line stands as written. */
const withoutOpener = (line: string): string => {
    let text = line;
    for (let pass = 0; pass < OPENERS.length; pass++) {
        const stripped = OPENERS.reduce((current, opener) => current.replace(opener, ""), text);
        if (stripped === text) {
            break;
        }
        text = stripped;
    }
    const remnant = text.trim();
    if (text === line || remnant === "") {
        return text;
    }
    return remnant.includes(" ") ? text : line;
};

// A URL is worth its last meaningful segment: the host when there is no path, and the segment before a purely
// numeric one so an issue link reads `merge_requests/42` rather than `42`.
const shortUrl = (token: string): string => {
    let url: URL;
    try {
        url = new URL(token);
    } catch {
        return token;
    }
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    const last = segments.at(-1);
    if (last === undefined) {
        return url.hostname.replace(/^www\./, "");
    }
    const previous = segments.at(-2);
    return /^\d+$/.test(last) && previous !== undefined ? `${previous}/${last}` : last;
};

// A path is worth its basename once it is deep enough that the lead is scaffolding — `src/foo.ts` already
// reads as a place, `_apps/web/src/composables/chat/conversation.ts` reads as a wall.
const shortPath = (token: string): string => {
    const segments = token.replace(/^@/, "").split("/");
    return segments.length > 2 ? (segments.findLast((segment) => segment !== "") ?? token) : token;
};

// Trailing punctuation belongs to the sentence, not to the reference inside it, so it is set aside across the
// shortening and put back — `see _apps/web/src/foo.ts,` collapses to `see foo.ts,`.
const shortReference = (token: string): string => {
    const match = /^(.*?)([\s,.;:!?)\]]*)$/s.exec(token);
    const core = match?.[1] ?? token;
    const tail = match?.[2] ?? "";
    if (/^https?:\/\//i.test(core)) {
        return `${shortUrl(core)}${tail}`;
    }
    if (core.includes("/")) {
        return `${shortPath(core)}${tail}`;
    }
    return token;
};

const collapseReferences = (text: string): string => text.split(" ").map(shortReference).join(" ");

const firstSentence = (text: string): string => {
    const end = text.search(SENTENCE_END);
    if (end < MIN_SENTENCE) {
        return text;
    }
    // A question mark or a bang carries tone worth keeping; a full stop on a title is just noise.
    const terminator = text[end];
    return terminator === "." ? text.slice(0, end) : text.slice(0, end + 1);
};

const clamped = (text: string): string => {
    if (text.length <= MAX_LENGTH) {
        return text;
    }
    const cut = text.slice(0, MAX_LENGTH);
    const boundary = cut.lastIndexOf(" ");
    const kept = boundary >= MIN_WORD_CUT ? cut.slice(0, boundary) : cut;
    return `${kept.replace(/[\s,;:—–-]+$/, "")}…`;
};

// Sentence case, but only when the opening word is plainly lowercase prose. An identifier (`useAgents`), a
// path (`src/foo`) or an abbreviation (`e.g`) means something by its casing and is left alone.
const capitalized = (text: string): string => {
    const [first = ""] = text.split(" ", 1);
    if (!/^[a-z]/.test(first) || /[A-Z/.\\]/.test(first)) {
        return text;
    }
    return `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
};

/* Split a plan's markdown into its leading heading and the remaining body.
 *
 * The heading is the one place in a turn where an agent writes a name for the WHOLE job rather than for a step
 * — a task checklist describes `Read the failing test`, `Fix the assertion`, `Run the suite`, none of which is
 * what the conversation is about, whereas a plan opens `## Fix the flaky auth tests`. That makes it the only
 * authored line in the stream worth promoting to a title, which is why this lives here rather than next to the
 * plan card that also renders it: the browser titles its own tabs from it and the daemon titles fleet cards. */
export const planParts = (text: string): { title?: string; body: string } => {
    const match = /^\s*#{1,6}\s+(.+)/.exec(text);
    if (match === null) {
        return { body: text };
    }
    return { title: match[1]!.trim(), body: text.slice(match.index + match[0].length).trimStart() };
};

/* Name a conversation after the prompt that opened it. Never empty for a non-empty prompt: a paste with no
 * prose around it still titles as its own first line, which at least names what was pasted. */
export const deriveTitle = (prompt: string): string => {
    const prose = proseLines(prompt)
        .map(collapse)
        .filter((line) => line !== "");
    for (const line of prose) {
        const opened = withoutOpener(line);
        // A line that unwound to nothing (or to punctuation) was the greeting; the ask is on the next one.
        if (/\p{L}/u.test(opened)) {
            return capitalized(clamped(firstSentence(collapseReferences(opened))));
        }
    }
    // Everything the user sent was code, a quote, or a greeting — title it as what it is rather than blank.
    const fallback = prose[0] ?? collapse(prompt.replaceAll(/^\s*(?:```|~~~).*$/gm, ""));
    return clamped(collapseReferences(fallback === "" ? collapse(prompt) : fallback));
};
