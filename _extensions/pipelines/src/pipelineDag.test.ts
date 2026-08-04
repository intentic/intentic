import type { PipelineJob } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { lineageCounts, onJobLine, pipelineDag, pipelineStages } from "./pipelineDag";

/* The highlight the expanded job graph runs on. What is worth pinning down is the SHAPE of a job's line —
 * which cards fade and which edges light — because that is the claim the picture makes about a run, and it is
 * derived from stage position rather than from any declared dependency. */

const job = (name: string, stage: string): PipelineJob => ({ name, status: `success`, stage });

// build[lint, compile] → test[unit, e2e] → deploy[ship]
const stages = pipelineStages([job(`lint`, `build`), job(`compile`, `build`), job(`unit`, `test`), job(`e2e`, `test`), job(`ship`, `deploy`)]);

describe(`onJobLine`, () => {
    it(`keeps every job of an earlier or later stage`, () => {
        // Focus `unit` (1:0): both of build's jobs led to it, and deploy waited on it.
        expect(onJobLine(`0:0`, `1:0`)).toBe(true);
        expect(onJobLine(`0:1`, `1:0`)).toBe(true);
        expect(onJobLine(`2:0`, `1:0`)).toBe(true);
    });

    it(`drops the jobs that merely ran alongside it`, () => {
        // `e2e` shares a stage with `unit` — same moment, no relation, so it is what fades.
        expect(onJobLine(`1:1`, `1:0`)).toBe(false);
        expect(onJobLine(`1:0`, `1:0`)).toBe(true);
    });
});

describe(`pipelineDag`, () => {
    it(`leaves every card lit and edges tinted by status with nothing focused`, () => {
        const dag = pipelineDag(stages);
        expect(dag.nodes.every((node) => node.dimmed === undefined)).toBe(true);
        expect(dag.edges.every((edge) => edge.dimmed === undefined && edge.accent === undefined)).toBe(true);
    });

    it(`fades the focused job's stage-mates and nothing else`, () => {
        const dag = pipelineDag(stages, `1:0`);
        expect(dag.nodes.filter((node) => node.dimmed === true).map((node) => node.id)).toEqual([`1:1`]);
    });

    it(`traces only the edges whose both ends are on the line`, () => {
        const dag = pipelineDag(stages, `1:0`);
        const traced = dag.edges.filter((edge) => edge.accent === `text-link`).map((edge) => `${edge.from}>${edge.to}`);
        // Into `unit` from both build jobs, and out of it into deploy — never through `e2e`.
        expect(traced.toSorted()).toEqual([`0:0>1:0`, `0:1>1:0`, `1:0>2:0`]);
        expect(dag.edges.filter((edge) => edge.dimmed === true).length).toBe(dag.edges.length - traced.length);
    });

    it(`keeps ids and endpoints identical whatever is focused, so a hover cannot re-lay-out the graph`, () => {
        const shape = (focus?: string): string[] => pipelineDag(stages, focus).edges.map((edge) => `${edge.from}>${edge.to}`);
        expect(shape(`1:0`)).toEqual(shape());
        expect(pipelineDag(stages, `1:0`).nodes.map((node) => node.id)).toEqual(pipelineDag(stages).nodes.map((node) => node.id));
    });
});

describe(`lineageCounts`, () => {
    it(`counts jobs, not stages, on each side of the focused one`, () => {
        expect(lineageCounts(stages, `1:0`)).toEqual({ before: 2, after: 1 });
        expect(lineageCounts(stages, `0:0`)).toEqual({ before: 0, after: 3 });
        expect(lineageCounts(stages, `2:0`)).toEqual({ before: 4, after: 0 });
    });
});
