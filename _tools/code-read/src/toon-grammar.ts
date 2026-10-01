import type { LanguageRegistration } from "shiki/core";

/* TextMate grammar for TOON (Token-Oriented Object Notation, toon-format/spec v4): @shikijs/langs ships none.

   TOON is line-oriented, so almost every rule colours one line by itself: a full-line `#` comment, a `- ` list marker, a
   header (`key[N]:`, `key[N|]: a|b`), a `key: value` line, or a bare primitive. The one thing that spans lines is a
   fields-bearing header (`key[N]{a,b}:`, keyed `key[N:]{a,b}:`): its rows below carry no key of their own and split on
   the delimiter the header declared, so the header opens a block that holds that delimiter until the indentation comes
   back to the header's own. Under a list item (`- key[N]{a,b}:`) the rows sit two levels deeper than the hyphen and the
   item's other fields one level, which only the encoder's default two-space indent tells apart: the block assumes it. */

// The three delimiters a header can declare: none for comma, `|`, or a literal tab inside the brackets.
interface Delimiter {
    readonly id: `comma` | `pipe` | `tab`;
    // How the header spells it inside its brackets; comma is the absence of a symbol.
    readonly marker: string;
    // The character itself, escaped for a regex.
    readonly char: string;
}

const DELIMITERS: readonly Delimiter[] = [
    { id: `comma`, marker: ``, char: `,` },
    { id: `pipe`, marker: String.raw`\|`, char: String.raw`\|` },
    { id: `tab`, marker: String.raw`\t`, char: String.raw`\t` },
];

const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
// A key before a header's brackets: quoted, or any token without structure in it.
const HEADER_KEY = String.raw`${QUOTED}|[^\s"\[\]{}:][^\[\]{}:"]*`;
// A key before its colon: quoted, or the text up to the first colon.
const FIELD_KEY = String.raw`${QUOTED}|[^\s":][^:"]*?`;
// A length has no leading zeros, so `[03]` is not a header.
const LENGTH = String.raw`0|[1-9][0-9]*`;
// The spec's number grammar: `05`, `.5`, `+1` and `1_000` are strings.
const NUMBER = String.raw`-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?`;

const KEY = `entity.name.tag.toon`;
const COLON = `punctuation.separator.key-value.toon`;
const SEPARATOR = `punctuation.separator.delimiter.toon`;

// The bracket segment `[N:|]`, as five capture groups starting at `from`: `[`, length, keyed colon, delimiter, `]`.
const bracket = (delimiter: Delimiter): string => String.raw`(\[)(${LENGTH})(:)?(${delimiter.marker})(\])`;
const bracketCaptures = (from: number): Record<number, { name: string }> => ({
    [from]: { name: `punctuation.definition.array.begin.toon` },
    [from + 1]: { name: `constant.numeric.length.toon` },
    [from + 2]: { name: `keyword.operator.keyed.toon` },
    [from + 3]: { name: `keyword.control.delimiter.toon` },
    [from + 4]: { name: `punctuation.definition.array.end.toon` },
});

const keyCapture = { name: KEY, patterns: [{ include: `#escape` }] };

// A primitive that runs to the end of the line: a `key: value` value, a list item's, or a document that is one.
const scalarPatterns = [
    { include: `#string` },
    { match: String.raw`(?:true|false)(?= *$)`, name: `constant.language.boolean.toon` },
    { match: String.raw`null(?= *$)`, name: `constant.language.null.toon` },
    { match: String.raw`${NUMBER}(?= *$)`, name: `constant.numeric.toon` },
    {
        match: String.raw`(\[)(\])(?= *$)`,
        name: `meta.array.empty.toon`,
        captures: { 1: { name: `punctuation.definition.array.begin.toon` }, 2: { name: `punctuation.definition.array.end.toon` } },
    },
    { match: String.raw`\S.*`, name: `string.unquoted.toon` },
];

// Cells split on one delimiter: a row, or an inline array after its header. A cell is matched from its first non-space
// character, so a constant or number rule only wins when it spans the whole cell.
const cells = ({ char }: Delimiter) => [
    { include: `#string` },
    { match: String.raw`(?:true|false)(?= *(?:${char}|$))`, name: `constant.language.boolean.toon` },
    { match: String.raw`null(?= *(?:${char}|$))`, name: `constant.language.null.toon` },
    { match: String.raw`${NUMBER}(?= *(?:${char}|$))`, name: `constant.numeric.toon` },
    { match: char, name: SEPARATOR },
    { match: String.raw`[^\s${char}][^${char}]*`, name: `string.unquoted.toon` },
];

