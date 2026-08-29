// @vitest-environment jsdom
//
// The renderer runs DOMPurify, which exposes no `sanitize` at all without a document. Same reasoning (and the
// same choice of jsdom over happy-dom) as renderMarkdown.test.ts.
import { describe, expect, test } from "vitest";
import type { ProsePart } from "@intentic/ui";
import { markdownParseCount, splitMarkdownBlocks } from "@intentic/ui/markdown";
import { blockText, caretOffsetInSource, createBlockRenderer, shiftOffset, spliceBlock, toggleTaskCheckbox } from "./markdownEditing";

const html = (parts: readonly ProsePart[]): string => parts.flatMap((part) => (part.kind === `html` ? [part.html] : [])).join(``);

const kinds = (parts: readonly ProsePart[]): string[] => parts.map((part) => part.kind);

describe(`spliceBlock`, () => {
    const source = `# Title\n\nBody.\n\nMore.\n`;
    const { blocks } = splitMarkdownBlocks(source);

    test(`replaces one block and leaves the rest of the document byte for byte`, () => {
        expect(spliceBlock(source, blocks[1] as never, `Edited body.`)).toBe(`# Title\n\nEdited body.\n\nMore.\n`);
    });

    test(`keeps the gap to the next block whatever the user's text ends with`, () => {
        // The editor never showed the blank line, so nothing the user typed can be a statement about it: the
        // document's own spacing is restored either way.
        expect(spliceBlock(source, blocks[1] as never, `Edited.`)).toBe(`# Title\n\nEdited.\n\nMore.\n`);
        expect(spliceBlock(source, blocks[1] as never, `Edited.\n\n\n`)).toBe(`# Title\n\nEdited.\n\nMore.\n`);
    });

    test(`a paragraph split in two becomes two blocks`, () => {
        const next = spliceBlock(source, blocks[1] as never, `First half.\n\nSecond half.`);
        expect(next).toBe(`# Title\n\nFirst half.\n\nSecond half.\n\nMore.\n`);
        expect(splitMarkdownBlocks(next).blocks).toHaveLength(4);
    });

    test(`emptying a block leaves the document parseable rather than gluing its neighbours together`, () => {
        expect(spliceBlock(source, blocks[1] as never, ``)).toBe(`# Title\n\n\n\nMore.\n`);
    });

    test(`the last block carries no gap to invent`, () => {
        const tail = `# Title\n\nno trailing newline`;
        const last = splitMarkdownBlocks(tail).blocks.at(-1) as never;
        expect(spliceBlock(tail, last, `edited`)).toBe(`# Title\n\nedited`);
    });
});

describe(`blockText`, () => {
    test(`hands the editor the block without the blank lines that separate it`, () => {
        const source = `# Title\n\nBody.\n\nMore.\n`;
        const { blocks } = splitMarkdownBlocks(source);
        expect(blockText(source, blocks[0] as never)).toBe(`# Title`);
        expect(blockText(source, blocks[1] as never)).toBe(`Body.`);
        expect(blockText(source, blocks[2] as never)).toBe(`More.`);
    });

    test(`keeps blank lines that are INSIDE a block, which are the block's own content`, () => {
        const source = "```\n\nblank inside\n\n```\n";
        const { blocks } = splitMarkdownBlocks(source);
        expect(blockText(source, blocks[0] as never)).toBe("```\n\nblank inside\n\n```");
    });
});

describe(`createBlockRenderer`, () => {
    const source = `# Title\n\nBody.\n\nMore.\n`;
    const { blocks, defs } = splitMarkdownBlocks(source);

    test(`draws every block when nothing is being edited`, () => {
        const renderer = createBlockRenderer(undefined);
        const parts = renderer.parts(source, blocks, defs, undefined);
        expect(kinds(parts)).toEqual([`html`, `html`, `html`]);
        expect(html(parts)).toContain(`<h1>Title</h1>`);
        expect(html(parts)).toContain(`<p>Body.</p>`);
    });

    test(`replaces the active block with a slot for the caller's editor, and draws nothing in its place`, () => {
        const renderer = createBlockRenderer(undefined);
        const parts = renderer.parts(source, blocks, defs, 1);
        expect(kinds(parts)).toEqual([`html`, `slot`, `html`]);
        // The block being edited is the editor's, not the renderer's: its prose must not also be on screen.
        expect(html(parts)).not.toContain(`Body.`);
    });

    /* THE REASON THIS IS PER BLOCK. Moving the caret from one paragraph to another may only cost the two blocks
     * whose state changed; a renderer that re-parsed the document around the hole would make every click on a
     * long file a full re-render, which is the source view's cost with none of its benefits. */
    test(`moving the caret re-parses only the blocks that changed`, () => {
        const renderer = createBlockRenderer(undefined);
        renderer.parts(source, blocks, defs, 1);
        const before = markdownParseCount();
        renderer.parts(source, blocks, defs, 2);
        // The paragraph that was being edited is drawn again; the one now being edited stops being drawn. Every
        // other block comes back from the cache.
        expect(markdownParseCount() - before).toBe(1);
    });

    test(`a link definition in another block still resolves`, () => {
        const withDefs = `Use [text][ref].\n\n[ref]: https://example.com\n`;
        const split = splitMarkdownBlocks(withDefs);
        const renderer = createBlockRenderer(undefined);
        const parts = renderer.parts(withDefs, split.blocks, split.defs, undefined);
        expect(html(parts)).toContain(`href="https://example.com"`);
        // ...and the definition itself renders to nothing, so the prelude adds no markup of its own.
        expect(html(parts)).not.toContain(`[ref]:`);
    });

    test(`a figure fence is still a figure when its block is rendered alone`, () => {
        const doc = `Intro.\n\n\`\`\`stats\n{ "kind": "stats", "items": [{ "label": "Files", "value": "3" }] }\n\`\`\`\n\nOutro.\n`;
        const split = splitMarkdownBlocks(doc);
        const renderer = createBlockRenderer(undefined);
        expect(kinds(renderer.parts(doc, split.blocks, split.defs, undefined))).toContain(`figure`);
    });

    test(`a document with nothing in it draws nothing`, () => {
        const renderer = createBlockRenderer(undefined);
        expect(renderer.parts(``, [], ``, undefined)).toEqual([]);
    });
});

