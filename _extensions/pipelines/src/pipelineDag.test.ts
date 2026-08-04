import type { PipelineJob } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { jobLineage, pipelineDag, pipelineStages } from "./pipelineDag";

/* What the expanded job graph claims about a run: which cards fade, which edges light, and — the part that
 * matters most — that a run arriving WITH its dependencies declared is drawn from those and not from a guess
 * about what overlapped in time. The two sources of shape are tested side by side because the fallback has to
 * keep working exactly as it did for every run whose workflow file we cannot read. */

const staged = (name: string, stage: string): PipelineJob => ({ name, status: `success`, stage });
const declared = (name: string, needs: string[], startedAt: number): PipelineJob => ({
    name,
    status: `success`,
    needs,
    startedAt,
    finishedAt: startedAt + 1_000,
});

// GitLab's shape: build[lint, compile] → test[unit, e2e] → deploy[ship]
const stageRun = pipelineStages([
    staged(`lint`, `build`),
    staged(`compile`, `build`),
    staged(`unit`, `test`),
    staged(`e2e`, `test`),
    staged(`ship`, `deploy`),
]);

/* The shape that prompted all of this — the user's own ci.yml, which the wave layering rendered as a flat
 * line. Every job here starts at a DIFFERENT time and none overlap, so timestamps alone would put all six in
 * six sequential steps; `needs` is what makes it branch. */
const declaredRun = pipelineStages([
    declared(`preflight`, [], 0),
    declared(`changes`, [], 10_000),
    declared(`verify-core / verify`, [`preflight`], 20_000),
    declared(`verify-site / verify`, [`preflight`], 30_000),
    declared(`images`, [`verify-core / verify`], 40_000),
    declared(`release`, [`images`, `changes`], 50_000),
]);

describe(`pipelineStages`, () => {
    it(`layers a declared run by dependency depth, not by when things happened to start`, () => {
        // Six jobs that never overlap would be six waves. Declared, they are four levels that branch.
        expect(declaredRun.map((stage) => stage.jobs.map((job) => job.name))).toEqual([
            [`preflight`, `changes`],
            [`verify-core / verify`, `verify-site / verify`],
            [`images`],
            [`release`],
        ]);
    });

    it(`still groups by vendor stage when nothing is declared`, () => {
        expect(stageRun.map((stage) => stage.name)).toEqual([`build`, `test`, `deploy`]);
    });

    it(`falls back to execution waves when there is neither`, () => {
        const overlapping: PipelineJob[] = [
            { name: `a`, status: `success`, startedAt: 0, finishedAt: 100 },
            { name: `b`, status: `success`, startedAt: 10, finishedAt: 90 },
            { name: `c`, status: `success`, startedAt: 200, finishedAt: 300 },
        ];
        expect(pipelineStages(overlapping).map((stage) => stage.jobs.map((job) => job.name))).toEqual([[`a`, `b`], [`c`]]);
    });
});

describe(`pipelineDag with declared dependencies`, () => {
    it(`draws one edge per declared dependency — not a stage-wide join`, () => {
        const edges = pipelineDag(declaredRun).edges.map((edge) => `${edge.from}>${edge.to}`);
        // `changes` sits in level 0 beside `preflight` but gates only `release`; a bipartite join would have
        // wired it into both level-1 verifies.
        expect(edges.toSorted()).toEqual([`0:0>1:0`, `0:0>1:1`, `0:1>3:0`, `1:0>2:0`, `2:0>3:0`]);
    });

    it(`traces one leg of a fan-out without lighting its sibling's parents`, () => {
        // Hovering `verify-site / verify` (1:1): its parent preflight and nothing of the images/release line.
        const dag = pipelineDag(declaredRun, `1:1`);
        expect(
            dag.nodes
                .filter((node) => node.dimmed === true)
                .map((node) => node.data.name)
                .toSorted(),
        ).toEqual([`changes`, `images`, `release`, `verify-core / verify`]);
        expect(dag.lineage).toMatchObject({ before: 1, after: 0 });
    });

    it(`reaches transitively both ways from a job in the middle`, () => {
        // `images` (2:0): preflight → verify-core → images → release.
        const dag = pipelineDag(declaredRun, `2:0`);
        expect(dag.lineage).toMatchObject({ before: 2, after: 1 });
        const traced = dag.edges.filter((edge) => edge.accent === `text-link`).map((edge) => `${edge.from}>${edge.to}`);
        expect(traced.toSorted()).toEqual([`0:0>1:0`, `1:0>2:0`, `2:0>3:0`]);
        // `changes → release` has both ends related to nothing on this line and must stay dark.
        expect(dag.edges.find((edge) => edge.from === `0:1`)?.dimmed).toBe(true);
    });
});

