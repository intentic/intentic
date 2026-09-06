import { describe, expect, it, test } from "vitest";
import { blockAtOffset, type MarkdownBlock, offsetOfLine, splitMarkdownBlocks } from "@intentic/ui/markdown";

/* The block splitter behind the file viewer's pretty-editing surface. No DOM here: this is the lexer's view of
 * a document, not the renderer's, so the suite stays on the default `node` environment. */

// The document, reassembled from its blocks. Every assertion about correctness in this file is ultimately this
// one: what the surface splices back together has to be what it was handed.
const rejoin = (source: string, blocks: readonly MarkdownBlock[]): string => blocks.map((block) => source.slice(block.start, block.end)).join(``);

// Whether the spans TILE the document: they start at 0, end at the end, and each begins exactly where the last
// one stopped. A gap would be text an edit could drop; an overlap, text an edit could duplicate.
const tiles = (source: string, blocks: readonly MarkdownBlock[]): boolean =>
    blocks.length > 0 &&
    blocks[0]?.start === 0 &&
    blocks.at(-1)?.end === source.length &&
    blocks.every((block, index) => index === 0 || blocks[index - 1]?.end === block.start);

const DOCUMENTS = {
    headingAndProse: `# Title\n\nA paragraph.\n\nAnother one.\n`,
    everyConstruct: `# H\n\ntext\n\n- a\n- b\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n> quote\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n## H2\n`,
    referenceLinks: `Badges: [![ci][badge]][ci]\n\n# Title\n\nBody.\n\n[badge]: https://img.example/b.svg\n[ci]: https://ci.example/\n`,
    leadingBlankLines: `\n\n\n# After the gap\n\nBody.\n`,
    leadingDefinition: `[ref]: https://example.com\n\nUses [text][ref].\n`,
    noTrailingNewline: `# Title\n\nLast line with no newline`,
    windowsEndings: `# Title\r\n\r\nA paragraph.\r\n\r\nAnother.\r\n`,
    tabIndentedCode: `Intro\n\n\tindented code\n\tsecond line\n\nOutro\n`,
    nestedLists: `- top\n    - nested\n        - deeper\n\n1. one\n2. two\n`,
    looseList: `- first\n\n  second paragraph of the same item\n\n- another\n`,
    htmlBlock: `<details>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n\nAfter.\n`,
    frontMatterish: `---\ntitle: x\n---\n\n# Body\n`,
    fenceWithBlankLines: `Before.\n\n\`\`\`\n\nblank line inside the fence\n\n\`\`\`\n\nAfter.\n`,
    unclosedFence: `# Title\n\n\`\`\`ts\nconst x = 1;\n`,
    figureFence: `Intro.\n\n\`\`\`dag\n{ "kind": "dag", "nodes": [], "edges": [] }\n\`\`\`\n\nOutro.\n`,
    onlyWhitespace: `\n\n   \n`,
    singleParagraph: `just one paragraph`,
    consecutiveHeadings: `# One\n## Two\n### Three\n`,
    emphasisHeavy: `Some **bold**, _italic_ and \`code\` in one line.\n\n> A quote with **bold**.\n`,
};

/* THE INVARIANT, on every document above. A splitter that reports the wrong span corrupts a file the first time
 * somebody edits a paragraph, so this is checked against everything rather than spot-checked: the tiling holds,
 * and the pieces put the document back exactly. */
describe(`splitMarkdownBlocks tiles every document`, () => {
    for (const [name, source] of Object.entries(DOCUMENTS)) {
        it(name, () => {
            const { blocks } = splitMarkdownBlocks(source);
            expect(tiles(source, blocks), `blocks do not tile ${name}`).toBe(true);
            expect(rejoin(source, blocks)).toBe(source);
        });
    }
});

test(`a document with nothing in it has no blocks`, () => {
    expect(splitMarkdownBlocks(``)).toEqual({ blocks: [], defs: `` });
});

test(`a document of nothing but whitespace is still one editable block`, () => {
    const source = DOCUMENTS.onlyWhitespace;
    const { blocks } = splitMarkdownBlocks(source);
    expect(blocks).toEqual([{ start: 0, end: source.length }]);
});

