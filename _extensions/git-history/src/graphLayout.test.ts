import { describe, expect, it } from "vitest";
import type { GitCommit } from "@intentic/sandbox-contract";
import { computeGraphLayout } from "./graphLayout";

// A minimal commit: only sha/parents drive the layout; the rest is render-only.
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
        // C absorbs both lanes: lane 0 flows straight in, lane 1 bends in keeping its own colour, not lane 0's.
        expect(bySha.get(`c`)?.col).toBe(0);
        expect(bySha.get(`c`)?.up).toContainEqual({ from: 1, to: 0, color: 1 });
    });

    it(`reuses a freed column instead of growing wider`, () => {
        // Lane 1 (d's second parent b) closes by row c/a; tip e should reuse that freed column, not widen the gutter.
        const layout = computeGraphLayout([
            commit(`d`, [`a`, `b`]),
            commit(`b`, [`c`]),
            commit(`a`, []),
            commit(`c`, []),
            commit(`e`, [`x`]),
            commit(`x`, []),
        ]);
        // Two branch events, but never more than two lanes wide: `e` reused a hole.
        expect(layout.laneCount).toBe(2);
        expect(layout.rows.find((row) => row.sha === `e`)?.col).toBe(0);
    });

    // Colour belongs to the branch, not the column; a structural `col`-only assertion can't catch a colour mistake.
    it(`keeps one branch's colour constant even where it changes column`, () => {
        // `b` opens lane 1 as the second parent; once lane 0 frees and reuses, colour tracks the branch, not the
        // column.
        const layout = computeGraphLayout([commit(`m`, [`a`, `b`]), commit(`a`, [`c`]), commit(`b`, [`c`]), commit(`c`, [])]);
        const bySha = new Map(layout.rows.map((row) => [row.sha, row]));
        // `b` sits in lane 1 with its own colour; `c`, which lane 0's branch flows into, keeps lane 0's.
        expect(bySha.get(`b`)?.color).not.toBe(bySha.get(`a`)?.color);
        expect(bySha.get(`c`)?.color).toBe(bySha.get(`a`)?.color);
    });

    it(`gives a later, unrelated branch a different colour from the one whose column it reuses`, () => {
        // `e` reuses the column `b` vacated; a shared column must not mean shared colour, or two branches look like
        // one.
        const layout = computeGraphLayout([
            commit(`d`, [`a`, `b`]),
            commit(`b`, [`c`]),
            commit(`a`, []),
            commit(`c`, []),
            commit(`e`, [`x`]),
            commit(`x`, []),
        ]);
        const bySha = new Map(layout.rows.map((row) => [row.sha, row]));
        expect(bySha.get(`e`)?.col).toBe(0);
        // Its colour is the lowest one no live branch currently holds.
        expect(bySha.get(`e`)?.color).toBe(0);
        expect(bySha.get(`b`)?.color).not.toBe(bySha.get(`d`)?.color);
    });

    it(`releases a colour once its branch has ended, so a long history stays inside a small palette`, () => {
        // Three disconnected tips, each starting after the last ends; all three land on colour 0, not climbing to 1, 2.
        const layout = computeGraphLayout([commit(`a`, []), commit(`b`, []), commit(`c`, [])]);
        expect(layout.rows.map((row) => row.color)).toEqual([0, 0, 0]);
        expect(layout.laneCount).toBe(1);
    });
});
