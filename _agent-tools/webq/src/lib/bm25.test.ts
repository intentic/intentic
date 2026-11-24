import { bm25Rank, tokenize } from "./bm25.js";

describe("tokenize", () => {
    it("lowercases, splits on non-word runs and drops one-char tokens", () => {
        expect(tokenize("The API’s rate-limit: 5/s")).toEqual(["the", "api", "rate", "limit"]);
    });

    it("folds English plurals so a query's form matches the page's", () => {
        expect(tokenize("webhooks retries pages boxes patches class press")).toEqual(["webhook", "retry", "page", "box", "patch", "class", "press"]);
    });
});

describe("bm25Rank", () => {
    const blocks = [
        "installation guide for the command line tool",
        "webhook delivery retries use exponential backoff with jitter",
        "pricing tiers and billing frequently asked questions",
        "configuring webhook endpoints and secrets",
    ];

    it("ranks the block about the query first and drops zero-signal blocks", () => {
        const ranked = bm25Rank(blocks, (block) => block, "webhook retry backoff");
        expect(ranked[0]?.block).toBe(blocks[1]);
        const kept = ranked.map((entry) => entry.block);
        expect(kept).not.toContain(blocks[0]);
        expect(kept).not.toContain(blocks[2]);
    });

    it("returns nothing for an empty or unmatched query", () => {
        expect(bm25Rank(blocks, (block) => block, "")).toEqual([]);
        expect(bm25Rank(blocks, (block) => block, "zebra")).toEqual([]);
    });

    it("counts document frequency once per block and folds duplicate query terms", () => {
        const docs = ["webhook webhook", "webhook other", ""];
        const ranked = bm25Rank(docs, (block) => block, "webhooks webhook missing");
        expect(ranked.map((entry) => entry.block)).toEqual(docs.slice(0, 2));
        const idf = Math.log(1 + 1.5 / 2.5);
        expect(ranked[0]?.score).toBeCloseTo((idf * 4.4) / (2 + 1.2 * (0.25 + 0.75 * 1.5)), 12);
        expect(ranked[1]?.score).toBeCloseTo((idf * 2.2) / (1 + 1.2 * (0.25 + 0.75 * 1.5)), 12);
    });

    it("keeps document order when scores tie and handles blocks with no tokens", () => {
        const docs = [{ text: "webhook retry" }, { text: "retry webhook" }, { text: "!" }];
        expect(bm25Rank(docs, (block) => block.text, "webhook").map((entry) => entry.block)).toEqual(docs.slice(0, 2));
        expect(bm25Rank(["", "!"], (block) => block, "webhook")).toEqual([]);
        expect(bm25Rank([], (block: string) => block, "webhook")).toEqual([]);
    });
});
