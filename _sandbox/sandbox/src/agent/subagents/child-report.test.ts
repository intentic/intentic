import { WORKSPACE_ROOT } from "@intentic/constants";
import { agentWordsOf, type AgentTurn } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { beforeEach, describe, expect, it } from "bun:test";
import type { Steer } from "../checkpoints/agent-steering.js";
import { childActor } from "../run/turn/turn-actor.js";
import type { TurnSettled } from "../run/turn/turn-runs.js";
import { type ChildReportDeps, reportChildTurn } from "./child-report.js";
import { openSpawnedChild, resetSubagents, settleSpawnedChild, waitForSubagent } from "./subagents.js";

// A child's ending reaches its parent once, and only when it is the parent's news.

const logger = pino({ level: "silent" });

interface Doors {
    readonly deps: ChildReportDeps;
    readonly started: (AgentTurn & { conversationId: string })[];
    readonly steers: Steer[];
}

const doorsOf = (
    over: { live?: boolean; parentArchived?: boolean; entries?: Record<string, { startedBy?: string; title?: string }> } = {},
): Doors => {
    const started: (AgentTurn & { conversationId: string })[] = [];
    const steers: Steer[] = [];
    const entries: Record<string, { startedBy?: string; title?: string; archivedAt?: number }> = {
        "parent-1": { title: "Refactor the parser", ...(over.parentArchived === true ? { archivedAt: 1 } : {}) },
        "sub-1": { startedBy: childActor("parent-1"), title: "Port the tests" },
        ...over.entries,
    };
    return {
        started,
        steers,
        deps: {
            doors: {
                steer: (_conversationId, steer) => {
                    if (over.live === true) {
                        steers.push(steer);
                    }
                    return over.live === true;
                },
                start: async (turn) => {
                    started.push(turn);
                    return true;
                },
                sessionIdOf: () => "parent-session",
            },
            logger,
            entryOf: (conversationId) => entries[conversationId],
            routingOf: (conversationId) => (entries[conversationId] === undefined ? undefined : { agent: "claude", model: "opus" }),
        },
    };
};

const settledOf = (over: Partial<TurnSettled> = {}): TurnSettled => ({
    conversationId: "sub-1",
    actor: childActor("parent-1"),
    failure: undefined,
    closing: "Ported all 12 tests; they pass.",
    ...over,
});

describe("a spawned child's report", () => {
    beforeEach(() => resetSubagents());

    it("wakes a parent whose turn is over with the child's own answer, drawn as the child's", async () => {
        const doors = doorsOf();
        await reportChildTurn(doors.deps, settledOf());
        expect(doors.started).toHaveLength(1);
        const wake = doors.started[0];
        expect(wake).toMatchObject({ conversationId: "parent-1", sessionId: "parent-session", agent: "claude", model: "opus" });
        expect(agentWordsOf(wake?.prompt ?? "")).toMatchObject({ kind: "child", from: "sub-1", title: "Port the tests" });
        expect(wake?.prompt).toContain("Ported all 12 tests; they pass.");
    });

    it("lands in a parent's live turn in the sandbox's voice", async () => {
        const doors = doorsOf({ live: true });
        await reportChildTurn(doors.deps, settledOf());
        expect(doors.steers).toMatchObject([{ voice: "sandbox" }]);
        expect(doors.started).toEqual([]);
    });

    it("says a child failed, and on what", async () => {
        const doors = doorsOf();
        await reportChildTurn(doors.deps, settledOf({ failure: "usage limit reached", closing: "Halfway through." }));
        const prompt = doors.started[0]?.prompt ?? "";
        expect(agentWordsOf(prompt)).toMatchObject({ failed: true });
        expect(prompt).toContain("Halfway through.");
        expect(prompt).toContain("The turn failed: usage limit reached");
    });

    it("carries the head of a long answer and says where the rest is", async () => {
        const doors = doorsOf();
        await reportChildTurn(doors.deps, settledOf({ closing: `${"a".repeat(4_000)}TAIL` }));
        const prompt = doors.started[0]?.prompt ?? "";
        expect(prompt).not.toContain("TAIL");
        expect(prompt).toContain("(the rest is in its own chat)");
    });

    it("stays quiet when a parked wait of the parent's already took the ending", async () => {
        openSpawnedChild(
            { conversationId: "parent-1", cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined },
            { id: "sub-1", description: "port" },
        );
        const parked = waitForSubagent("parent-1", { target: "sub-1", until: ["finished"], timeoutMs: 5_000 });
        settleSpawnedChild("sub-1", { failed: false, report: "done" });
        await parked;
        const doors = doorsOf();
        await reportChildTurn(doors.deps, settledOf());
        expect(doors.started).toEqual([]);
    });

    it("stays quiet for a turn a person started in the child's own chat", async () => {
        const doors = doorsOf();
        await reportChildTurn(doors.deps, settledOf({ actor: "owner@example.com" }));
        expect(doors.started).toEqual([]);
    });

    // A daemon-started turn (a watch's wake, a resumed turn) is still the child's work for its parent.
    it("reports a turn the daemon started on the child", async () => {
        const doors = doorsOf();
        await reportChildTurn(doors.deps, settledOf({ actor: undefined }));
        expect(doors.started).toHaveLength(1);
    });

    it("stays quiet for a conversation nobody spawned, and for a parent filed away", async () => {
        const unspawned = doorsOf({ entries: { "sub-1": { title: "Started by a person" } } });
        await reportChildTurn(unspawned.deps, settledOf({ actor: undefined }));
        expect(unspawned.started).toEqual([]);
        const archived = doorsOf({ parentArchived: true });
        await reportChildTurn(archived.deps, settledOf());
        expect(archived.started).toEqual([]);
    });
});
