import { describe, expect, it, test } from "vitest";
import { createStreamingMarkdown, renderMarkdown, settledEnd } from "./renderMarkdown";

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

describe(`streaming split`, () => {
    const settledOf = (text: string): string => text.slice(0, settledEnd(text, 0));

    it(`settles a completed paragraph only once the next block has arrived`, () => {
        expect(settledOf(`Hello there.\n\n`)).toBe(``);
        expect(settledOf(`Hello there.\n\nNext`)).toBe(`Hello there.\n\n`);
    });

    it(`treats a blank line inside an OPEN fence as content, not a boundary`, () => {
        const text = "Intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
        expect(settledOf(text)).toBe("Intro\n\n");
    });

    it(`settles past a closed fence`, () => {
        const text = "```ts\nconst a = 1;\n```\n\nAfter";
        expect(settledOf(text)).toBe("```ts\nconst a = 1;\n```\n\n");
    });

    it(`refuses to split two list blocks — an ordered list would restart at 1`, () => {
        expect(settledOf(`1. first\n\n2. second\n\n3. third`)).toBe(``);
    });

    it(`still settles a paragraph that is followed by a list`, () => {
        expect(settledOf(`Steps:\n\n- one\n`)).toBe(`Steps:\n\n`);
    });

    it(`refuses to split before an indented continuation line`, () => {
        expect(settledOf(`- item\n\n    continued body\n`)).toBe(``);
    });

    it(`renders the settled part byte-identically across frames and only grows the tail`, () => {
        const stream = createStreamingMarkdown();
        const first = stream.render(`Done paragraph.\n\nStill wri`);
        const second = stream.render(`Done paragraph.\n\nStill writing here`);
        expect(first.settled).toBe(second.settled);
        expect(first.settled).toContain(`Done paragraph.`);
        expect(second.tail).toContain(`Still writing here`);
        expect(second.tail).not.toContain(`Done paragraph.`);
    });

    it(`concatenates to the same visible text as a whole-message render`, () => {
        const text = `# Title\n\nSome prose with \`code\`.\n\n- a\n- b\n\nTail sentence.`;
        const stream = createStreamingMarkdown();
        const { settled, tail } = stream.render(text);
        const strip = (html: string): string => html.replace(/<[^>]*>/g, ``).replace(/\s+/g, ` `).trim();
        expect(strip(settled + tail)).toBe(strip(renderMarkdown(text)));
    });

    it(`starts over when the source is rewritten rather than appended`, () => {
        const stream = createStreamingMarkdown();
        stream.render(`First version.\n\nMore text`);
        const rewritten = stream.render(`Different entirely.\n\nOther`);
        expect(rewritten.settled).toContain(`Different entirely.`);
        expect(rewritten.settled).not.toContain(`First version.`);
    });
});
