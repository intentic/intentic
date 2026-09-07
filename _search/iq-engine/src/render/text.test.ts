import { expect, test } from "vitest";
import type { RankedGroup } from "../types.js";
import { estimateTokens } from "./budget.js";
import { renderText } from "./text.js";

const groups = (files: number, hitsPerFile: number): RankedGroup[] =>
    Array.from({ length: files }, (unusedFile, f) => ({
        path: `alpha/src/file-${f}.ts`,
        score: files - f,
        hits: Array.from({ length: hitsPerFile }, (unusedHit, h) => ({
            path: `alpha/src/file-${f}.ts`,
            line: h + 1,
            text: `const value${h} = computeSomething(${h}); // representative code line for budget tests`,
            tags: [{ kind: "text" as const }],
            score: 1,
        })),
    }));

const render = (input: RankedGroup[], budget: number): ReturnType<typeof renderText> =>
    renderText({
        verb: "find",
        echo: 'find "value"',
        unit: "matches",
        style: "hits",
        showTags: false,
        groups: input,
        offset: 0,
        freshness: { state: "fresh", ageMs: 120 },
        budget,
        cursorId: "abcd1234",
    });

test("hard budget: rendered output never exceeds --budget across sizes", () => {
    for (const budget of [80, 150, 300, 700, 1500, 4000]) {
        for (const [files, hits] of [
            [1, 1],
            [3, 5],
            [10, 20],
            [40, 8],
        ] as const) {
            const rendered = render(groups(files, hits), budget);
            expect(estimateTokens(rendered.text), `budget=${budget} files=${files} hits=${hits}`).toBeLessThanOrEqual(budget);
        }
    }
});

test("truncation footer carries a resumable cursor; header states shown/total", () => {
    const rendered = render(groups(30, 10), 400);
    expect(rendered.truncated).toBe(true);
    expect(rendered.cursor).toMatch(/^abcd1234[0-9a-z]+$/);
    expect(rendered.text).toContain(`--after ${rendered.cursor}`);
    expect(rendered.text).toContain("300 matches in 30 files");
});

test("zero hits: exit code 1 and an honest header", () => {
    const rendered = render([], 500);
    expect(rendered.exitCode).toBe(1);
    expect(rendered.text).toContain("0 matches in 0 files");
    expect(rendered.truncated).toBe(false);
});

test("offset pages through groups without re-counting totals", () => {
    const all = groups(6, 2);
    const first = render(all, 280);
    expect(first.truncated).toBe(true);
    const second = renderText({
        verb: "find",
        echo: 'find "value"',
        unit: "matches",
        style: "hits",
        showTags: false,
        groups: all,
        offset: first.shownGroups,
        freshness: { state: "fresh", ageMs: 120 },
        budget: 4000,
        cursorId: "abcd1234",
    });
    expect(second.text).toContain("12 matches in 6 files");
    expect(second.shownGroups).toBe(6 - first.shownGroups);
    expect(second.truncated).toBe(false);
});

// Line scores peak inside a symbol, not at its head, so the best-scoring line in a long function is routinely a
// brace or a `continue;` far below the definition the reader asked for: 31% of anchors in the 2026-09 mining.
// symctx knows where the symbol starts, so that is what the anchor names, with the match line kept beside it.
test("the answer anchors at the enclosing symbol's declaration, naming the match line separately", () => {
    const group: RankedGroup = {
        path: "alpha/src/scheduler.ts",
        score: 1,
        hits: [
            {
                path: "alpha/src/scheduler.ts",
                line: 543,
                text: "                continue;",
                tags: [{ kind: "rerank" as const, score: 0.79 }],
                score: 1,
                context: "createScheduler (fn)",
                contextLine: 119,
            },
        ],
    };
    const rendered = renderText({
        verb: "q",
        echo: '"scheduler wake"',
        unit: "hits",
        style: "hits",
        showTags: true,
        groups: [group],
        offset: 0,
        freshness: { state: "fresh", ageMs: 120 },
        budget: 1500,
        cursorId: "abcd1234",
        lead: true,
        confidence: "confident",
    });
    expect(rendered.text).toContain("answer: alpha/src/scheduler.ts:119 · createScheduler (fn) · match :543 · confident");
});

test("without an enclosing symbol the answer still anchors at the hit, and says nothing about a match line", () => {
    const group: RankedGroup = {
        path: "alpha/src/constants.ts",
        score: 1,
        hits: [{ path: "alpha/src/constants.ts", line: 7, text: "export const LIMIT = 40;", tags: [], score: 1 }],
    };
    const rendered = renderText({
        verb: "q",
        echo: '"limit"',
        unit: "hits",
        style: "hits",
        showTags: false,
        groups: [group],
        offset: 0,
        freshness: { state: "fresh", ageMs: 120 },
        budget: 1500,
        cursorId: "abcd1234",
        lead: true,
    });
    expect(rendered.text).toContain("answer: alpha/src/constants.ts:7");
    expect(rendered.text).not.toContain("match :");
});
