import { describe, expect, it } from "vitest";
import type { GitCommit } from "@intentic-app/api-contract";
import { computeGraphLayout } from "./graphLayout";

// A minimal commit — only sha/parents drive the layout; the rest is render-only.
const commit = (sha: string, parents: string[]): GitCommit => ({
    sha,
    short: sha,
    parents,
    subject: sha,
    body: ``,
    author: `a`,
    email: `a@b.c`,
    at: 0,
    refs: [],
    head: false,
});

describe(`computeGraphLayout`, () => {
    it(`lays a linear history in one lane`, () => {
        const { rows, laneCount } = computeGraphLayout([commit(`c`, [`b`]), commit(`b`, [`a`]), commit(`a`, [])]);
        expect(laneCount).toBe(1);
        expect(rows.map((row) => row.col)).toEqual([0, 0, 0]);
        // The middle commit is a straight pass: one edge in, one edge out, both in lane 0.
        expect(rows[1]?.up).toEqual([{ from: 0, to: 0, color: 0 }]);
        expect(rows[1]?.down).toEqual([{ from: 0, to: 0, color: 0 }]);
        // The root commit has an incoming edge but no outgoing lane (its parents are out of window / absent).
        expect(rows[2]?.down).toEqual([]);
    });

    it(`branches a second parent into a new lane and merges it back`, () => {
        // M(merge of A,B) → A(→C) → B(→C) → C. B and its second-parent lane must converge on C.
        const layout = computeGraphLayout([commit(`m`, [`a`, `b`]), commit(`a`, [`c`]), commit(`b`, [`c`]), commit(`c`, [])]);
        const bySha = new Map(layout.rows.map((row) => [row.sha, row]));
        expect(layout.laneCount).toBe(2);
        // The merge commit branches its second parent out to a fresh lane 1.
        expect(bySha.get(`m`)?.col).toBe(0);
        expect(bySha.get(`m`)?.down).toContainEqual({ from: 0, to: 1, color: 1 });
        // B lives in lane 1 (the second-parent lane), A in lane 0.
        expect(bySha.get(`a`)?.col).toBe(0);
        expect(bySha.get(`b`)?.col).toBe(1);
        // C absorbs both lanes: a straight edge from lane 0 and a merge edge bending from lane 1 → col 0.
        expect(bySha.get(`c`)?.col).toBe(0);
        expect(bySha.get(`c`)?.up).toContainEqual({ from: 1, to: 0, color: 0 });
    });

    it(`reuses a freed column instead of growing wider`, () => {
        // Component 1 opens lane 1 (d's second parent b) and closes it by row `c`/`a`; a later disconnected
        // tip `e` should REUSE the freed column rather than widening the gutter. Valid topo order throughout
        // (every child precedes its parent).
        const layout = computeGraphLayout([
            commit(`d`, [`a`, `b`]),
            commit(`b`, [`c`]),
            commit(`a`, []),
            commit(`c`, []),
            commit(`e`, [`x`]),
            commit(`x`, []),
        ]);
        // Two branch events, but never more than two lanes wide — `e` reused a hole.
        expect(layout.laneCount).toBe(2);
        expect(layout.rows.find((row) => row.sha === `e`)?.col).toBe(0);
    });
});
