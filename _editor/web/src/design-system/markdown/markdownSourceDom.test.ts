// @vitest-environment jsdom
// This module builds DOM, so it needs a document: jsdom rather than happy-dom, since happy-dom's parsing is not
// faithful enough to assert against. The module lives in `@intentic/ui/markdown` and is tested here beside the block
// splitter's suite.
import { describe, expect, test, vi } from "vitest";
import { useHighlighter } from "@intentic/ui/highlighter";
import { blockBody, buildBlockElement, caretAtOffset, offsetOfCaret } from "@intentic/ui/markdown";

// The invariant: the element's text is the block's source. Reading an edit back, turning a caret into an offset, and
// saving the file all rest on it, so it is asserted for every shape of block rather than spot-checked.
const BLOCKS = {
    heading: `## A heading`,
    deepHeading: `###### Six deep`,
    paragraph: `Just some prose.`,
    wrappedParagraph: `A paragraph whose source\nis wrapped over two lines.`,
    bold: `Some **bold** text.`,
    italic: `Some *italic* and _also italic_ text.`,
    code: `Use \`const x = 1\` inline.`,
    codeWithTicks: "A ``code `span` with ticks`` here.",
    strikethrough: `This is ~~gone~~ now.`,
    link: `See [the docs](https://example.com) for more.`,
    linkSameTextAsHref: `See [a](a) there.`,
    image: `An image ![alt text](picture.png) inline.`,
    escape: `A literal \\* star and \\_ underscore.`,
    inlineHtml: `Some <b>raw html</b> in prose.`,
    nested: `A **bold [link](https://x.dev) inside** it.`,
    bullets: `- first\n- second\n- third`,
    ordered: `1. one\n2. two`,
    nestedBullets: `- top\n    - nested\n    - also nested`,
    tasks: `- [ ] undone\n- [x] done`,
    boldBullets: `- **first** item\n- second \`item\``,
    blockquote: `> quoted words\n> more of them`,
    fence: "```ts\nconst x = 1;\n```",
    fenceWithoutLanguage: "```\nplain words\n```",
    // Every fence spends most of its life unclosed: it is typed one line at a time.
    fenceUnclosed: "```ts\nconst x = 1;",
    fenceHoldingBlankLines: "```ts\nconst x = 1;\n\nconst y = 2;\n```",
    fenceWithTildes: `~~~ts\nconst x = 1;\n~~~`,
    // The inner delimiters are code: only a run of four closes this one.
    fenceHoldingAFence: "````md\n```ts\nx\n```\n````",
    fenceHoldingNothing: "```json\n```",
    indentedCode: `    const x = 1;`,
    table: `| a | b |\n| - | - |\n| 1 | 2 |`,
    rule: `---`,
    htmlBlock: `<details>\n<summary>More</summary>\n</details>`,
    trailingSpaces: `A hard break  \nand the next line.`,
    emptyish: ` `,
    unicode: `Emoji 🎉 and accents é in **bold é**.`,
};

describe(`buildBlockElement keeps the source as its text`, () => {
    for (const [name, source] of Object.entries(BLOCKS)) {
        test(name, () => {
            expect(blockBody(buildBlockElement(source)), `the block must read back as its source for ${name}`).toBe(source);
        });
    }
});

