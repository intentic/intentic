// A document shadow's body as search tools show it: every line under a fileq page or slide heading carries that page
// as a prefix, so a hit read on its own is already a citation (`docs/terms.pdf:345:[p. 12] … wniosek …`).
// The ripgrep preprocessor (fileq's `bin/fileq-rg-pre`, awk) prints this shape, and a test holds it to this one's
// output. Lines before the first heading (a one-page PDF has none) are bare.

export const PAGE_MARK_PATTERN = /^\[(p\.|slide) \d+\] /;

const PAGE_HEADING = /^## Page (\d+)$/;
const SLIDE_HEADING = /^## Slide (\d+)/;

/** The mark for a heading line, or undefined when the line opens no page. */
const markOf = (line: string): string | undefined => {
    const page = PAGE_HEADING.exec(line);
    if (page !== null) {
        return `[p. ${page[1]}] `;
    }
    const slide = SLIDE_HEADING.exec(line);
    return slide === null ? undefined : `[slide ${slide[1]}] `;
};

/** Prefixes each line with the page or slide it sits on; line count and order are unchanged, a final newline kept bare. */
export const markPages = (body: string): string => {
    if (body.endsWith("\n")) {
        return `${markPages(body.slice(0, -1))}\n`;
    }
    let mark = "";
    return body
        .split("\n")
        .map((line) => {
            mark = markOf(line) ?? mark;
            return `${mark}${line}`;
        })
        .join("\n");
};
