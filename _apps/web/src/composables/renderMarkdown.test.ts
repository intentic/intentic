// @vitest-environment jsdom
//
// DOMPurify needs a real document: without one it exposes no `sanitize` at all, so under the suite's default
// `node` environment every render here threw into renderMarkdown's crash fallback and the assertions below
// were really checking escaped raw markdown. jsdom rather than happy-dom because DOMPurify misbehaves badly
// on the latter — it strips every tag and keeps <script> CONTENT, which would make these tests worse than
// useless. This is the only file that needs a document; the rest of the suite stays on `node`.
import { describe, expect, it, test } from "vitest";
import { createStreamingMarkdown, markdownParseCount, renderMarkdown, settledEnd } from "./renderMarkdown";

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

/* The placeholder the code renderer emits and the pattern that substitutes it are two halves of one seam, in
 * two different modules, joined across a round-trip through the sanitizer's DOM — these pin all three
 * together. Highlighting itself never resolves here (the design-system barrel can't load in a test), which is
 * exactly the fallback state these assert. */
describe(`code blocks`, () => {
    it(`substitutes a fenced block for the code-block markup, with its language label`, () => {
        const html = renderMarkdown("```ts\nconst a = 1;\n```");
        expect(html).toContain(`class="ui-code md-code"`);
        expect(html).toContain(`>ts</span>`);
        expect(html).toContain(`md-code-copy`);
        expect(html).not.toContain(`data-md-code`);
    });

    it(`renders the code inertly while highlighting is unavailable`, () => {
        const html = renderMarkdown("```html\n<script>alert(1)</script>\n```");
        expect(html).toContain(`&lt;script&gt;`);
        expect(html).not.toContain(`<script>`);
    });

    it(`handles a fence with no language`, () => {
        const html = renderMarkdown("```\nplain\n```");
        expect(html).toContain(`md-code`);
        expect(html).toContain(`plain`);
    });

    it(`keeps blocks distinct when a message has several`, () => {
        const html = renderMarkdown("```ts\nfirst();\n```\n\n```py\nsecond()\n```");
        expect(html).toContain(`first();`);
        expect(html).toContain(`second()`);
        expect(html).not.toContain(`data-md-code`);
    });
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

    /* The reason the split exists. Streaming a message one character at a time, the settled prefix must be
     * re-parsed once per COMPLETED BLOCK, never once per frame — otherwise the cost of a turn is quadratic in
     * its own length. Only the short tail may be re-parsed every frame.
     *
     * Asserted as an exact count rather than a bound: if the prefix memo is ever dropped, this jumps from
     * frames + 3 to frames * 2 and fails loudly instead of quietly getting slower. */
    it(`re-parses the settled prefix once per completed block, not once per frame`, () => {
        const text = `Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n\nDelta tail`;
        const stream = createStreamingMarkdown();
        const before = markdownParseCount();
        for (let end = 1; end <= text.length; end += 1) {
            stream.render(text.slice(0, end));
        }
        // Three boundaries settle (each confirmed by the first character of the block after it), and every
        // frame parses the tail.
        expect(markdownParseCount() - before).toBe(text.length + 3);
    });

    it(`starts over when the source is rewritten rather than appended`, () => {
        const stream = createStreamingMarkdown();
        stream.render(`First version.\n\nMore text`);
        const rewritten = stream.render(`Different entirely.\n\nOther`);
        expect(rewritten.settled).toContain(`Different entirely.`);
        expect(rewritten.settled).not.toContain(`First version.`);
    });
});