// A header's `{a,b{c,d}}`, separated by its delimiter at every depth.
const fields = ({ char }: Delimiter) => [
    { begin: `"`, end: `"`, name: `entity.other.attribute-name.toon`, patterns: [{ include: `#escape` }] },
    { match: String.raw`\{`, name: `punctuation.definition.fields.begin.toon` },
    { match: String.raw`\}`, name: `punctuation.definition.fields.end.toon` },
    { match: char, name: SEPARATOR },
    { match: String.raw`[^\s{}"${char}][^{}"${char}]*`, name: `entity.other.attribute-name.toon` },
];

// The rows under a fields-bearing header: keyed entry rows lead with `key:`, plain rows are all cells.
const rows = (delimiter: Delimiter) => [
    { include: `#comment` },
    {
        match: String.raw`^ *(${QUOTED}|[^\s":${delimiter.char}][^:"${delimiter.char}]*?)( *)(:)`,
        captures: { 1: keyCapture, 3: { name: COLON } },
    },
    { include: `#cells-${delimiter.id}` },
];

// A blank line, or a comment at any indent, keeps the rows open; anything else at or above `indent` closes them.
const rowsEnd = (indent: string): string => String.raw`^(?! *$)(?! *#)(?!\1${indent})`;

// `key[N]{a,b}:` alone on its line, its rows deeper than it.
const tabular = (delimiter: Delimiter) => ({
    name: `meta.table.toon`,
    begin: String.raw`^( *)(${HEADER_KEY})?${bracket(delimiter)}(\{.*\})(:) *$`,
    beginCaptures: {
        2: keyCapture,
        ...bracketCaptures(3),
        8: { patterns: [{ include: `#fields-${delimiter.id}` }] },
        9: { name: COLON },
    },
    end: rowsEnd(` `),
    patterns: rows(delimiter),
});

// `- key[N]{a,b}:`: the first field of a list-item object, its rows two levels under the hyphen.
const tabularItem = (delimiter: Delimiter) => ({
    name: `meta.table.toon`,
    begin: String.raw`^( *)(-)( +)(${HEADER_KEY})${bracket(delimiter)}(\{.*\})(:) *$`,
    beginCaptures: {
        2: { name: `punctuation.definition.block.sequence.item.toon` },
        4: keyCapture,
        ...bracketCaptures(5),
        10: { patterns: [{ include: `#fields-${delimiter.id}` }] },
        11: { name: COLON },
    },
    end: rowsEnd(` {3}`),
    patterns: rows(delimiter),
});

// `key[N]: a,b,c`, `[N]:` at the root or after `- `, or a list-form header with nothing after its colon.
const inlineArray = (delimiter: Delimiter) => ({
    begin: String.raw`(${HEADER_KEY})?${bracket(delimiter)}(:)`,
    beginCaptures: { 1: keyCapture, ...bracketCaptures(2), 7: { name: COLON } },
    end: `$`,
    patterns: [{ include: `#cells-${delimiter.id}` }],
});

const perDelimiter = <T>(rule: (delimiter: Delimiter) => T): T[] => DELIMITERS.map(rule);

const toon: LanguageRegistration = {
    name: `toon`,
    scopeName: `source.toon`,
    patterns: [
        { include: `#comment` },
        ...perDelimiter(tabularItem),
        ...perDelimiter(tabular),
        { match: String.raw`^ *(-)(?= |$)`, captures: { 1: { name: `punctuation.definition.block.sequence.item.toon` } } },
        ...perDelimiter(inlineArray),
        {
            begin: String.raw`(${FIELD_KEY})( *)(:)`,
            beginCaptures: { 1: keyCapture, 3: { name: COLON } },
            end: `$`,
            patterns: scalarPatterns,
        },
        ...scalarPatterns,
    ],
    repository: {
        // Full-line only: a `#` anywhere else is content.
        comment: { match: String.raw`^ *#.*$`, name: `comment.line.number-sign.toon` },
        string: {
            name: `string.quoted.double.toon`,
            begin: `"`,
            beginCaptures: { 0: { name: `punctuation.definition.string.begin.toon` } },
            end: `"|$`,
            endCaptures: { 0: { name: `punctuation.definition.string.end.toon` } },
            patterns: [{ include: `#escape` }],
        },
        escape: {
            patterns: [
                { match: String.raw`\\(?:[\\"nrt]|u[0-9a-fA-F]{4})`, name: `constant.character.escape.toon` },
                { match: String.raw`\\.`, name: `invalid.illegal.unrecognized-escape.toon` },
            ],
        },
        ...Object.fromEntries(
            DELIMITERS.flatMap((delimiter) => [
                [`cells-${delimiter.id}`, { patterns: cells(delimiter) }],
                [`fields-${delimiter.id}`, { patterns: fields(delimiter) }],
            ]),
        ),
    },
};

export default [toon];
