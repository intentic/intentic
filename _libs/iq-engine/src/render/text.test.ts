import { expect, test } from "vitest";
import type { RankedGroup } from "../types.js";
import { estimateTokens } from "./budget.js";
import { renderText } from "./text.js";

const groups = (files: number, hitsPerFile: number): RankedGroup[] =>
    Array.from({ length: files }, (unusedFile, f) => ({
        path: `repositories/alpha/src/file-${f}.ts`,
        score: files - f,
        hits: Array.from({ length: hitsPerFile }, (unusedHit, h) => ({
            path: `repositories/alpha/src/file-${f}.ts`,
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
