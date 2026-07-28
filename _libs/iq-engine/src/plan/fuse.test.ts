import { expect, test } from "vitest";
import type { EngineResult } from "../types.js";
import { fuse, type FuseContext } from "./fuse.js";

const context: FuseContext = { queryTokens: ["widget"], mtimes: new Map(), now: 0, boosts: true };

const lexical: EngineResult = {
    engine: "lexical",
    hits: [
        { path: "a.ts", line: 5, text: "widget()", tags: [{ kind: "text" }] },
        { path: "b.ts", line: 2, text: "widget()", tags: [{ kind: "text" }] },
    ],
};
const semantic: EngineResult = {
    engine: "semantic",
    hits: [
        { path: "b.ts", line: 2, text: "widget()", tags: [{ kind: "sem", score: 0.9 }] },
        { path: "c.ts", line: 9, text: "widgets", tags: [{ kind: "sem", score: 0.8 }] },
    ],
};

test("RRF: a hit found by two engines outranks single-engine hits; tags merge", () => {
    const groups = fuse([lexical, semantic], context);
    expect(groups[0]?.path).toBe("b.ts");
    expect(groups[0]?.hits[0]?.tags.map((tag) => tag.kind).toSorted()).toEqual(["sem", "text"]);
});

test("def boost outranks equal-rank text hits", () => {
    const withDef = fuse(
        [
            {
                engine: "symbols",
                hits: [
                    { path: "x.ts", line: 1, text: "const w", tags: [{ kind: "def" }] },
                    { path: "y.ts", line: 1, text: "w()", tags: [{ kind: "text" }] },
                ],
            },
        ],
        { ...context, queryTokens: [] },
    );
    // Same engine rank order in, but def-tagged hit keeps the top spot via its boost even at worse rank.
    const reversed = fuse(
        [
            {
                engine: "symbols",
                hits: [
                    { path: "y.ts", line: 1, text: "w()", tags: [{ kind: "text" }] },
                    { path: "x.ts", line: 1, text: "const w", tags: [{ kind: "def" }] },
                ],
            },
        ],
        { ...context, queryTokens: [] },
    );
    expect(withDef[0]?.path).toBe("x.ts");
    expect(reversed[0]?.path).toBe("x.ts");
});

test("a file with a huge number of hits fuses instead of overflowing the stack", () => {
    const many: EngineResult = {
        engine: "lexical",
        hits: Array.from({ length: 200_000 }, (_unused, index) => ({
            path: "big.ts",
            line: index + 1,
            text: "widget()",
            tags: [{ kind: "text" as const }],
        })),
    };
    const groups = fuse([many], context);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.hits).toHaveLength(200_000);
    expect(Number.isFinite(groups[0]?.score)).toBe(true);
});

test("deterministic: shuffled engine-result order yields identical output", () => {
    const a = JSON.stringify(fuse([lexical, semantic], context));
    const b = JSON.stringify(fuse([semantic, lexical], context));
    expect(a).toBe(b);
});
