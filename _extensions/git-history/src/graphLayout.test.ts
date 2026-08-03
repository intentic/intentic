import { describe, expect, it } from "vitest";
import type { GitCommit } from "@intentic/sandbox-contract";
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
        // C absorbs both lanes: a straight edge from lane 0 and a merge edge bending from lane 1 → col 0. The
        // bending edge keeps lane 1's OWN colour rather than adopting the target's, which is what lets a reader
        // follow the merged-in branch all the way to where it forked.
        expect(bySha.get(`c`)?.col).toBe(0);
        expect(bySha.get(`c`)?.up).toContainEqual({ from: 1, to: 0, color: 1 });
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

    /* COLOUR IS A PROPERTY OF THE BRANCH, NOT OF THE COLUMN — the whole point of the lane model carrying a
     * colour at all. These two are the failures that made the earlier column-keyed version misleading, and
     * neither is visible in a structural assertion about `col`. */
    it(`keeps one branch's colour constant even where it changes column`, () => {
        // `b` opens lane 1 as the merge's second parent, then lane 0 frees up and later work reuses it — the
        // colour must track the branch across that move rather than flipping with the column.
        const layout = computeGraphLayout([
            commit(`m`, [`a`, `b`]),
            commit(`a`, [`c`]),
            commit(`b`, [`c`]),
            commit(`c`, []),
        ]);
        const bySha = new Map(layout.rows.map((row) => [row.sha, row]));
        // `b` sits in lane 1 with its own colour; `c`, which lane 0's branch flows into, keeps lane 0's.
        expect(bySha.get(`b`)?.color).not.toBe(bySha.get(`a`)?.color);
        expect(bySha.get(`c`)?.color).toBe(bySha.get(`a`)?.color);
    });

    it(`gives a later, unrelated branch a different colour from the one whose column it reuses`, () => {
        // Same shape as the column-reuse case above: `e` takes the column `b`'s branch vacated. Sharing a column
        // with a finished branch must not mean sharing its colour — that is exactly the "two unrelated branches
        // look like one" failure.
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
        // ...and its colour is the lowest one no LIVE branch holds, which is what keeps the palette small
        // without ever colliding on screen.
        expect(bySha.get(`e`)?.color).toBe(0);
        expect(bySha.get(`b`)?.color).not.toBe(bySha.get(`d`)?.color);
    });

    it(`releases a colour once its branch has ended, so a long history stays inside a small palette`, () => {
        // Three disconnected single-commit tips in a row: each begins after the last has ended, so all three
        // should land on colour 0 rather than climbing 0, 1, 2 and running the palette off its end.
        const layout = computeGraphLayout([commit(`a`, []), commit(`b`, []), commit(`c`, [])]);
        expect(layout.rows.map((row) => row.color)).toEqual([0, 0, 0]);
        expect(layout.laneCount).toBe(1);
    });
});
