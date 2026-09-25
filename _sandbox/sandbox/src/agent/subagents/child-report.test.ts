import { WORKSPACE_ROOT } from "@intentic/constants";
import { agentWordsOf } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { childActor } from "../../auth/principal.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { type FakeTurns, fakeTurns, memoryFleet } from "../../testing.js";
import { type ChildReportDeps, reportChildTurn } from "./child-report.js";
import { openSpawnedChild, resetSubagents, settleSpawnedChild, waitForSubagent } from "./subagents.js";

// A child's ending reaches its parent once, and only when it is the parent's news.

const logger = pino({ level: "silent" });

// One fleet's actors, which hold the children and the waits every report reads.
const actors = memoryFleet().conversations;

interface Doors extends FakeTurns {
    readonly deps: ChildReportDeps;
}

const doorsOf = (
    over: {
        live?: boolean;
        parentArchived?: boolean;
        entries?: Record<string, { startedBy?: string; title?: string }>;
        killNote?: ChildReportDeps["killNote"];
    } = {},
): Doors => {
    const entries: Record<string, { startedBy?: string; title?: string }> = {
        "parent-1": { title: "Refactor the parser" },
        "sub-1": { startedBy: childActor("parent-1"), title: "Port the tests" },
        ...over.entries,
    };
    // The parent filed away is the admission's to turn the report from, as it turns every word nobody sent.
    const turns = fakeTurns({ live: over.live === true, archived: over.parentArchived === true });
    return Object.assign(turns, {
        deps: {
            doors: { turns: turns.turns, sessionIdOf: () => "parent-session" },
            logger,
            conversations: actors,
            entryOf: (conversationId: string) => entries[conversationId],
            profileOf: (conversationId: string) => (entries[conversationId] === undefined ? undefined : { agent: "claude", model: "opus" }),
            killNote: over.killNote ?? (async () => undefined),
        },
    });
};

const settledOf = (over: Partial<DomainEventMap["run.settled"]> = {}): DomainEventMap["run.settled"] => ({
    conversationId: "sub-1",
    actor: childActor("parent-1"),
    speaker: { kind: "agent", conversationId: "parent-1" },
    failure: undefined,
    closing: "Ported all 12 tests; they pass.",
    ...over,
});

describe("a spawned child's report", () => {
    beforeEach(() => resetSubagents(actors));

    it("tells the parent a killed child can be continued, in place of a bare failure", async () => {
        const asked: [string, string][] = [];
        const doors = doorsOf({
            killNote: async (childId, failure) => {
                asked.push([childId, failure]);
                return "Killed when the sandbox ran out of memory. Its session is intact.";
            },
        });
        await reportChildTurn(doors.deps, settledOf({ failure: "Claude Code process terminated by signal SIGKILL", closing: "Halfway through." }));
        expect(asked).toEqual([["sub-1", "Claude Code process terminated by signal SIGKILL"]]);
        expect(doors.started[0]?.prompt).toContain("Halfway through.\n\nKilled when the sandbox ran out of memory. Its session is intact.");
        expect(doors.started[0]?.prompt).not.toContain("The turn failed");
    });

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
            { conversationId: "parent-1", conversations: actors, cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined },
            { id: "sub-1", description: "port" },
        );
        const parked = waitForSubagent(actors, "parent-1", { target: "sub-1", until: ["finished"], timeoutMs: 5_000 });
        settleSpawnedChild(actors, "sub-1", { status: "completed", report: "done" });
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
