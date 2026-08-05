// Query and path tokenization shared by the stages that match words rather than lines: BM25 builds its MATCH
// expression from query terms, fusion boosts hits whose path names one of them.

export const STOPWORDS = new Set(
    "a an and are as at be but by do does for from has have how i in is it of on or that the this to was we what when where which who why with you".split(
        " ",
    ),
);

// Content tokens of a query: identifier-friendly, 3+ chars, stopword-stripped. A boost keyed on "and" or "the"
// is noise — `commands-and-groups.md` outranked the dispatcher it documents because "and" is in its name.
export const queryTokens = (query: string): string[] => [
    ...new Set((query.toLowerCase().match(/[a-z0-9_$]{3,}/g) ?? []).filter((token) => !STOPWORDS.has(token))),
];

// The words a path is made of — directory and file-name parts, split on separators and camelCase humps. Matching
// these instead of the raw path is what keeps "wrap" from matching `_textwrap.py`: a path boost means the path
// NAMES the thing asked about, and an accidental infix names nothing.
export const pathTokens = (path: string): string[] => [
    ...new Set(
        path
            .split(/[^A-Za-z0-9]+/)
            .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
            .filter((part) => part !== "")
            .map((part) => part.toLowerCase()),
    ),
];
