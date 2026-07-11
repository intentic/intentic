import { expect, test } from "vitest";
import { renderMarkdown } from "./renderMarkdown";

// The one invariant that keeps a streamed chat bubble alive: renderMarkdown must NEVER throw and must always
// return a string, whatever it's handed — the assistant bubble re-runs it on every partial-markdown delta, so a
// single throw would blank the turn (the reported "undefined is not an object" crash class).
const INPUTS: unknown[] = [
    ``,
    `plain text`,
    `| A | St`, // mid table header
    `\`\`\`ts\nconst x =`, // unclosed code fence
    `- one\n- tw`, // mid list item
    `> quote\n\n# H\n\n[link](http://x.ai)`,
    `<div>raw <span>html`,
    `a`.repeat(50_000),
    undefined,
    null,
    123,
    { not: `a string` },
];

test("renderMarkdown never throws and always returns a string for any input", () => {
    for (const input of INPUTS) {
        // @ts-expect-error — deliberately exercising non-string inputs that could slip in mid-stream.
        const output = renderMarkdown(input);
        expect(typeof output).toBe(`string`);
    }
});