describe(`what it draws`, () => {
    test(`a heading's hashes hang in the gutter, so revealing them cannot move the words`, () => {
        const element = buildBlockElement(`## A heading`);
        expect(element.tagName).toBe(`H2`);
        const marker = element.querySelector(`.md-marker`);
        expect(marker?.textContent).toBe(`## `);
        expect(marker?.classList.contains(`md-marker-gutter`)).toBe(true);
    });

    test(`emphasis keeps its markup AND its markers`, () => {
        const element = buildBlockElement(`Some **bold** text.`);
        const strong = element.querySelector(`strong`);
        // The word is still bold while you edit it; the asterisks are there too, as markers the CSS can hide.
        expect(strong?.textContent).toBe(`**bold**`);
        expect([...strong!.querySelectorAll(`.md-marker`)].map((node) => node.textContent)).toEqual([`**`, `**`]);
    });

    test(`a link is drawn as one, but inert: a click here places a caret`, () => {
        const element = buildBlockElement(`See [the docs](https://example.com) now.`);
        const anchor = element.querySelector(`a`);
        expect(anchor?.textContent).toBe(`[the docs](https://example.com)`);
        expect(anchor?.hasAttribute(`href`)).toBe(false);
    });

    test(`a list item's bullet hangs in the gutter where the rendered bullet was`, () => {
        const element = buildBlockElement(`- first\n- second`);
        expect(element.tagName).toBe(`UL`);
        const bullets = [...element.querySelectorAll(`li > .md-marker-gutter`)].map((node) => node.textContent);
        expect(bullets).toEqual([`- `, `- `]);
    });

    test(`a task item's brackets hang in the gutter with its bullet, where its checkbox is drawn`, () => {
        const done = buildBlockElement(`- [x] done`);
        // All of `- [x] ` is the line's opening markup, so all of it leaves the text and hangs in the margin: the
        // item's words sit at the same place whether the checkbox or the source is showing.
        expect(done.querySelector(`.md-marker-gutter`)?.textContent).toBe(`- [x] `);
        expect(done.querySelector(`li`)?.dataset[`task`]).toBe(`1`);
        expect(buildBlockElement(`- [ ] undone`).querySelector(`li`)?.dataset[`task`]).toBe(`0`);
        expect(blockBody(done)).toBe(`- [x] done`);
    });

    test(`a fenced block is drawn as the code it holds, its fences markers like any other markup`, () => {
        const element = buildBlockElement("```ts\nconst x = 1;\n```");
        expect(element.tagName).toBe(`PRE`);
        expect(element.classList.contains(`md-code-block`)).toBe(true);
        // The delimiters are markup the CSS hides, the way a heading's hashes are; what is left on screen is code.
        expect([...element.querySelectorAll(`.md-code-fence .md-marker`)].map((node) => node.textContent)).toEqual(["```ts", "```"]);
        expect([...element.querySelectorAll(`.md-code-line`)].map((node) => node.textContent)).toEqual([`const x = 1;`]);
        // Read by the stylesheet, which prints it where the rendered document prints its language.
        expect(element.dataset[`mdLang`]).toBe(`ts`);
    });

    test(`a fence still being typed has no closing delimiter to draw`, () => {
        const element = buildBlockElement("```ts\nconst x = 1;");
        expect([...element.querySelectorAll(`.md-code-fence .md-marker`)].map((node) => node.textContent)).toEqual(["```ts"]);
        expect([...element.querySelectorAll(`.md-code-line`)].map((node) => node.textContent)).toEqual([`const x = 1;`]);
    });

    test(`a fence inside a longer fence is code, not the end of the block`, () => {
        const element = buildBlockElement("````md\n```ts\nx\n```\n````");
        expect([...element.querySelectorAll(`.md-code-fence .md-marker`)].map((node) => node.textContent)).toEqual(["````md", "````"]);
        expect([...element.querySelectorAll(`.md-code-line`)].map((node) => node.textContent)).toEqual(["```ts", `x`, "```"]);
    });

    test(`a fence with no info string names no language`, () => {
        const element = buildBlockElement("```\nplain words\n```");
        expect(element.dataset[`mdLang`]).toBeUndefined();
    });

    test(`an indented code block has no fences to draw, so it stays its own source`, () => {
        const element = buildBlockElement(`    const x = 1;`);
        expect(element.className).toBe(`md-src-verbatim`);
        expect(blockBody(element)).toBe(`    const x = 1;`);
    });

    test(`a construct it does not model is shown verbatim rather than wrongly`, () => {
        const element = buildBlockElement(`| a | b |\n| - | - |`);
        expect(element.tagName).toBe(`PRE`);
        expect(blockBody(element)).toBe(`| a | b |\n| - | - |`);
    });

    test(`no empty marker spans, which would be markup that is not in the file`, () => {
        const element = buildBlockElement(`Plain words with no markup at all.`);
        expect(element.querySelectorAll(`.md-marker`)).toHaveLength(0);
    });
});

describe(`colour`, () => {
    const SOURCE = "```json\n{\n    \"name\": \"acme.incidents\"\n}\n```";

    // Real Shiki, because what is under test is whether its markup reassembles the source line for line; a stub
    // would only restate the shape this file already assumes. The grammar is loaded first so a cold import is not
    // charged to the wait, and both budgets below bound a hang rather than measure the highlight.
    test(
        `the body wears the highlighter's colours once they land, and still reads back as the file`,
        async () => {
            // Highlighting is async while building is not: the first draw of a block is always the plain one.
            expect(buildBlockElement(SOURCE).dataset[`mdColoured`]).toBeUndefined();
            await useHighlighter().ensureLang(`json`);
            await vi.waitFor(() => expect(buildBlockElement(SOURCE).dataset[`mdColoured`]).toBe(``), { timeout: 10_000, interval: 10 });

            const element = buildBlockElement(SOURCE);
            const lines = [...element.querySelectorAll(`.md-code-line`)];
            const code = [`{`, `    "name": "acme.incidents"`, `}`];
            expect(lines.map((line) => line.textContent)).toEqual(code);
            // Colour is spans inside the line, and every character of the line is inside one of them.
            expect(lines.map((line) => [...line.querySelectorAll(`span[style]`)].map((span) => span.textContent).join(``))).toEqual(code);
            expect(blockBody(element)).toBe(SOURCE);
        },
        30_000,
    );
});

describe(`caret offsets`, () => {
    // A caret position and a source offset are the same number, which removed the previous surface's guesswork about
    // where a click landed. Both directions are checked, against each other.
    test(`round-trip through every offset of a block with markup in it`, () => {
        const source = `A **bold** word and a [link](x.md).`;
        const element = buildBlockElement(source);
        for (let offset = 0; offset <= source.length; offset += 1) {
            const at = caretAtOffset(element, offset);
            expect(offsetOfCaret(element, at!.node, at!.offset), `offset ${offset} did not round-trip`).toBe(offset);
        }
    });

    test(`an offset past the end lands at the end rather than nowhere`, () => {
        const element = buildBlockElement(`short`);
        const at = caretAtOffset(element, 999);
        expect(offsetOfCaret(element, at!.node, at!.offset)).toBe(5);
    });

    test(`a caret reported on an element rather than in text still resolves`, () => {
        const element = buildBlockElement(`- one\n- two`);
        // What a browser reports for the boundary between two items.
        expect(offsetOfCaret(element, element, 1)).toBe(`- one\n`.length);
    });
});
