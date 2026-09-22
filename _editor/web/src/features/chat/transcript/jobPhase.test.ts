import { describe, expect, it } from "bun:test";
import type { AgentJob } from "@intentic/sandbox-contract";
import { jobPhase, runningJobs } from "./jobPhase";

const job = (over: Partial<AgentJob> = {}): AgentJob => ({ id: `job-1`, label: `Build`, session: `agent-1`, startedAt: 1_000, ...over });

describe(`jobPhase`, () => {
    it(`reads a job with no end as running, in its own terminal`, () => {
        expect(jobPhase(job())).toEqual({ kind: `running`, startedAt: 1_000, session: `agent-1` });
    });

    it(`tells a clean exit from a failing one, and both from an exit that left no code`, () => {
        expect(jobPhase(job({ endedAt: 5_000, exitCode: 0 }))).toEqual({ kind: `finished`, took: [1_000, 5_000] });
        expect(jobPhase(job({ endedAt: 5_000, exitCode: 2 }))).toEqual({ kind: `failed`, exitCode: 2, took: [1_000, 5_000] });
        expect(jobPhase(job({ endedAt: 5_000 }))).toEqual({ kind: `ended`, took: [1_000, 5_000] });
    });

    it(`claims nothing about a job the card does not carry`, () => {
        expect(jobPhase(undefined)).toEqual({ kind: `untracked` });
    });
});

describe(`runningJobs`, () => {
    it(`keeps only the jobs still running, oldest first`, () => {
        const jobs = [
            job({ id: `late`, startedAt: 3_000 }),
            job({ id: `done`, startedAt: 500, endedAt: 900, exitCode: 0 }),
            job({ id: `early`, startedAt: 2_000 }),
        ];
        expect(runningJobs(jobs).map((entry) => entry.id)).toEqual([`early`, `late`]);
        expect(runningJobs(undefined)).toEqual([]);
    });
});
