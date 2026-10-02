import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { conversationEntry, isolatedAgent } from "../../testing.js";
import { joined, NO_QUEUE, type TurnQueue } from "../actor/conversation-queue.js";
import { type ConversationState, freshRuntime, idleConversation } from "../actor/conversation-state.js";
import type { PersistedAgent, RepoRecord } from "../registry/agents-store.js";
import type { LandStanding } from "./standing.js";
import { landingRepos, unwaitable, workLanded } from "./work-landed.js";

// Pins when a message booked to go after another conversation may go: only once that conversation has finished, nothing
// of it is left to land, and its last turn ended clean or a person landed its work since the booking. Every case is one
// reading of what the daemon holds, so a pass after a restart answers what a live one would.

const BOOKED = 10_000;

interface Held {
    readonly standing?: LandStanding;
    readonly state?: ConversationState;
    readonly queue?: TurnQueue;
}

const readers = (entry: PersistedAgent | undefined, held: Held = {}): Pick<Services, "agents" | "conversations"> => ({
    agents: unstubbed<Services["agents"]>("agents", {
        entry: (id: string) => (id === entry?.id ? entry : undefined),
        standingOf: () => held.standing ?? "idle",
    }),
    conversations: unstubbed<Services["conversations"]>("conversations", {
        state: () => held.state,
        queued: () => held.queue ?? NO_QUEUE,
    }),
});

// One repo of a private copy: never landed, or last landed at `landedAt`.
const repo = (landedAt?: number): RepoRecord => {
    const record: RepoRecord = { repo: "root", base: "b0" };
    if (landedAt !== undefined) {
        record.landedTip = "t1";
        record.landedAt = landedAt;
    }
    return record;
};
const finished = isolatedAgent([repo(BOOKED - 5_000)], { id: "first" });

describe("whether a conversation's work is in, for what waits on it", () => {
    it("is in once a clean turn's work landed or there was none, in a private copy or the shared tree", () => {
        expect(workLanded(readers(finished, { standing: "landed" }), "first", BOOKED)).toBe(true);
        expect(workLanded(readers(finished, { standing: "idle" }), "first", BOOKED)).toBe(true);
        expect(workLanded(readers(conversationEntry({ id: "first" })), "first", BOOKED)).toBe(true);
    });

    it("is not in while anything of it is still to come: a turn, a land, a recovery, a wake, or words of its own waiting", () => {
        const running: ConversationState = { ...idleConversation(), phase: { kind: "running", startedAt: 1, parked: [], stopping: undefined } };
        expect(workLanded(readers(finished, { state: running }), "first", BOOKED)).toBe(false);
        expect(workLanded(readers(finished, { state: { ...idleConversation(), turn: { ...freshRuntime(), landing: true } } }), "first", BOOKED)).toBe(false);
        expect(workLanded(readers(finished, { state: { ...idleConversation(), turn: { ...freshRuntime(), resuming: true } } }), "first", BOOKED)).toBe(false);
        expect(
            workLanded(readers(finished, { state: { ...idleConversation(), watches: [{ id: "w1", note: "CI", intervalSeconds: 60, deadlineAt: 1 }] } }), "first", BOOKED),
        ).toBe(false);
        const own = joined(NO_QUEUE, { id: "m1", voice: "person", queuedAt: 1, turn: { conversationId: "first", prompt: "next" } });
        expect(workLanded(readers(finished, { queue: own }), "first", BOOKED)).toBe(false);
    });

    it("is not in while work waits on its branch, a land is refused, or a land broke", () => {
        expect(workLanded(readers(finished, { standing: "ready" }), "first", BOOKED)).toBe(false);
        expect(workLanded(readers(finished, { standing: "conflict" }), "first", BOOKED)).toBe(false);
        const broken = isolatedAgent([repo()], { id: "first", landing: { failure: { reason: "index.lock", at: 1 } } });
        expect(workLanded(readers(broken), "first", BOOKED)).toBe(false);
        // A failed check of held work is not a broken land: the next reading clears it.
        const checked = isolatedAgent([repo()], { id: "first", landing: { failure: { reason: "index.lock", at: 1, check: true } } });
        expect(workLanded(readers(checked), "first", BOOKED)).toBe(true);
    });

    it("counts a stopped or failed turn only once a person landed its work after the booking", () => {
        const stopped = isolatedAgent([repo(BOOKED - 5_000)], { id: "first", ending: { kind: "stopped" } });
        expect(workLanded(readers(stopped, { standing: "landed" }), "first", BOOKED)).toBe(false);
        const landedSince = isolatedAgent([repo(BOOKED + 1_000)], { id: "first", ending: { kind: "failed", failure: "boom" } });
        expect(workLanded(readers(landedSince, { standing: "landed" }), "first", BOOKED)).toBe(true);
        // A land into the parent's checkout is not the workspace.
        const intoParent = isolatedAgent([repo(BOOKED + 1_000)], { id: "first", ending: { kind: "stopped" } });
        const parentLanded = { ...intoParent, placement: { ...intoParent.placement, landedInto: "parent" } };
        expect(workLanded(readers(parentLanded, { standing: "landed" }), "first", BOOKED)).toBe(false);
    });

    it("is never in for a conversation that is gone or archived, which what waits must not take for a land", () => {
        expect(workLanded(readers(undefined), "first", BOOKED)).toBe(false);
        expect(workLanded(readers({ ...finished, archivedAt: 1 }, { standing: "landed" }), "first", BOOKED)).toBe(false);
    });
});

describe("whether a conversation can be waited for", () => {
    it("names why not for one that is unknown, archived, a spawned child, or waiting for the asker; a live one can", () => {
        expect(unwaitable(readers(undefined), "nobody", "next")).toBe(`there is no conversation "nobody" to wait for`);
        expect(unwaitable(readers({ ...finished, archivedAt: 1 }), "first", "next")).toBe("that conversation is archived, so nothing of it will land");
        const child = { ...finished, placement: { ...finished.placement, parent: "parent" } };
        expect(unwaitable(readers(child), "first", "next")).toBe("that agent's work lands into the agent that started it: wait for that one instead");
        const waitsForNext: TurnQueue = { ...NO_QUEUE, items: [], revision: 1, paused: "scheduled", after: { conversationId: "next", since: 1 } };
        expect(unwaitable(readers(finished, { queue: waitsForNext }), "first", "next")).toBe(
            "that conversation already waits for this one's work: one of the two has to go first",
        );
        expect(unwaitable(readers(finished), "first", "next")).toBeUndefined();
    });

    it("lists the repositories its work lands in, for the version commits a follow-up waits out", () => {
        expect(landingRepos(readers(isolatedAgent([repo(), { repo: "web", base: "b1" }], { id: "first" })), "first")).toEqual(["root", "web"]);
        expect(landingRepos(readers(conversationEntry({ id: "first" })), "first")).toEqual([]);
    });
});
