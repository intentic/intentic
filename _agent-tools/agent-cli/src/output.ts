// The capsule-then-content shape these CLIs print: one line saying what happened, the caveats, then the content.
// An agent reads the first lines and stops, so what it needs to decide with must fit above the fold, and the cut
// must always say where the rest is and which line to pick it up from.
import { charsOfTokens, estimateTokens, sliceToTokens } from "@intentic/base/format";

/** The line read first: `<tool>: <field> · <field> · …`, then one `note:` line per caveat the run has to admit. */
export const capsule = (name: string, fields: readonly string[], notes: readonly string[] = []): string =>
    `${name}: ${fields.join(" · ")}\n${notes.map((note) => `note: ${note}\n`).join("")}`;

/**
 * Where the whole answer is, for the cut's continuation: a saved file whose line `firstLine` (1-based, below any front
 * matter) is the clipped markdown's first line, or a command that prints the markdown whole from its first line.
 */
export type Whole = { readonly file: string; readonly firstLine: number } | { readonly command: string };

// How far back from the budget's edge a cut inside a line looks for a space to stop on, so it ends between words.
const SPACE_REACH = 200;

const newlines = (text: string): number => {
    let count = 0;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
        count += 1;
    }
    return count;
};

// Lines as Read numbers them: a last line without its newline still counts.
const lineCount = (text: string): number => (text === "" ? 0 : newlines(text) + (text.endsWith("\n") ? 0 : 1));

// The longest prefix the estimate puts within the budget when not even the first piece fits (one long base64 word):
// searched by halves over the characters the budget could hold, never splitting a surrogate pair.
const prefixWithin = (text: string, budgetTokens: number): string => {
    let low = 0;
    let high = Math.min(text.length, charsOfTokens(budgetTokens));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimateTokens(text.slice(0, middle)) <= budgetTokens) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    const code = text.charCodeAt(low - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? low - 1 : low);
};

// A cut inside a line, moved back to the last space near it when the budget's edge falls inside a word.
const onSpace = (text: string, cut: string): string => {
    if (/\s/.test(text.charAt(cut.length))) {
        return cut;
    }
    const space = cut.search(/\s\S*$/);
    return space > 0 && cut.length - space <= SPACE_REACH ? cut.slice(0, space) : cut;
};

// What of `markdown` fits `budgetTokens`: whole lines when they hold most of what fits, else a cut inside the line the
// budget ends in. A line boundary far back (a title above one long paragraph) would spend the budget on the title, and
// none at all would print nothing, which reads as an empty answer.
const keptWithin = (markdown: string, budgetTokens: number): string => {
    // Cut by the same estimate that counted it, so the budget's tokens are what was kept.
    const cut = sliceToTokens(markdown, budgetTokens);
    const lineEnd = cut.lastIndexOf("\n") + 1;
    if (lineEnd > 0 && lineEnd * 2 >= cut.length) {
        return cut.slice(0, lineEnd);
    }
    return onSpace(markdown, cut === "" ? prefixWithin(markdown, budgetTokens) : cut);
};

const grouped = (count: number): string => count.toLocaleString("en-US");

// `[cut at line 212 of 1480, ~19,100 of 23,100 tokens left: continue with Read <file> from line 212, or raise --budget]`.
// Line numbers are the saved file's, front matter included, so the one named is the one Read shows the rest at.
const trailer = (markdown: string, kept: string, total: number, whole: Whole): string => {
    const first = "file" in whole ? whole.firstLine : 1;
    const resume = first + newlines(kept);
    const last = first - 1 + lineCount(markdown);
    const left = estimateTokens(markdown.slice(kept.length));
    const into = kept.length - kept.lastIndexOf("\n") - 1;
    const where = into > 0 ? `cut ${grouped(into)} characters into line ${resume} of ${last}` : `cut at line ${resume} of ${last}`;
    const next = "file" in whole ? `Read ${whole.file} from line ${resume}` : `\`${whole.command} | tail -n +${resume}\``;
    return `[${where}, ~${grouped(left)} of ${grouped(total)} tokens left: continue with ${next}, or raise --budget]`;
};

/**
 * Markdown cut to a token budget, trailed by the line the rest starts on, how much is left, and where to read it. Never
 * a silent truncation (a body that stops mid-thought with no trailer reads as the whole answer), and never an empty
 * body for a budget of a token or more: a line too long to fit is cut inside, between words where one is near.
 */
export const clip = (markdown: string, budgetTokens: number, whole: Whole): string => {
    const total = estimateTokens(markdown);
    if (total <= budgetTokens) {
        return markdown;
    }
    const kept = keptWithin(markdown, budgetTokens);
    const gap = kept === "" || kept.endsWith("\n") ? "" : "\n";
    return `${kept}${gap}\n${trailer(markdown, kept, total, whole)}\n`;
};
