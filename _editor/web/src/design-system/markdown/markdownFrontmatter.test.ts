import { describe, expect, it, test } from "vitest";
import { frontmatterHtml, splitFrontmatter, splitMarkdownBlocks } from "@intentic/ui/markdown";

// The metadata block a document may open with. No DOM here: this is the parser and the markup it builds, not the
// sanitized render, so the suite stays on the default `node` environment.

const POST = `---\ntitle: "One worktree per agent"\ndescription: "A git worktree each is the boundary that fixes it."\ndate: 2026-09-04\ntags: ["engineering"]\n---\n\nThe first thing that breaks is the working tree.\n`;

describe(`splitFrontmatter`, () => {
    it(`takes the block and leaves the document after it`, () => {
        const split = splitFrontmatter(POST);
        expect(split?.rest).toBe(`\nThe first thing that breaks is the working tree.\n`);
        expect(split?.matter.raw).toBe(`---\ntitle: "One worktree per agent"\ndescription: "A git worktree each is the boundary that fixes it."\ndate: 2026-09-04\ntags: ["engineering"]\n---\n`);
    });

    it(`reads scalars unquoted and sequences as items`, () => {
        const fields = splitFrontmatter(POST)?.matter.fields;
        expect(fields).toEqual([
            { key: `title`, values: [`One worktree per agent`], sequence: false },
            { key: `description`, values: [`A git worktree each is the boundary that fixes it.`], sequence: false },
            { key: `date`, values: [`2026-09-04`], sequence: false },
            { key: `tags`, values: [`engineering`], sequence: true },
        ]);
    });

    it(`reads a block sequence under its key`, () => {
        const fields = splitFrontmatter(`---\ntags:\n  - engineering\n  - tooling\n---\nBody\n`)?.matter.fields;
        expect(fields).toEqual([{ key: `tags`, values: [`engineering`, `tooling`], sequence: true }]);
    });

    // The shape a hand-written SKILL.md takes, and what the daemon's own reader (settings/skill-file.ts) makes of it.
    it(`folds an indented continuation into the value above it`, () => {
        const fields = splitFrontmatter(`---\ndescription: Read an inbox over IMAP\n  and fetch messages with curl.\n---\n`)?.matter.fields;
        expect(fields).toEqual([{ key: `description`, values: [`Read an inbox over IMAP and fetch messages with curl.`], sequence: false }]);
    });

    it(`keeps a colon inside a value`, () => {
        const fields = splitFrontmatter(`---\nurl: https://example.com/a:b\n---\n`)?.matter.fields;
        expect(fields).toEqual([{ key: `url`, values: [`https://example.com/a:b`], sequence: false }]);
    });

    it(`keeps a comma inside a quoted sequence item`, () => {
        const fields = splitFrontmatter(`---\ntags: ["one, two", three]\n---\n`)?.matter.fields;
        expect(fields?.[0]?.values).toEqual([`one, two`, `three`]);
    });

    // The shapes a two-column grid cannot state. Reporting no fields is what sends them to the verbatim fallback.
    test.each([
        [`a nested map`, `---\nauthor:\n  name: Ada\n---\n`],
        [`a block scalar`, `---\nsummary: |\n  two\n  lines\n---\n`],
        [`a line that is not a pair`, `---\njust some words\n---\n`],
    ])(`reports no fields for %s`, (_case, source) => {
        const split = splitFrontmatter(source);
        // The block is still taken off the document — it just has no rows to draw.
        expect(split?.matter.raw).toBe(source.slice(0, source.lastIndexOf(`---`) + 4));
        expect(split?.matter.fields).toBeUndefined();
    });

    // A `---` that opens nothing: the document keeps the thematic break and the prose marked gives it.
    test.each([
        [`a rule mid-document`, `Intro.\n\n---\n\ntitle: not metadata\n`],
        [`an unterminated block`, `---\ntitle: x\n\nBody with no closing fence.\n`],
        [`a rule of four dashes`, `----\ntitle: x\n----\n`],
        [`an indented opener`, `   ---\ntitle: x\n---\n`],
        [`text before the opener`, `# Title\n\n---\ntitle: x\n---\n`],
    ])(`is not frontmatter: %s`, (_case, source) => {
        expect(splitFrontmatter(source)).toBeUndefined();
    });

    it(`survives \\r\\n endings`, () => {
        const fields = splitFrontmatter(`---\r\ntitle: x\r\n---\r\n\r\nBody\r\n`)?.matter.fields;
        expect(fields).toEqual([{ key: `title`, values: [`x`], sequence: false }]);
    });
});

describe(`frontmatterHtml`, () => {
    it(`draws one row per field, keys as written`, () => {
        const split = splitFrontmatter(POST);
        const html = split === undefined ? `` : frontmatterHtml(split.matter);
        expect(html).toContain(`<dt>title</dt><dd>One worktree per agent</dd>`);
        expect(html).toContain(`<dd><span class="md-fm-item">engineering</span></dd>`);
        expect(html.startsWith(`<div class="md-frontmatter"><dl>`)).toBe(true);
    });

    it(`escapes a value that is markup`, () => {
        const split = splitFrontmatter(`---\ntitle: <img src=x onerror=alert(1)>\n---\n`);
        const html = split === undefined ? `` : frontmatterHtml(split.matter);
        expect(html).not.toContain(`<img`);
        expect(html).toContain(`&lt;img`);
    });

    it(`shows a shape it cannot tabulate as the source it is`, () => {
        const split = splitFrontmatter(`---\nauthor:\n  name: Ada\n---\n`);
        const html = split === undefined ? `` : frontmatterHtml(split.matter);
        expect(html).toContain(`<pre class="md-fm-source">author:\n  name: Ada</pre>`);
    });

    it(`draws nothing for metadata with nothing in it`, () => {
        const split = splitFrontmatter(`---\n---\n\n# Title\n`);
        expect(split === undefined ? `x` : frontmatterHtml(split.matter)).toBe(``);
    });
});

// The editing surface splices spans back into the file, so the metadata has to be one of them: its lines are edited
// together as YAML, not as the rule-plus-heading the lexer reads them as.
describe(`metadata as an editable span`, () => {
    it(`is one block, ending where the closing fence ends`, () => {
        const blocks = splitMarkdownBlocks(POST).blocks;
        expect(POST.slice(blocks[0]?.start, blocks[0]?.end)).toBe(`${splitFrontmatter(POST)?.matter.raw  }\n`);
    });

    it(`still tiles the document`, () => {
        const blocks = splitMarkdownBlocks(POST).blocks;
        expect(blocks[0]?.start).toBe(0);
        expect(blocks.at(-1)?.end).toBe(POST.length);
        expect(blocks.every((block, index) => index === 0 || blocks[index - 1]?.end === block.start)).toBe(true);
    });
});
