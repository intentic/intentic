import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { waitForSubagents } from "../subagent-waits.js";
import { openSpawnedChild, resetSubagents, settleSpawnedChild } from "../../subagents.js";

/* A WAIT ON SEVERAL CHILDREN AS ONE. 2026-10-17: a parent waited on "any" over seven children and was woken once per
   child, each wake a model call on a context past 300K tokens. Named together, they come back once: early for trouble,
   otherwise when every one has finished. */

const actors = memoryFleet().conversations;
const turn = { conversationId: "parent-1", conversations: actors, subagentsDir: undefined };

beforeEach(() => resetSubagents(actors));

const spawn = (...ids: readonly string[]): void => {
    for (const id of ids) {
        openSpawnedChild(turn, { id, description: id });
    }
};

test("comes back once, when every child named has finished, with all of them", async () => {
    spawn("sub-a", "sub-b");
    const parked = waitForSubagents(actors, "parent-1", { targets: ["sub-a", "sub-b"], timeoutMs: 5_000 });
    settleSpawnedChild(actors, "sub-a", { status: "completed", report: "a done" });
    settleSpawnedChild(actors, "sub-b", { status: "completed", report: "b done" });
    const result = await parked;
    expect(result.outcome).toBe("finished");
    expect(result.agents.map((agent) => [agent.id, agent.status])).toEqual([
        ["sub-a", "completed"],
        ["sub-b", "completed"],
    ]);
});

test("comes back early for a child that failed, naming it, and not again for the same failure", async () => {
    spawn("sub-a", "sub-b");
    const parked = waitForSubagents(actors, "parent-1", { timeoutMs: 5_000 });
    settleSpawnedChild(actors, "sub-a", { status: "failed", report: "", error: "refused" });
    const early = await parked;
    expect(early).toMatchObject({ outcome: "failed", matched: { id: "sub-a", status: "failed" } });
    // The next wait on the same children waits for the other one, rather than handing the failure over again.
    const next = waitForSubagents(actors, "parent-1", { targets: ["sub-a", "sub-b"], timeoutMs: 5_000 });
    settleSpawnedChild(actors, "sub-b", { status: "completed", report: "b done" });
    await expect(next).resolves.toMatchObject({ outcome: "finished" });
});

test("answers at once when none of the named is this conversation's", async () => {
    await expect(waitForSubagents(actors, "parent-1", { targets: ["sub-nobody"], timeoutMs: 5_000 })).resolves.toEqual({
        outcome: "unknown-target",
        agents: [],
    });
});

test("on timeout says where every child stands", async () => {
    spawn("sub-a");
    await expect(waitForSubagents(actors, "parent-1", { targets: ["sub-a"], timeoutMs: 10 })).resolves.toMatchObject({
        outcome: "timeout",
        agents: [{ id: "sub-a", status: "running" }],
    });
});