describe(`caretOffsetInSource`, () => {
    test(`lands on the word that was clicked, not at the end of the paragraph`, () => {
        const block = `The **quick** brown fox jumps.`;
        // Rendered, this reads "The quick brown fox jumps."; the reader clicked just after "brown".
        expect(block.slice(0, caretOffsetInSource(`The quick brown`, block))).toBe(`The **quick** brown`);
    });

    test(`takes the occurrence that was clicked, not the first one that matches`, () => {
        const block = `set the value, then set the flag`;
        const first = caretOffsetInSource(`set`, block);
        const second = caretOffsetInSource(`set the value, then set`, block);
        expect(first).toBe(3);
        expect(second).toBe(block.lastIndexOf(`set`) + 3);
    });

    test(`matches across a source line break, which rendering collapsed into a space`, () => {
        const block = `a paragraph wrapped\nover two source lines`;
        expect(block.slice(0, caretOffsetInSource(`a paragraph wrapped over`, block))).toBe(`a paragraph wrapped\nover`);
    });

    test(`the start of the block is the start of its source`, () => {
        expect(caretOffsetInSource(``, `# Heading`)).toBe(0);
    });

    test(`falls back to the end when the click was on something with no source of its own`, () => {
        // A table's borders, a rendered checkbox: nothing whose text appears in the markdown.
        const block = `| a | b |\n| - | - |`;
        expect(caretOffsetInSource(`   nothing like this`, block)).toBe(block.length);
    });

    test(`regex metacharacters in the prose are matched literally`, () => {
        const block = `costs $5 (plus tax) [see below]`;
        expect(block.slice(0, caretOffsetInSource(`costs $5 (plus tax)`, block))).toBe(`costs $5 (plus tax)`);
    });
});

describe(`toggleTaskCheckbox`, () => {
    const plan = `# Plan\n\n- [ ] first\n- [x] second\n- [ ] third\n`;

    test(`ticks and unticks the box that was clicked`, () => {
        expect(toggleTaskCheckbox(plan, 0)).toBe(`# Plan\n\n- [x] first\n- [x] second\n- [ ] third\n`);
        expect(toggleTaskCheckbox(plan, 1)).toBe(`# Plan\n\n- [ ] first\n- [ ] second\n- [ ] third\n`);
        expect(toggleTaskCheckbox(plan, 2)).toBe(`# Plan\n\n- [ ] first\n- [x] second\n- [x] third\n`);
    });

    test(`counts nested and ordered task items, since the rendered list does too`, () => {
        const nested = `- [ ] top\n    - [ ] nested\n\n1. [ ] numbered\n`;
        expect(toggleTaskCheckbox(nested, 1)).toBe(`- [ ] top\n    - [x] nested\n\n1. [ ] numbered\n`);
        expect(toggleTaskCheckbox(nested, 2)).toBe(`- [ ] top\n    - [ ] nested\n\n1. [x] numbered\n`);
    });

    test(`leaves brackets that are prose alone`, () => {
        // Not a task item: no bullet in front of it, so the renderer draws no checkbox either.
        const prose = `An array literal like [ ] is not a checkbox.\n\n- [ ] but this is\n`;
        expect(toggleTaskCheckbox(prose, 0)).toBe(`An array literal like [ ] is not a checkbox.\n\n- [x] but this is\n`);
    });

    test(`says nothing rather than guessing when the box is not there`, () => {
        expect(toggleTaskCheckbox(plan, 9)).toBeUndefined();
        expect(toggleTaskCheckbox(plan, -1)).toBeUndefined();
    });
});

describe(`shiftOffset`, () => {
    const block = { start: 10, end: 20 };

    test(`leaves everything before the edited block where it was`, () => {
        expect(shiftOffset(block, 5, 0)).toBe(0);
        expect(shiftOffset(block, 5, 10)).toBe(10);
    });

    test(`moves everything after it by however much the edit grew or shrank the text`, () => {
        expect(shiftOffset(block, 5, 20)).toBe(25);
        expect(shiftOffset(block, -4, 30)).toBe(26);
    });
});
