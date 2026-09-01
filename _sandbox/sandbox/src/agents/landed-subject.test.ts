import type { LandedMessageDraft } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { describeLanding } from "./landed-subject.js";

const ask = vi.fn<() => Promise<{ value: { subject: string; note: string; breaking: string } }>>();
vi.mock("../agent/quick-model.js", () => ({ askQuickModel: () => ask() }));
vi.mock("../git/contract-shrink.js", () => ({ claimedContractShrink: async () => [] }));

/* WHAT A USER IS TOLD WHILE THE SENTENCE IS BEING WRITTEN, AND IN WHAT ORDER: the only part of a landing
 * anybody ever waits for.
 *
 * The wait is real (the model call is seconds) and it is spent in exactly one place: the Changes panel, with
 * this agent's "From" chip lit, reading the draft report. So the writes this function makes are a promise and
 * its answer, and the ORDER is the whole contract: the report may only end once there is something to show
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
    ask.mockResolvedValue({ value: { subject: "fix: cascading markers", note: "", breaking: "" } });
    await describeLanding(servicesWith(), "c1");
    expect(steps).toEqual([`opened`, `wrote fix: cascading markers`, `ended written`]);
});

/* EVERY OTHER ROAD OUT OF THE MODEL CALL ENDS THE REPORT TOO, or a chip keeps saying "writing…" about a call that
 * ended minutes ago, and it ends `failed` with nothing written, which is the honest answer.
 *
 * All of them arrive as a throw now: nothing connected, a chain spent to the bottom, and a chain that answered
 * but never with a subject (a tool-call stand-in, a question back, its provider's own refusal as prose). That
 * last one used to be checked here, after the walk was over, which meant one misbehaving rung ended the landing
 * while working accounts below it went unasked. The ask decides it now (quick-answer.ts). */
test.each([
    ["nothing connected", "no quick model connected"],
    ["a rung that wrote a tool call", "gemini-3.5-flash: wrote a tool call instead of a commit subject"],
])("%s ends the report as failed, with nothing written", async (_case, message) => {
    ask.mockRejectedValue(new Error(message));
    await expect(describeLanding(servicesWith(), "c1")).rejects.toThrow(message);
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
    expect(reports.at(-1)?.finishedAt).toEqual(expect.any(Number));
});
