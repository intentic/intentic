import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { CHILDREN } from "../../child-records.js";
import type { ChildRecord, ChildSpawnSpec } from "../../children.js";
import { brokenChain, CHAIN_FAILURES_MOST, chainOf, retryLink } from "../retry-chains.js";
import { openSpawnedChild, resetSubagents, settleSpawnedChild } from "../../subagents.js";

/* 2026-11-24: a parent retried a failing task again and again, and nothing linked a respawn to the child it replaced. */

const actors = memoryFleet().conversations;
beforeEach(() => {
    resetSubagents(actors);
    actors.holdings(CHILDREN).clear();
});

const ask = (overrides: Partial<ChildSpawnSpec> = {}): ChildSpawnSpec => ({ prompt: "fix the flaky test", provider: "claude", model: "sonnet", ...overrides });

let clock = 1_000;
// A child of parent-1 as the spawn filed it, its roster row ended as `status` (with that error).
const child = (id: string, spec: ChildSpawnSpec, status: "failed" | "completed" | "killed" | "running", parent = "parent-1"): void => {
    clock += 1_000;
    // SAFETY: the chain reads only the parent, the spec and when it started.
    actors.holdings(CHILDREN).hold(parent, id, { parent, spec, startedAt: clock } as ChildRecord, id);
    openSpawnedChild({ conversationId: parent, conversations: actors, subagentsDir: undefined }, { id, description: spec.description ?? spec.prompt, provider: "claude" });
    if (status === "failed") {
        settleSpawnedChild(actors, id, { status, report: "", error: `worktree prep failed for ${id}` });
    } else if (status !== "running") {
        settleSpawnedChild(actors, id, { status, report: "" });
    }
};

// Each retry as the spawn makes it: the spec retryLink answers, filed under the new id.
const retry = (id: string, of: string, status: "failed" | "completed" | "killed" | "running"): void => {
    const linked = retryLink(actors, "parent-1", ask({ retryOf: of }));
    if ("refused" in linked) {
        throw new Error(linked.refused);
    }
    child(id, linked.spec, status);
};

test("a retry joins the chain of the child it names, whose task id is the chain's first child", () => {
    child("sub-a", ask(), "failed");
    const linked = retryLink(actors, "parent-1", ask({ retryOf: "sub-a" }));
    expect(linked).toMatchObject({ spec: { retryOf: "sub-a", taskId: "sub-a" }, note: expect.stringContaining("try 2") });
    retry("sub-b", "sub-a", "failed");
    expect(retryLink(actors, "parent-1", ask({ retryOf: "sub-b" }))).toMatchObject({ spec: { retryOf: "sub-b", taskId: "sub-a" } });
});

test("after three failures in a row the chain refuses another retry, telling the parent to stop and report", () => {
    child("sub-a", ask(), "failed");
    retry("sub-b", "sub-a", "failed");
    retry("sub-c", "sub-b", "failed");
    expect(CHAIN_FAILURES_MOST).toBe(3);
    expect(brokenChain(actors, "parent-1", "sub-a")).toEqual(["sub-c", "sub-b", "sub-a"]);
    const refused = retryLink(actors, "parent-1", ask({ retryOf: "sub-c" }));
    // Read before any asymmetric matcher touches it: bun's toMatchObject writes its matchers into what it received.
    const words = "refused" in refused ? refused.refused : "";
    expect(words).toContain("failed 3 times in a row");
    expect(words).toContain("Stop retrying it: report what failed");
    expect(words).toContain("worktree prep failed for sub-a");
    // Naming an earlier link of the same chain is the same chain.
    expect(retryLink(actors, "parent-1", ask({ retryOf: "sub-a" }))).toMatchObject({ refused: expect.stringContaining("failed 3 times") });
});

test("a completed child clears the streak; a cancelled one neither counts nor clears it", () => {
    child("sub-a", ask(), "failed");
    retry("sub-b", "sub-a", "completed");
    retry("sub-c", "sub-b", "failed");
    retry("sub-d", "sub-c", "failed");
    expect(brokenChain(actors, "parent-1", "sub-a")).toBeUndefined();
    retry("sub-e", "sub-d", "killed");
    expect(brokenChain(actors, "parent-1", "sub-a")).toBeUndefined();
    retry("sub-f", "sub-e", "failed");
    expect(brokenChain(actors, "parent-1", "sub-a")).toEqual(["sub-f", "sub-d", "sub-c"]);
});

test("a spawn that leaves retryOf out but reads as a broken chain's task is started with a warning", () => {
    child("sub-a", ask(), "failed");
    retry("sub-b", "sub-a", "failed");
    retry("sub-c", "sub-b", "failed");
    const fresh = retryLink(actors, "parent-1", ask());
    expect(fresh).toMatchObject({ note: expect.stringContaining("already failed 3 times in a row") });
    expect("spec" in fresh ? fresh.spec.taskId : "refused").toBeUndefined();
    // Another task is no such warning.
    expect(retryLink(actors, "parent-1", ask({ prompt: "write the docs" }))).toEqual({ spec: ask({ prompt: "write the docs" }) });
});

test("refuses a retry of no child of this parent's, or of one still under way; a caller's own task id is dropped", () => {
    child("sub-theirs", ask(), "failed", "parent-2");
    child("sub-live", ask(), "running");
    expect(retryLink(actors, "parent-1", ask({ retryOf: "sub-theirs" }))).toMatchObject({ refused: expect.stringContaining("no subagent of yours") });
    expect(retryLink(actors, "parent-1", ask({ retryOf: "sub-nope" }))).toMatchObject({ refused: expect.stringContaining("no subagent of yours") });
    expect(retryLink(actors, "parent-1", ask({ retryOf: "sub-live" }))).toMatchObject({ refused: expect.stringContaining("still running") });
    expect(retryLink(actors, "parent-1", ask({ prompt: "other", taskId: "sub-forged" }))).toEqual({ spec: ask({ prompt: "other" }) });
});

test("a chain's first child names the chain by its own id", () => {
    expect(chainOf("sub-a", { spec: ask() })).toBe("sub-a");
    expect(chainOf("sub-b", { spec: ask({ taskId: "sub-a" }) })).toBe("sub-a");
});
