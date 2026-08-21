import { expect, test } from "vitest";
import type { EngineResult } from "../types.js";
import { fuse, type FuseContext } from "./fuse.js";

const context: FuseContext = {
    queryTokens: ["widget"],
    mtimes: new Map(),
    now: 0,
    defBoost: true,
    pathBoost: true,
    recency: true,
    sourceFirst: false,
};

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

// The three multipliers are separate features: each one alone must be able to reorder, and turning it off must
// leave pure RRF order. Benchmarking depends on that independence: a bundled toggle could not attribute a delta.
const alone = (multiplier: "defBoost" | "pathBoost" | "recency"): FuseContext => ({
    ...context,
    defBoost: multiplier === "defBoost",
    pathBoost: multiplier === "pathBoost",
    recency: multiplier === "recency",
});

const rrfOrder: EngineResult = {
    engine: "symbols",
    hits: [
        { path: "plain.ts", line: 1, text: "w()", tags: [{ kind: "text" }] },
        { path: "widget.ts", line: 1, text: "const w", tags: [{ kind: "def" }] },
    ],
};

test("def boost alone reorders; off leaves RRF order", () => {
    expect(fuse([rrfOrder], { ...alone("defBoost"), queryTokens: [] })[0]?.path).toBe("widget.ts");
    expect(fuse([rrfOrder], { ...context, defBoost: false, pathBoost: false, recency: false })[0]?.path).toBe("plain.ts");
});

test("path boost alone reorders on a query token in the path", () => {
    expect(fuse([rrfOrder], alone("pathBoost"))[0]?.path).toBe("widget.ts");
    expect(fuse([rrfOrder], { ...alone("pathBoost"), queryTokens: ["nothing"] })[0]?.path).toBe("plain.ts");
});

test("path boost matches path words, not substrings of them", () => {
    const infix: EngineResult = {
        engine: "lexical",
        hits: [
            { path: "src/formatting.py", line: 1, text: "wrap()", tags: [{ kind: "text" }] },
            { path: "src/_textwrap.py", line: 1, text: "wrap()", tags: [{ kind: "text" }] },
        ],
    };
    // "wrap" is inside "textwrap" but names nothing in that path: the file that wraps help output keeps rank 1.
    expect(fuse([infix], { ...alone("pathBoost"), queryTokens: ["wrap"] })[0]?.path).toBe("src/formatting.py");
    // A query token that starts a path word still boosts: "index" is what `indexer.ts` is named after.
    const stem: EngineResult = {
        engine: "lexical",
        hits: [
            { path: "src/schemas.ts", line: 1, text: "changed", tags: [{ kind: "text" }] },
            { path: "src/indexer/indexer.ts", line: 1, text: "changed", tags: [{ kind: "text" }] },
        ],
    };
    expect(fuse([stem], { ...alone("pathBoost"), queryTokens: ["index"] })[0]?.path).toBe("src/indexer/indexer.ts");
});

test("recency alone reorders toward the newer file", () => {
    const mtimes = new Map([
        ["plain.ts", -30 * 86_400_000],
        ["widget.ts", 0],
    ]);
    expect(fuse([rrfOrder], { ...alone("recency"), queryTokens: [], mtimes })[0]?.path).toBe("widget.ts");
    expect(fuse([rrfOrder], { ...context, defBoost: false, pathBoost: false, recency: false, queryTokens: [], mtimes })[0]?.path).toBe("plain.ts");
});

/* The 200k is the point: it is past the argument limit that made the old spread-based fuse throw, so the
 * work is real CPU rather than the object-shuffling the 5s unit budget assumes, and on a runner building three
 * verify jobs at once it ran 25x its 203ms local time and tripped the hang detector. Stated at the test, per
 * the budget's own escape hatch: this bounds a hang, it does not measure the runner. */
const NO_STACK_OVERFLOW = 30_000;

test(
    "a file with a huge number of hits fuses instead of overflowing the stack",
    () => {
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
    },
    NO_STACK_OVERFLOW,
);

test("deterministic: shuffled engine-result order yields identical output", () => {
    const a = JSON.stringify(fuse([lexical, semantic], context));
    const b = JSON.stringify(fuse([semantic, lexical], context));
    expect(a).toBe(b);
});
