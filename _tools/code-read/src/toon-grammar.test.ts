import { analyzeCode } from "./analysis.js";
import { grammars } from "./grammars.js";

// The local TOON grammar against its own spec's shapes. The one rule that spans lines is the fields-bearing header,
// whose rows split on the delimiter it declared and end when the indentation comes back to it; everything else is
// one line coloured by itself.

// Each line's non-blank tokens as `text scope`, the innermost scope only.
const scopesOf = async (source: string): Promise<string[][]> => {
    const grammar = await grammars(`toon`);
    if (grammar === undefined) {
        throw new Error(`no toon grammar`);
    }
    let stack: Parameters<typeof grammar.tokenizeLine>[1] = null;
    return source.split(`\n`).map((line) => {
        const result = grammar.tokenizeLine(line, stack);
        stack = result.ruleStack;
        return result.tokens
            .map((token) => [line.slice(token.startIndex, token.endIndex), token.scopes.at(-1)!] as const)
            .filter(([text]) => text.trim() !== ``)
            .map(([text, scope]) => `${text.trim()} ${scope}`);
    });
};

describe(`the TOON grammar`, () => {
    it(`types a key-value line's value by the spec's rules, so a leading zero stays a string`, async () => {
        const lines = await scopesOf([`count: 42`, `ok: true`, `none: null`, `zip: 05`, `name: "a: b"`, `empty: []`].join(`\n`));
        expect(lines.map((line) => line.at(-1))).toEqual([
            `42 constant.numeric.toon`,
            `true constant.language.boolean.toon`,
            `null constant.language.null.toon`,
            `05 string.unquoted.toon`,
            `" punctuation.definition.string.end.toon`,
            `] punctuation.definition.array.end.toon`,
        ]);
        expect(lines[0]![0]).toBe(`count entity.name.tag.toon`);
    });

    it(`colours a whole-line comment and leaves a # inside a value as content`, async () => {
        const [comment, value] = await scopesOf([`  # a note`, `check: git status  # not a comment`].join(`\n`));
        expect(comment).toEqual([`# a note comment.line.number-sign.toon`]);
        expect(value!.at(-1)).toBe(`git status  # not a comment string.unquoted.toon`);
    });

    it(`splits tabular rows on the header's delimiter, so a comma in a pipe table is data`, async () => {
        const source = [`dirs[2|]{path|what}:`, `  /work|the root, your worktree`, `  # between rows`, `  /refs|"a | b"`, `after: 1`].join(`\n`);
        const [header, first, comment, second, after] = await scopesOf(source);
        expect(header).toContain(`| keyword.control.delimiter.toon`);
        expect(header).toContain(`path entity.other.attribute-name.toon`);
        expect(first).toEqual([
            `/work string.unquoted.toon`,
            `| punctuation.separator.delimiter.toon`,
            `the root, your worktree string.unquoted.toon`,
        ]);
        expect(comment).toEqual([`# between rows comment.line.number-sign.toon`]);
        expect(second).toContain(`a | b string.quoted.double.toon`);
        // The dedent closes the rows: the next line is a key again, not a cell.
        expect(after![0]).toBe(`after entity.name.tag.toon`);
    });

    it(`reads a keyed table's entry rows as key, then cells`, async () => {
        const [, entry] = await scopesOf([`scores[2:]{low,high}:`, `  "first run": 1,2`].join(`\n`));
        expect(entry).toEqual([
            `"first run" entity.name.tag.toon`,
            `: punctuation.separator.key-value.toon`,
            `1 constant.numeric.toon`,
            `, punctuation.separator.delimiter.toon`,
            `2 constant.numeric.toon`,
        ]);
    });

    it(`ends a list item's table at the item's next field, two levels above its rows`, async () => {
        const source = [`items[1]:`, `  - rows[1]{a,b}:`, `      1,2`, `    after: x`].join(`\n`);
        const [, item, row, sibling] = await scopesOf(source);
        expect(item![0]).toBe(`- punctuation.definition.block.sequence.item.toon`);
        expect(row).toContain(`1 constant.numeric.toon`);
        expect(sibling![0]).toBe(`after entity.name.tag.toon`);
    });

    it(`colours an inline array's cells`, async () => {
        const [line] = await scopesOf(`  - [3]: x,7,false`);
        expect(line).toEqual([
            `- punctuation.definition.block.sequence.item.toon`,
            `[ punctuation.definition.array.begin.toon`,
            `3 constant.numeric.length.toon`,
            `] punctuation.definition.array.end.toon`,
            `: punctuation.separator.key-value.toon`,
            `x string.unquoted.toon`,
            `, punctuation.separator.delimiter.toon`,
            `7 constant.numeric.toon`,
            `, punctuation.separator.delimiter.toon`,
            `false constant.language.boolean.toon`,
        ]);
    });

    it(`gives the comment-free reading a review diffs: comment lines drop, content stays`, async () => {
        const source = [`# generated`, `title: notes`, `  # about the rows`, `tags[2]: a,b`].join(`\n`);
        expect((await analyzeCode(source, `toon`, grammars))?.code.text).toBe([`title: notes`, `tags[2]: a,b`].join(`\n`));
    });
});
