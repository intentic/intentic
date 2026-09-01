import type { PipelineJob } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { jobLineage, pipelineDag, pipelineStages } from "./pipelineDag";

/* What the expanded job graph claims about a run: which cards fade, which edges light, and, the part that
 * matters most: that a run arriving WITH its dependencies declared is drawn from those and not from a guess
 * about what overlapped in time. The two sources of shape are tested side by side because the fallback has to
 * keep working exactly as it did for every run whose workflow file we cannot read.
 *
 * The graph groups identically-wired jobs into one compound card, so the assertions below cover both halves of
 * that: fewer cards and fewer edges than there are jobs, and a trace that still counts JOBS. The count is the
 * half worth guarding, it is what the caption says out loud, and grouping is the one change that could quietly
 * turn "four ran before" into "one". */

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

/* The shape that prompted all of this: the user's own ci.yml, which the wave layering rendered as a flat
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
    it(`draws one edge per declared dependency, not a stage-wide join`, () => {
        // Every job in declaredRun has a unique edge signature, so no clustering happens and each job is
        // its own cluster node. The edges are identical to the pre-clustering output.
        const edges = pipelineDag(declaredRun).edges.map((edge) => `${edge.from}>${edge.to}`);
        expect(edges.toSorted()).toEqual([`0:0>1:0`, `0:0>1:1`, `0:1>3:0`, `1:0>2:0`, `2:0>3:0`]);
    });

    it(`traces one leg of a fan-out without lighting its sibling's parents`, () => {
        // Hovering `verify-site / verify` (1:1): its parent preflight and nothing of the images/release line.
        const dag = pipelineDag(declaredRun, `1:1`);
        // Each job is its own cluster, so dimmed cluster nodes map 1:1 to dimmed jobs.
        const dimmedNames = dag.nodes
            .filter((node) => node.dimmed === true)
            .flatMap((node) => node.data.jobs.map((m) => m.job.name))
            .toSorted();
        expect(dimmedNames).toEqual([`changes`, `images`, `release`, `verify-core / verify`]);
        expect(dag.trace).toMatchObject({ before: 1, after: 0 });
    });

    it(`reaches transitively both ways from a job in the middle`, () => {
        // `images` (2:0): preflight → verify-core → images → release.
        const dag = pipelineDag(declaredRun, `2:0`);
        expect(dag.trace).toMatchObject({ before: 2, after: 1 });
        const traced = dag.edges.filter((edge) => edge.accent === `text-link`).map((edge) => `${edge.from}>${edge.to}`);
        expect(traced.toSorted()).toEqual([`0:0>1:0`, `1:0>2:0`, `2:0>3:0`]);
        // `changes → release` has both ends related to nothing on this line and must stay dark.
        expect(dag.edges.find((edge) => edge.from === `0:1`)?.dimmed).toBe(true);
    });
});

describe(`pipelineDag with only stages`, () => {
    it(`clusters jobs with identical edges into compound nodes`, () => {
        // build[lint, compile] share incoming=none, outgoing={1:0, 1:1} → one cluster.
        // test[unit, e2e] share incoming={0:0, 0:1}, outgoing={2:0} → one cluster.
        // deploy[ship] is alone.
        const dag = pipelineDag(stageRun);
        expect(dag.nodes).toHaveLength(3);
        // Cluster 0:0 holds both build jobs, 1:0 holds both test jobs, 2:0 is ship.
        expect(dag.nodes.map((n) => n.data.jobs.map((m) => m.job.name))).toEqual([[`lint`, `compile`], [`unit`, `e2e`], [`ship`]]);
        // Only two edges: build-cluster → test-cluster → deploy-cluster.
        expect(dag.edges).toHaveLength(2);
        expect(dag.edges.map((e) => `${e.from}>${e.to}`)).toEqual([`0:0>1:0`, `1:0>2:0`]);
        expect(dag.nodes.every((node) => node.dimmed === undefined)).toBe(true);
        expect(dag.edges.every((edge) => edge.dimmed === undefined && edge.accent === undefined)).toBe(true);
        expect(dag.trace).toBeUndefined();
    });

    it(`fades unrelated clusters when a job is focused`, () => {
        // Focusing unit (1:0): the test cluster contains the focus, so it stays lit. The build and deploy
        // clusters are on the line too (build → test → deploy), so nothing fades in this linear pipeline.
        const dag = pipelineDag(stageRun, `1:0`);
        expect(dag.nodes.filter((node) => node.dimmed === true)).toEqual([]);
        // Lineage counts individual jobs, not clusters: 2 build jobs before, 1 deploy job after.
        expect(dag.trace).toMatchObject({ before: 2, after: 1 });
    });

    it(`traces edges on the focused cluster's line`, () => {
        const dag = pipelineDag(stageRun, `1:0`);
        const traced = dag.edges.filter((edge) => edge.accent === `text-link`).map((edge) => `${edge.from}>${edge.to}`);
        // Both cluster edges are on the line (linear pipeline).
        expect(traced.toSorted()).toEqual([`0:0>1:0`, `1:0>2:0`]);
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

    it(`draws a run with no edges at all as one card rather than a row of unrelated boxes`, () => {
        // A single stage: nothing waited on anything, so every job carries the same (empty) edge signature.
        const run = pipelineStages([staged(`unit`, `test`), staged(`e2e`, `test`), staged(`lint`, `test`)]);
        const dag = pipelineDag(run);
        expect(dag.nodes.map((node) => node.data.jobs.map((member) => member.job.name))).toEqual([[`unit`, `e2e`, `lint`]]);
        expect(dag.edges).toEqual([]);
    });

    it(`preserves every job inside cluster nodes`, () => {
        // Every job that went in must appear exactly once in some cluster's members.
        for (const run of [stageRun, declaredRun]) {
            const allJobs = run.flatMap((stage) => stage.jobs.map((job) => job.name)).toSorted();
            const clusteredJobs = pipelineDag(run)
                .nodes.flatMap((node) => node.data.jobs.map((m) => m.job.name))
                .toSorted();
            expect(clusteredJobs).toEqual(allJobs);
        }
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
