import type { PipelineRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { inFlightNote } from "./ciAttention";

// The rail's other sentence: not "is this branch red" (ciStreaks) but "is CI doing anything right now". It must count
// the way the board's own tally counts, or the tile and the header it opens would disagree about the same runs.

const run = (runId: number, status: PipelineRun["status"]): PipelineRun => ({
    repo: "intentic",
    host: "github",
    project: "intentic/intentic",
    runId,
    branch: "main",
    sha: `sha${runId}`,
    status,
    url: "u",
    createdAt: runId,
});

test("says nothing while every run has landed", () => {
    expect(inFlightNote([run(1, "success"), run(2, "failed"), run(3, "canceled")])).toBeUndefined();
    expect(inFlightNote([])).toBeUndefined();
});

test("counts running runs, in the board's own words", () => {
    expect(inFlightNote([run(1, "running"), run(2, "success")])).toBe("1 running");
    expect(inFlightNote([run(1, "running"), run(2, "running")])).toBe("2 running");
});

test("keeps queued out of the running count, and still reports it", () => {
    // The board makes the same split: nothing has picked the queued run up, so calling it running would be a claim
    // about a runner that hasn't started.
    expect(inFlightNote([run(1, "queued")])).toBe("1 queued");
    expect(inFlightNote([run(1, "running"), run(2, "queued"), run(3, "queued")])).toBe("1 running, 2 queued");
});

test("a broken branch does not silence it: the fix's own re-run is what the reader is waiting on", () => {
    expect(inFlightNote([run(1, "failed"), run(2, "running")])).toBe("1 running");
});
