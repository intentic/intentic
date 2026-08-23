import { describe, expect, it } from "vitest";
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
});
