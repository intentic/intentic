// The capsule-then-content shape these CLIs print: one line saying what happened, the caveats, then the content.
// An agent reads the first lines and stops, so what it needs to decide with must fit above the fold, and the cut
// must always name the file holding the whole thing.
import { estimateTokens } from "@intentic/base/format";

/** The line read first: `<tool>: <field> · <field> · …`, then one `note:` line per caveat the run has to admit. */
export const capsule = (name: string, fields: readonly string[], notes: readonly string[] = []): string =>
    `${name}: ${fields.join(" · ")}\n${notes.map((note) => `note: ${note}\n`).join("")}`;

/**
 * Markdown cut to a token budget on a line boundary, trailed by the count it cut at and the path that holds it
 * whole. Never a silent truncation: a body that stops mid-thought with no trailer reads as the whole answer.
 */
export const clip = (markdown: string, budgetTokens: number, path: string, noun: string): string => {
    const total = estimateTokens(markdown);
    if (total <= budgetTokens) {
        return markdown;
    }
    // estimateTokens is ~4 chars per token, so the budget's character count is the cut point.
    const cut = markdown.slice(0, budgetTokens * 4);
    const atLine = cut.slice(0, cut.lastIndexOf("\n") + 1);
    return `${atLine}\n[cut at ${budgetTokens} of ${total} tokens: Read ${path} for the whole ${noun}]\n`;
};
