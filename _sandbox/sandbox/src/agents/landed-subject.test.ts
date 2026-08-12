import type { LandedMessageDraft } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { describeLanding } from "./landed-subject.js";

const ask = vi.fn<() => Promise<{ text: string }>>();
vi.mock("../agent/quick-model.js", () => ({ askQuickModel: () => ask() }));
vi.mock("../git/contract-shrink.js", () => ({ claimedContractShrink: async () => [] }));

/* WHAT A USER IS TOLD WHILE THE SENTENCE IS BEING WRITTEN, AND IN WHAT ORDER — the only part of a landing
 * anybody ever waits for.
 *
 * The wait is real (the model call is seconds) and it is spent in exactly one place: the Changes panel, with
 * this agent's "From" chip lit, reading the draft report. So the writes this function makes are a promise and
 * its answer, and the ORDER is the whole contract — the report may only end once there is something to show
 * for it. Ended first, as it once was when the flag and the sentence travelled different roads, "ready" lands
 * over an empty box. */

// The events this function announces, in the order it announces them.
const steps: string[] = [];

// The report's edges, reduced to words: opened (no outcome yet), and each outcome as it lands.
const noteDraft = (draft: LandedMessageDraft | undefined): void => {
    if (draft === undefined) {
        steps.push(`withdrawn`);
        return;
    }
    if (draft.outcome !== undefined) {
        steps.push(`ended ${draft.outcome}`);
        return;
    }
    if (steps.length === 0) {
        steps.push(`opened`);
    }
};

const servicesWith = (): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => ({ id: "c1", repos: [{ repo: "root", base: "a".repeat(40) }] }) as ReturnType<Services["agents"]["entry"]>,
            setLandedMessageDraft: (_id, draft) => noteDraft(draft),
            setLandedSubject: async (_id, draft) => void steps.push(`wrote ${draft.subject}`),
        }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { mainDir: () => "/work" }),
        agentOrigins: unstubbed<Services["agentOrigins"]>("agentOrigins", { forRepo: async () => ({ "a.ts": ["c1"] }) }),
        git: unstubbed<Services["git"]>("git", {
            collectRepoDiff: async () => ({ repo: "root", subjects: [], summary: "a.ts | 2 +-", blocks: [] }),
        }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ changelogRepos: [] }) as never }),
        perf: unstubbed<Services["perf"]>("perf", { track: async (_op, _fields, run) => run() }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => undefined }),
    });

beforeEach(() => {
    ask.mockReset();
    steps.length = 0;
});

test("opens the report at the land, writes the sentence, and only then says the draft ended", async () => {
    ask.mockResolvedValue({ text: "fix: cascading markers" });
    await describeLanding(servicesWith(), "c1");
    expect(steps).toEqual([`opened`, `wrote fix: cascading markers`, `ended written`]);
});

// Every other road out of the model call ends the report too, or a chip keeps saying "writing…" about a call
// that ended minutes ago — and it ends `failed` with nothing written, which is the honest answer.
test("a refusal ends the report as failed, with nothing written", async () => {
    ask.mockResolvedValue({ text: "I can't help with that." });
    await describeLanding(servicesWith(), "c1");
    expect(steps).toEqual([`opened`, `ended failed`]);
});

test("a model call that throws ends the report as failed too", async () => {
    ask.mockRejectedValue(new Error("no quick model connected"));
    await expect(describeLanding(servicesWith(), "c1")).rejects.toThrow();
    expect(steps).toEqual([`opened`, `ended failed`]);
});

// The failed report carries the one-line reason the surfaces with one line to spend will show.
test("the failed report names its reason", async () => {
    const reports: (LandedMessageDraft | undefined)[] = [];
    const services = servicesWith();
    (services.agents.setLandedMessageDraft as unknown) = (_id: string, draft: LandedMessageDraft | undefined): void => void reports.push(draft);
    ask.mockRejectedValue(new Error("gemini-3-flash: usage limit; gpt-5.6: usage limit"));

    await expect(describeLanding(services, "c1")).rejects.toThrow();

    expect(reports.at(-1)?.outcome).toBe(`failed`);
    expect(reports.at(-1)?.reason).toContain(`usage limit`);
    expect(reports.at(-1)?.finishedAt).toBeDefined();
});
