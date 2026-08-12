import { unstubbed } from "@intentic/testing";
import { beforeEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { describeLanding } from "./landed-subject.js";

const ask = vi.fn<() => Promise<{ text: string }>>();
vi.mock("../agent/quick-model.js", () => ({ askQuickModel: () => ask() }));

/* WHAT A USER IS TOLD WHILE THE SENTENCE IS BEING WRITTEN, AND IN WHAT ORDER — the only part of a landing
 * anybody ever waits for.
 *
 * The wait is real (the model call is seconds) and it is spent in exactly one place: the Changes panel, with
 * this agent's "From" chip lit, watching a box that says a message is coming. So the two writes this function
 * makes are a promise and its answer, and the ORDER of them is the whole contract — the flag may only stop
 * saying "writing…" once there is something to show for it. Cleared first, as it was while the flag and the
 * sentence travelled different roads, "your commit message is ready" lands over an empty box. */

// The events this function announces, in the order it announces them.
const steps: string[] = [];

const servicesWith = (): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => ({ id: "c1", repos: [{ repo: "root", base: "a".repeat(40) }] }) as ReturnType<Services["agents"]["entry"]>,
            setDraftingSubject: (_id, drafting) => void steps.push(drafting ? "drafting" : "done"),
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

test("writes the sentence before it stops saying one is coming", async () => {
    ask.mockResolvedValue({ text: "fix: cascading markers" });
    await describeLanding(servicesWith(), "c1");
    expect(steps).toEqual(["drafting", "wrote fix: cascading markers", "done"]);
});

// Every other road out of the model call ends the wait too, or a chip keeps saying "writing…" about a call that
// ended minutes ago — and it ends with nothing written, which is the honest answer to a draft that failed.
test("a refusal ends the wait with nothing written", async () => {
    ask.mockResolvedValue({ text: "I can't help with that." });
    await describeLanding(servicesWith(), "c1");
    expect(steps).toEqual(["drafting", "done"]);
});

test("a model call that throws ends the wait too", async () => {
    ask.mockRejectedValue(new Error("no quick model connected"));
    await expect(describeLanding(servicesWith(), "c1")).rejects.toThrow();
    expect(steps).toEqual(["drafting", "done"]);
});