describe(`pipelineDag with only stages`, () => {
    it(`joins every job of a stage to every job of the next`, () => {
        const dag = pipelineDag(stageRun);
        expect(dag.edges).toHaveLength(2 * 2 + 2 * 1);
        expect(dag.nodes.every((node) => node.dimmed === undefined)).toBe(true);
        expect(dag.edges.every((edge) => edge.dimmed === undefined && edge.accent === undefined)).toBe(true);
        expect(dag.lineage).toBeUndefined();
    });

    it(`fades the focused job's stage-mates and nothing else`, () => {
        // The strongest true statement this shape supports: everything in an earlier or later stage is related.
        const dag = pipelineDag(stageRun, `1:0`);
        expect(dag.nodes.filter((node) => node.dimmed === true).map((node) => node.id)).toEqual([`1:1`]);
        expect(dag.lineage).toMatchObject({ before: 2, after: 1 });
    });

    it(`traces only the edges whose both ends are on the line`, () => {
        const dag = pipelineDag(stageRun, `1:0`);
        const traced = dag.edges.filter((edge) => edge.accent === `text-link`).map((edge) => `${edge.from}>${edge.to}`);
        expect(traced.toSorted()).toEqual([`0:0>1:0`, `0:1>1:0`, `1:0>2:0`]);
        expect(dag.edges.filter((edge) => edge.dimmed === true).length).toBe(dag.edges.length - traced.length);
    });
});

describe(`pipelineDag invariants`, () => {
    it(`keeps ids and endpoints identical whatever is focused, so a hover cannot re-lay-out the graph`, () => {
        for (const run of [stageRun, declaredRun]) {
            const shape = (focus?: string): string[] => pipelineDag(run, focus).edges.map((edge) => `${edge.from}>${edge.to}`);
            expect(shape(`1:0`)).toEqual(shape());
            expect(pipelineDag(run, `1:0`).nodes.map((node) => node.id)).toEqual(pipelineDag(run).nodes.map((node) => node.id));
        }
    });

    it(`drops a declared dependency on a job that never ran rather than drawing an edge to nothing`, () => {
        const run = pipelineStages([declared(`build`, [], 0), declared(`ship`, [`build`, `never-ran`], 10_000)]);
        expect(pipelineDag(run).edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([`0:0>1:0`]);
    });

    it(`survives a workflow that declares a cycle`, () => {
        const run = pipelineStages([declared(`a`, [`b`], 0), declared(`b`, [`a`], 10_000)]);
        expect(
            run
                .flatMap((stage) => stage.jobs)
                .map((job) => job.name)
                .toSorted(),
        ).toEqual([`a`, `b`]);
        expect(() => pipelineDag(run, `0:0`)).not.toThrow();
    });
});

describe(`jobLineage`, () => {
    it(`collects the edges it walked, not every edge between related nodes`, () => {
        // a → b → c and a → c: the bypass a→c is real, and IS on a path through neither b nor... it is on a
        // path through `a` and `c` themselves, so focusing `b` must leave it out.
        const links = [
            { from: `a`, to: `b` },
            { from: `b`, to: `c` },
            { from: `a`, to: `c` },
        ];
        const lineage = jobLineage(links, `b`);
        expect([...lineage.nodes].toSorted()).toEqual([`a`, `b`, `c`]);
        expect([...lineage.links].toSorted()).toEqual([`a>b`, `b>c`]);
    });
});
