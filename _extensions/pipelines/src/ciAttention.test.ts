import type { PipelineRun } from "@intentic/sandbox-contract";
import { attentionBadge, inFlightNote } from "./ciAttention";

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

// THE TILE AS A WHOLE: a broken branch is the count, in the rail's only danger tone, and what is in flight rides beside
// it rather than being hidden by it.
describe(`attentionBadge`, () => {
    it(`stands down while nothing is broken or moving`, () => {
        expect(attentionBadge([run(1, "success")])).toBeUndefined();
        expect(attentionBadge([])).toBeUndefined();
    });

    it(`counts broken branches in the danger tone, and names the one there is`, () => {
        expect(attentionBadge([run(2, "failed")])).toEqual({
            count: 1,
            tone: "danger",
            tooltip: "intentic main is failing: 1 failed run on sha2",
        });
    });

    it(`keeps the running mark beside the count, and alone once nothing is broken`, () => {
        expect(attentionBadge([run(1, "failed"), run(2, "running")])).toEqual({
            count: 1,
            tone: "danger",
            tooltip: "intentic main is failing: 1 failed run on sha1",
            running: "1 running",
        });
        expect(attentionBadge([run(1, "running")])).toEqual({ running: "1 running" });
    });
});
