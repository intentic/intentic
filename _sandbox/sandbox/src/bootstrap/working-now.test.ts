import { type WorkSnapshot, workOf } from "./working-now.js";

// What each moment waits for, read off one snapshot holding one of everything. The differences between purposes are the
// contract: a restart is cut by a turn, a land, a running subagent, a workflow's step and an extension's held work;
// stopping the machine strands a parked subagent and an armed watch besides.

const everything: WorkSnapshot = {
    turns: ["fix the login"],
    lands: ["ship the docs"],
    subagents: [
        { status: "running", name: "search the tree" },
        { status: "paused", name: "write the tests" },
        { status: "blocked", name: "ask about keys" },
        { status: "pending", name: "queued review" },
        { status: "completed", name: "done already" },
    ],
    workflows: ["nightly review"],
    watches: 2,
    holds: ["acme.maintenance: code-health probes"],
};

const nothing: WorkSnapshot = { turns: [], lands: [], subagents: [], workflows: [], watches: 0, holds: [] };

test("a restart waits for turns, lands, running subagents, workflows and held work, not for what survives it", () => {
    expect(workOf(everything, "restart")).toEqual([
        { kind: "turn", name: "fix the login" },
        { kind: "land", name: "ship the docs" },
        { kind: "subagent", name: "search the tree" },
        { kind: "workflow", name: "nightly review" },
        { kind: "extension", name: "acme.maintenance: code-health probes" },
    ]);
});

test("idle-stop waits for all of that, and for parked subagents and armed watches only this daemon moves on", () => {
    expect(workOf(everything, "idle-stop")).toEqual([
        { kind: "turn", name: "fix the login" },
        { kind: "land", name: "ship the docs" },
        { kind: "subagent", name: "search the tree" },
        { kind: "parked-subagent", name: "write the tests" },
        { kind: "parked-subagent", name: "ask about keys" },
        { kind: "parked-subagent", name: "queued review" },
        { kind: "workflow", name: "nightly review" },
        { kind: "watch", name: "an armed watch" },
        { kind: "watch", name: "an armed watch" },
        { kind: "extension", name: "acme.maintenance: code-health probes" },
    ]);
});

// The rebuild used to wait for turns alone, so it cut a land or a workflow step the update waited out.
test("a land or a workflow alone holds a restart", () => {
    expect(workOf({ ...nothing, lands: ["ship the docs"] }, "restart")).toEqual([{ kind: "land", name: "ship the docs" }]);
    expect(workOf({ ...nothing, workflows: ["nightly review"] }, "restart")).toEqual([{ kind: "workflow", name: "nightly review" }]);
});

// An extension's backend holding work in flight (`api.work.hold`) keeps the machine up and a restart waiting, as a turn does.
test("an extension's held work alone holds a restart and an idle stop", () => {
    const held = { ...nothing, holds: ["acme.deploys: deploying web to prod"] };
    expect(workOf(held, "restart")).toEqual([{ kind: "extension", name: "acme.deploys: deploying web to prod" }]);
    expect(workOf(held, "idle-stop")).toEqual([{ kind: "extension", name: "acme.deploys: deploying web to prod" }]);
});

test("a settled subagent and a quiet sandbox hold nothing", () => {
    expect(workOf({ ...nothing, subagents: [{ status: "completed", name: "done already" }] }, "idle-stop")).toEqual([]);
    expect(workOf(nothing, "restart")).toEqual([]);
});
