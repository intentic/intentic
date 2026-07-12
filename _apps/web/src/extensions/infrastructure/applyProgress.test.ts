import { describe, expect, it } from "vitest";
import { type ApplyProgressState, initialApplyState, reduceApplyLine } from "./applyProgress";

const reduceAll = (lines: Record<string, unknown>[]): ApplyProgressState => lines.reduce(reduceApplyLine, initialApplyState());

// A representative apply → adopt run: start marker, two resources (one still in flight), a readiness gate that
// goes live, two reconcile iterations converging, the result summary, then both commands' exits — apply's ends
// the per-resource phase, adopt's ends the whole job.
const RUN: Record<string, unknown>[] = [
    { kind: `start`, startedAt: 1 },
    { kind: `node`, phase: `apply`, state: `start`, id: `db.production`, type: `deployment`, action: `create` },
    { kind: `node`, phase: `apply`, state: `done`, id: `db.production`, type: `deployment`, action: `create` },
    { kind: `node`, phase: `apply`, state: `start`, id: `shop.production`, type: `deployment`, action: `update` },
    { kind: `readiness`, state: `waiting`, id: `shop.production`, url: `https://shop.example.com` },
    { kind: `readiness`, state: `ready`, id: `shop.production`, url: `https://shop.example.com` },
    { kind: `iteration`, n: 1, converged: false },
    { kind: `iteration`, n: 2, converged: true },
    { kind: `result`, converged: true, iterations: 2 },
    { kind: `exit`, command: `apply`, code: 0 },
    { kind: `exit`, command: `adopt`, code: 0 },
];

describe(`reduceApplyLine`, () => {
    it(`folds an apply run into per-resource + readiness + convergence state`, () => {
        const state = reduceAll(RUN);
        expect([...state.nodes.values()]).toEqual([
            { id: `db.production`, type: `deployment`, state: `done`, action: `create`, reason: undefined },
            { id: `shop.production`, type: `deployment`, state: `start`, action: `update`, reason: undefined },
        ]);
        expect([...state.readiness.values()]).toEqual([{ id: `shop.production`, state: `ready`, url: `https://shop.example.com` }]);
        expect(state.iterations).toEqual([
            { n: 1, converged: false },
            { n: 2, converged: true },
        ]);
        expect(state.converged).toBe(true);
        expect(state.applyPhaseDone).toBe(true);
        expect(state.jobDone).toBe(true);
        expect(state.error).toBeUndefined();
    });

    it(`apply's clean exit ends only the per-resource phase; adopt's exit (or a failed apply's) ends the job`, () => {
        const applyDone = reduceAll(RUN.slice(0, RUN.length - 1));
        expect(applyDone.applyPhaseDone).toBe(true);
        expect(applyDone.jobDone).toBe(false); // adopt still running
        expect(reduceAll([{ kind: `exit`, command: `apply`, code: 1 }]).jobDone).toBe(true); // && — adopt never runs
        expect(reduceAll([{ kind: `exit`, code: 0 }]).jobDone).toBe(true); // untagged exit ends everything
    });

    it(`a resolve-prefixed chain (service capability) keeps both phases open through resolve's clean exit`, () => {
        const resolved = reduceAll([{ kind: `exit`, command: `resolve`, code: 0 }]);
        expect(resolved.applyPhaseDone).toBe(false); // the per-resource phase hasn't started yet
        expect(resolved.jobDone).toBe(false);
        expect(resolved.error).toBeUndefined();
        const failed = reduceAll([{ kind: `exit`, command: `resolve`, code: 1 }]);
        expect(failed.jobDone).toBe(true); // && — nothing after a failed resolve
        expect(failed.error).toContain(`Resolve failed`);
    });

    it(`rebuilds identical state on replay — a refresh mid-apply re-reads the file from its start`, () => {
        // The daemon tail replays from {kind:"start"}; reducing the same lines is deterministic.
        expect(reduceAll(RUN)).toEqual(reduceAll(RUN));
        // A page refreshed mid-run holds partial state; replaying the full run (which begins with the start
        // marker) on top of it rebuilds the identical full state — no double-counting, no stale rows.
        const cut = reduceAll(RUN.slice(0, 5));
        expect(cut.nodes.size).toBe(2);
        expect(cut.applyPhaseDone).toBe(false);
        expect(RUN.reduce(reduceApplyLine, cut)).toEqual(reduceAll(RUN));
    });

    it(`resets on the start marker so a new run doesn't inherit the previous run's rows`, () => {
        const carried = reduceAll([...RUN, { kind: `start`, startedAt: 2 }]);
        expect(carried).toEqual(initialApplyState());
    });

    it(`records which command failed on a non-zero exit and keeps a stream error verbatim`, () => {
        expect(reduceAll([{ kind: `exit`, command: `apply`, code: 1 }]).error).toContain(`Apply failed`);
        expect(reduceAll([{ kind: `exit`, command: `adopt`, code: 1 }]).error).toContain(`Adopt failed`);
        const withError = reduceAll([
            { kind: `error`, message: `missing secret env var "STRIPE_API_KEY"` },
            { kind: `exit`, code: 1 },
        ]);
        // The reducer humanizes the stream error and the later exit doesn't overwrite it.
        expect(withError.error).toContain(`STRIPE_API_KEY`);
    });

    it(`upserts a node reported done without a prior start, and ignores heartbeats`, () => {
        const state = reduceAll([
            { kind: `heartbeat` },
            { kind: `node`, phase: `apply`, state: `done`, id: `route.production`, action: `noop` },
            { kind: `heartbeat` },
        ]);
        expect([...state.nodes.values()]).toEqual([{ id: `route.production`, type: undefined, state: `done`, action: `noop`, reason: undefined }]);
    });
});
