import type { LandedMessageDraft } from "@intentic/sandbox-contract/schemas/agents";
import { overdue, progressShare } from "../../../../components/progress/progress";
import { draftProgress, mergeSamples, paceSample, type PaceSample } from "./draftPace";

// The commit field's ring fills against how long drafts usually take. What is pinned: which drafts teach it, which of
// them a running draft is measured against, and that a wait past the usual time stops promising instead of sitting
// at 99%.

const written = (startedAt: number, ms: number, model = `sonnet`): LandedMessageDraft => ({
    startedAt,
    steps: [{ provider: `claude`, model, status: `answered`, at: startedAt + 500, ms: ms - 500 }],
    outcome: `written`,
    finishedAt: startedAt + ms,
});

const sample = (startedAt: number, ms: number, model = `claude/sonnet`): PaceSample => ({ model, startedAt, ms });

test(`only a written draft is a sample, timed start to sentence and named for the model that answered`, () => {
    expect(paceSample(written(1000, 8000))).toEqual(sample(1000, 8000));
    expect(paceSample(undefined)).toBeUndefined();
    expect(paceSample({ startedAt: 1, steps: [] })).toBeUndefined();
    expect(paceSample({ startedAt: 1, steps: [], outcome: `failed`, reason: `no model`, finishedAt: 9 })).toBeUndefined();
});

test(`samples merge one per draft, oldest first, and an unchanged roster keeps the very same records`, () => {
    const stored = [sample(1, 5000), sample(2, 6000)];
    const merged = mergeSamples(stored, [sample(2, 6000), sample(3, 7000)]);
    expect(merged.map((entry) => entry.startedAt)).toEqual([1, 2, 3]);
    expect(merged[1]).toBe(stored[1]);
    expect(mergeSamples([], Array.from({ length: 40 }, (_, index) => sample(index, 1000))).length).toBe(24);
});

test(`a running draft fills against the median of recent drafts, preferring the model being asked`, () => {
    const samples = [sample(1, 4000), sample(2, 30_000, `codex/gpt`), sample(3, 6000), sample(4, 8000)];
    const running: LandedMessageDraft = {
        startedAt: 10_000,
        steps: [{ provider: `claude`, model: `sonnet`, status: `asking`, at: 10_400 }],
    };
    // claude/sonnet's own drafts: 4s, 6s, 8s → 6s.
    expect(draftProgress(running, 13_000, samples)).toEqual({ elapsedMs: 3000, expectedMs: 6000, giveUpMs: undefined, measured: undefined });
    // Still reading the diff, no model yet: every recent draft counts (4, 30, 6, 8 → 7s).
    expect(draftProgress({ startedAt: 10_000, steps: [] }, 13_500, samples)?.expectedMs).toBe(7000);
});

test(`the ring is the shared estimate: short of full at the usual time, and past it no longer a promise`, () => {
    const atUsual = draftProgress({ startedAt: 0, steps: [] }, 6000, [sample(1, 6000)]);
    expect(atUsual === undefined ? undefined : overdue(atUsual)).toBe(false);
    expect(atUsual && progressShare(atUsual)).toBeLessThan(0.95);
    const late = draftProgress({ startedAt: 0, steps: [] }, 9000, [sample(1, 6000)]);
    expect(late === undefined ? undefined : overdue(late)).toBe(true);
});

test(`time spent on a model that refused is added, so the fallback starts its own stretch`, () => {
    const draft: LandedMessageDraft = {
        startedAt: 0,
        steps: [
            { provider: `codex`, model: `gpt`, status: `refused`, at: 1000, ms: 5000, reason: `quota` },
            { provider: `claude`, model: `sonnet`, status: `asking`, at: 6000 },
        ],
    };
    // Expected 4s usual + 5s detour = 9s.
    expect(draftProgress(draft, 4500, [sample(1, 4000)])?.expectedMs).toBe(9000);
});

test(`nothing learned yet, or nothing running, leaves the mark to spin`, () => {
    expect(draftProgress({ startedAt: 0, steps: [] }, 1000, [])).toBeUndefined();
    expect(draftProgress(written(0, 1000), 2000, [sample(1, 4000)])).toBeUndefined();
    expect(draftProgress(undefined, 2000, [sample(1, 4000)])).toBeUndefined();
});