test(`blank lines belong to the block above them, so a paragraph's span reaches the next one`, () => {
    const source = `# Title\n\nBody.\n`;
    const { blocks } = splitMarkdownBlocks(source);
    expect(blocks).toHaveLength(2);
    // The heading owns its own trailing blank line: deleting it is an edit to the heading's block, which is
    // where a writer would look for it.
    expect(source.slice(blocks[0]?.start, blocks[0]?.end)).toBe(`# Title\n\n`);
    expect(source.slice(blocks[1]?.start, blocks[1]?.end)).toBe(`Body.\n`);
});

test(`a document opening with blank lines hands them to the first block that renders`, () => {
    const source = DOCUMENTS.leadingBlankLines;
    const { blocks } = splitMarkdownBlocks(source);
    // Not a leading block of pure whitespace: that would be a span of the document with nothing on screen to
    // click, i.e. text the reader could never reach.
    expect(blocks[0]?.start).toBe(0);
    expect(source.slice(blocks[0]?.start, blocks[0]?.end)).toBe(`\n\n\n# After the gap\n\n`);
});

describe(`link reference definitions`, () => {
    test(`travel with the block above and are reported for re-parsing`, () => {
        const source = DOCUMENTS.referenceLinks;
        const { blocks, defs } = splitMarkdownBlocks(source);
        expect(defs).toContain(`[badge]: https://img.example/b.svg`);
        expect(defs).toContain(`[ci]: https://ci.example/`);
        // They render to nothing, so they are never a block of their own: the last block is the body paragraph
        // plus the definitions that follow it.
        expect(source.slice(blocks.at(-1)?.start, blocks.at(-1)?.end)).toBe(
            `Body.\n\n[badge]: https://img.example/b.svg\n[ci]: https://ci.example/\n`,
        );
    });

    test(`a definition before any prose joins the block that follows it`, () => {
        const source = DOCUMENTS.leadingDefinition;
        const { blocks, defs } = splitMarkdownBlocks(source);
        expect(defs).toBe(`[ref]: https://example.com`);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toEqual({ start: 0, end: source.length });
    });
});

test(`a fence's blank lines stay inside it rather than splitting it`, () => {
    const source = DOCUMENTS.fenceWithBlankLines;
    const { blocks } = splitMarkdownBlocks(source);
    const fence = blocks.map((block) => source.slice(block.start, block.end)).find((text) => text.startsWith(`\`\`\``));
    expect(fence).toContain(`blank line inside the fence`);
});

describe(`blockAtOffset`, () => {
    const source = `# Title\n\nBody.\n\nMore.\n`;
    const { blocks } = splitMarkdownBlocks(source);

    test(`finds the block a character belongs to`, () => {
        expect(blockAtOffset(blocks, 0)).toBe(0);
        expect(blockAtOffset(blocks, source.indexOf(`Body.`))).toBe(1);
        expect(blockAtOffset(blocks, source.indexOf(`More.`))).toBe(2);
    });

    test(`clamps past the end rather than reporting nothing`, () => {
        // The caret can sit at the very end of a document, which is one past its last character.
        expect(blockAtOffset(blocks, source.length)).toBe(blocks.length - 1);
        expect(blockAtOffset(blocks, 10_000)).toBe(blocks.length - 1);
    });

    test(`has no answer for a document with no blocks`, () => {
        expect(blockAtOffset([], 0)).toBe(-1);
    });
});

describe(`offsetOfLine`, () => {
    const source = `one\ntwo\nthree`;

    test(`counts from 1, like every line number the user is shown`, () => {
        expect(offsetOfLine(source, 1)).toBe(0);
        expect(offsetOfLine(source, 2)).toBe(4);
        expect(offsetOfLine(source, 3)).toBe(8);
    });

    test(`clamps to the last line rather than running off the end`, () => {
        expect(offsetOfLine(source, 99)).toBe(8);
        expect(offsetOfLine(``, 5)).toBe(0);
    });
});
