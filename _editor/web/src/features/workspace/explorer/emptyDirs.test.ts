import { STATE_DIR } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import { barrenChainOf, barrenChildren, barrenRoots, branchDirPaths, settleBarren, sweepableDirs } from "./emptyDirs";

// Daemon sends every folder holding only empty folders, root-relative, tree order; this file
// decides which the explorer offers.
const chain = (paths: readonly string[]): ReadonlyMap<string, readonly string[]> => barrenChildren(paths);
const all = (paths: readonly string[]): ReadonlySet<string> => new Set(paths);

describe(`sweepableDirs`, () => {
    it(`passes an ordinary branch through untouched, in the order it arrived`, () => {
        const barren = [`web`, `web/demo`, `web/demo/assets`];
        expect(sweepableDirs(barren)).toEqual(barren);
    });

    it(`leaves the reference shelf and the outbox alone, empty or not`, () => {
        expect(sweepableDirs([`refs`, `public`, `public/x`])).toEqual([]);
    });

    it(`leaves the daemon's own folders alone: its state dir and the skill projections`, () => {
        // Remade on the daemon's next converge: sweeping one would be a loop.
        const barren = [STATE_DIR, `${STATE_DIR}/local/cache`, `.agents/skills`, `.claude/skills`];
        expect(sweepableDirs(barren)).toEqual([]);
    });

    it(`leaves the folder a fixture sits IN alone: sweeping it would take the fixture with it`, () => {
        // The daemon reports `.claude` as barren too, but deleting it would delete the skills projection it remakes.
        expect(sweepableDirs([`.claude`, `.claude/skills`])).toEqual([]);
    });

    it(`finds nothing to sweep in a fresh workspace`, () => {
        const barren = [`.agents`, `.agents/skills`, `.claude`, `.claude/skills`, `refs`];
        expect(barrenRoots(sweepableDirs(barren), all(barren))).toEqual([]);
    });

    // Rule is root-relative: `app/.claude/skills` isn't the daemon's own folder, so it can still be swept.
    it(`still sweeps a repo's own .claude/skills`, () => {
        const barren = [`app`, `app/.claude`, `app/.claude/skills`];
        expect(sweepableDirs(barren)).toEqual(barren);
    });
});

describe(`barrenRoots`, () => {
    it(`returns the top of each branch, once, in tree order`, () => {
        const barren = [`a`, `a/b`, `src/old`];
        expect(barrenRoots(barren, all(barren))).toEqual([`a`, `src/old`]);
    });

    it(`heads a branch at the deepest folder that has settled, not above it`, () => {
        // `a` is still inside its settle window; `a/b` has held long enough to be offered instead.
        const barren = [`a`, `a/b`, `a/b/c`];
        expect(barrenRoots(barren, new Set([`a/b`, `a/b/c`]))).toEqual([`a/b`]);
    });

    it(`offers a branch the tree listing never reached: the whole point of asking the daemon`, () => {
        // Sits beyond the tree's entry budget: never in the explorer's own listing.
        const barren = [`repo/src/composables/workspace/old`];
        expect(barrenRoots(barren, all(barren))).toEqual([`repo/src/composables/workspace/old`]);
    });
});

describe(`barrenChainOf`, () => {
    it(`follows the single-child descent to the leaf`, () => {
        const barren = [`public2`, `public2/demo`, `public2/demo/assets`];
        const found = barrenChainOf(`public2`, chain(barren));
        expect(found.names).toEqual([`public2`, `demo`, `assets`]);
        expect(found.tail).toBe(`public2/demo/assets`);
    });

    it(`stops where the branch widens`, () => {
        const barren = [`a`, `a/b`, `a/b/c`, `a/b/d`];
        const found = barrenChainOf(`a`, chain(barren));
        expect(found.names).toEqual([`a`, `b`]);
        expect(found.tail).toBe(`a/b`);
    });

    it(`is a one-link chain for a plain empty dir`, () => {
        const found = barrenChainOf(`old`, chain([`old`]));
        expect(found.names).toEqual([`old`]);
        expect(found.tail).toBe(`old`);
    });

    it(`stops at a child the given set does not hold (not yet settled)`, () => {
        const settled = [`public2`, `public2/demo`];
        expect(barrenChainOf(`public2`, chain(settled)).names).toEqual([`public2`, `demo`]);
    });
});

describe(`branchDirPaths`, () => {
    it(`lists every dir of the branch, root first`, () => {
        const barren = [`a`, `a/b`, `a/b/c`, `a/b/d`, `z`];
        expect(branchDirPaths(`a`, barren)).toEqual([`a`, `a/b`, `a/b/c`, `a/b/d`]);
    });

    it(`takes a sibling that merely shares a name prefix for what it is: not part of the branch`, () => {
        expect(branchDirPaths(`a`, [`a`, `a-old`])).toEqual([`a`]);
    });

    it(`records what the delete will take, settled or not: the way back has to rebuild all of it`, () => {
        expect(branchDirPaths(`a`, [`a`, `a/fresh`])).toEqual([`a`, `a/fresh`]);
    });
});

describe(`settleBarren`, () => {
    const none = new Set<string>();

    it(`stamps a new path and settles it only after the window`, () => {
        const first = settleBarren([`a`], new Map(), none, 1000, 500);
        expect([...first.settled]).toEqual([]);
        const second = settleBarren([`a`], first.firstSeen, none, 1600, 500);
        expect([...second.settled]).toEqual([`a`]);
    });

    it(`forgets a path that left the set: re-emptying restarts the clock`, () => {
        const first = settleBarren([`a`], new Map(), none, 1000, 500);
        const gone = settleBarren([], first.firstSeen, none, 1200, 500);
        expect(gone.firstSeen.has(`a`)).toBe(false);
        const back = settleBarren([`a`], gone.firstSeen, none, 1300, 500);
        expect([...back.settled]).toEqual([]);
    });

    it(`never settles an exempt path however long it holds`, () => {
        const first = settleBarren([`a`], new Map(), new Set([`a`]), 0, 500);
        const later = settleBarren([`a`], first.firstSeen, new Set([`a`]), 10_000, 500);
        expect([...later.settled]).toEqual([]);
    });
});
