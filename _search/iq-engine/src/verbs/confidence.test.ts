import { expect, test } from "vitest";
import type { EngineHit } from "../types.js";
import { fieldMargin } from "./dispatch.js";

// Below CONFIDENCE_MARGIN (0.05) the answer line says "ambiguous" instead of "confident".
const MARGIN = 0.05;

const hit = (path: string, line: number): EngineHit => ({ path, line, text: "code", tags: [] });
const scored = (entries: readonly [string, number, number][]): { hit: EngineHit; logit: number }[] =>
    entries.map(([path, line, logit]) => ({ hit: hit(path, line), logit }));

// The bug this replaced: the margin was the gap between the top two PASSAGES. Two hits in one file resolve to
// the same chunk, so the cross-encoder scored the same text twice and the gap collapsed to zero — a file that
// matched well twice was reported as a flat field. 65% of answers in the 2026-09 mining said "ambiguous".
test("a file that matches well twice stays confident; its own second hit is not its rival", () => {
    const ordered = [{ path: "src/scheduler.ts" }, { path: "docs/notes.md" }];
    const entries = scored([
        ["src/scheduler.ts", 119, 3],
        ["src/scheduler.ts", 121, 3],
        ["docs/notes.md", 4, -3],
    ]);
    // Passage-to-passage would be sigmoid(3) - sigmoid(3) = 0. File-to-file compares the two distinct files.
    expect(fieldMargin(ordered, entries)).toBeGreaterThan(MARGIN);
});

test("a genuinely flat field is still ambiguous", () => {
    const ordered = [{ path: "src/a.ts" }, { path: "src/b.ts" }];
    const entries = scored([
        ["src/a.ts", 1, 0.5],
        ["src/b.ts", 1, 0.49],
    ]);
    expect(fieldMargin(ordered, entries)).toBeLessThan(MARGIN);
});

test("the margin compares the two leading files of the displayed order, not the best two scores anywhere", () => {
    const ordered = [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }];
    const entries = scored([
        ["src/a.ts", 1, 3],
        ["src/b.ts", 1, -3],
        // A high scorer ranked third by the RRF blend must not be mistaken for the runner-up.
        ["src/c.ts", 1, 2.9],
    ]);
    const margin = fieldMargin(ordered, entries);
    expect(margin).toBeCloseTo(1 / (1 + Math.exp(-3)) - 1 / (1 + Math.exp(3)), 10);
});

test("a runner-up that never reached the cross-encoder reads as the widest gap, not as missing data", () => {
    const ordered = [{ path: "src/a.ts" }, { path: "src/unscored.ts" }];
    expect(fieldMargin(ordered, scored([["src/a.ts", 1, 1]]))).toBe(1);
});

test("no reranked leader means no signal to report", () => {
    expect(fieldMargin([{ path: "src/a.ts" }], scored([["src/other.ts", 1, 1]]))).toBe(0);
    expect(fieldMargin([], scored([]))).toBe(0);
});
