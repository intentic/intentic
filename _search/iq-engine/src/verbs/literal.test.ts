import { isQuestion, literalCandidates, literalPattern, looksLikeUiCopy, quotedSpans } from "./literal.js";

describe("what a bare query tries literally", () => {
    test("three words or more are searched for everywhere", () => {
        expect(literalCandidates("That agent has no conversation left to send to.")).toEqual([
            { text: "That agent has no conversation left to send to.", anywhere: true, wholeOnly: false, copy: true },
        ]);
        expect(literalCandidates("serialize concurrent operations per key")[0]).toMatchObject({ anywhere: true, copy: false });
    });

    // A doc that restates a question verbatim ("# Where is a widget created?") is not the answer to it; only a catalog
    // string the question equals whole is (UI copy can be a question: "Are you sure you want to leave?").
    test("a question is tried only as a whole catalog string", () => {
        expect(literalCandidates("where is a widget created?")).toEqual([{ text: "where is a widget created?", anywhere: false, wholeOnly: true, copy: false }]);
        expect(isQuestion("How does auth refresh?")).toBe(true);
        expect(isQuestion("Delete this sandbox?")).toBe(false);
    });

    test("two words are tried only when written as copy, and then only as a whole catalog string", () => {
        expect(literalCandidates("Archive agent")).toEqual([{ text: "Archive agent", anywhere: false, wholeOnly: true, copy: true }]);
        expect(literalCandidates("file tree")).toEqual([]);
        expect(literalCandidates("createWidget")).toEqual([]);
    });

    test("a quoted span is tried on its own, beside the whole query", () => {
        const candidates = literalCandidates(`where does "no conversation left to send" come from`);
        expect(candidates.map((candidate) => candidate.text)).toEqual([`where does "no conversation left to send" come from`, "no conversation left to send"]);
        expect(candidates[1]).toMatchObject({ anywhere: true, wholeOnly: false, copy: true });
    });

    test("an apostrophe inside a word does not open a quoted span", () => {
        expect(quotedSpans("it couldn't find 'the right thing' here")).toEqual(["the right thing"]);
    });

    test("copy is sentence-cased or closed like a sentence", () => {
        expect(looksLikeUiCopy("Recently deleted")).toBe(true);
        expect(looksLikeUiCopy("preparing your domain…")).toBe(true);
        expect(looksLikeUiCopy("recently deleted")).toBe(false);
    });
});

describe("literalPattern", () => {
    const matches = (text: string, line: string): boolean => new RegExp(literalPattern(text), "i").test(line);

    test("any whitespace between the words, either apostrophe, no closing punctuation required", () => {
        expect(matches("That agent has no conversation left.", `"x": "That agent  has no conversation left to send to."`)).toBe(true);
        expect(matches("The land couldn't reach", "The land couldn’t reach your workspace")).toBe(true);
        expect(matches("Preparing your intentic domain…", "Preparing your intentic domain")).toBe(true);
    });

    test("regex metacharacters in the text are literal", () => {
        expect(matches("costs $5 (per month)", "it costs $5 (per month) today")).toBe(true);
        expect(matches("a.b c", "axb c")).toBe(false);
    });
});
