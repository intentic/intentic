// How far each line of a wrapped <Code> block is indented, for the hanging indent code.css draws from it (`--hang`):
// a line that wraps carries on under its own indent instead of at the margin, so a wrapped YAML or JSON file keeps its
// shape.

// The leading width of one line in columns, a tab taken at the browser's default tab stop of eight.
const TAB_COLUMNS = 8;
const indentOf = (line: string): number => {
    let columns = 0;
    for (const char of line) {
        if (char === ` `) {
            columns += 1;
        } else if (char === `\t`) {
            columns += TAB_COLUMNS - (columns % TAB_COLUMNS);
        } else {
            break;
        }
    }
    return columns;
};

// Shiki's markup with each line span carrying its line's indent. Its lines are the source's lines in order, one
// `<span class="line">` each (highlightSliced's plain lines too); a line with no indent is left bare.
export const withLineIndents = (html: string, code: string): string => {
    const lines = code.split(`\n`);
    let at = 0;
    return html.replaceAll(`<span class="line">`, (span) => {
        const indent = indentOf(lines[at] ?? ``);
        at += 1;
        return indent === 0 ? span : `<span class="line" style="--hang:${indent}">`;
    });
};
