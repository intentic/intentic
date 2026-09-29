// English function words that carry no topic, dropped from a query before it reaches a full-text index. One list for
// every search that strips them (iq's code BM25, session recall), so the two never disagree on what "the" means.
export const STOPWORDS: ReadonlySet<string> = new Set(
    "a an and are as at be but by do does for from has have how i in is it of on or that the this to was we what when where which who why with you".split(
        " ",
    ),
);
