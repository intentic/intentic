import type { SubagentStatus } from "@intentic/sandbox-contract/schemas/terminal";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { open as openChild } from "../../agent/subagents/subagents.js";
import { createHoldingsIndex, type Share } from "../actor/conversation-holdings.js";
import { conversationEntry, isolatedAgent } from "../registry/agents-store.testing.js";
import { joined, NO_QUEUE, scheduled, type TurnQueue } from "../actor/conversation-queue.js";
import { type ConversationState, freshRuntime, idleConversation } from "../actor/conversation-state.js";
import type { PersistedAgent, RepoRecord } from "../registry/agents-store.js";
import type { LandStanding } from "./standing.js";
import { landingRepos, turnRested, turnUnwaitable, unwaitable, workLanded } from "./work-landed.js";

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
        // Each message carries its own booking: one booked for a time ahead of it does not hide the one waiting for "next".
        const message = (id: string) => ({ id, voice: "person" as const, queuedAt: 1, revision: 1, turn: { conversationId: "first", prompt: id } });
        const waitsForNext: TurnQueue = {
            ...NO_QUEUE,
            items: [
                { ...message("m1"), until: 9_000 },
                { ...message("m2"), after: { conversationId: "next", since: 1 } },
            ],
            revision: 2,
            paused: "scheduled",
            until: 9_000,
        };
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

// Pins when a message booked to go after another conversation's TURN may go: a review booked on a session still at
// work. Only once that turn finished clean, with work on its branch or landed from it, and nothing about it says the same
// work goes on: not a question waiting for an answer, a stop or a failure, an open checklist, a wake, a child at work.
// Every case is one reading of what the daemon holds, so a pass after a restart answers what a live one would.

interface TurnHeld {
    readonly standing?: LandStanding;
    readonly state?: ConversationState;
    readonly queue?: TurnQueue;
    // Its subagents' statuses, filed on the roster the way a turn opens them.
    readonly children?: readonly SubagentStatus[];
}

const turnReaders = (entry: PersistedAgent | undefined, held: TurnHeld = {}): Pick<Services, "agents" | "conversations"> => {
    const shares = new Map<string, Share>();
    const { holdings } = createHoldingsIndex((holder, create) => {
        if (!shares.has(holder) && create) {
            shares.set(holder, new Map());
        }
        return shares.get(holder);
    });
    const conversations = unstubbed<Services["conversations"]>("conversations", {
        state: () => held.state,
        queued: () => held.queue ?? NO_QUEUE,
        holdings,
    });
    for (const [index, status] of (held.children ?? []).entries()) {
        openChild({ conversationId: "work", conversations, subagentsDir: undefined }, `child-${index}`, "subagent", { status });
    }
    return {
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id: string) => (id === entry?.id ? entry : undefined),
            standingOf: () => held.standing ?? "idle",
        }),
        conversations,
    };
};

const work = isolatedAgent([{ repo: "root", base: "b0" }], { id: "work" });
const running: ConversationState = { ...idleConversation(), phase: { kind: "running", startedAt: 1, parked: [], stopping: undefined } };
const workMessage = (id: string) => ({ id, voice: "person" as const, queuedAt: 1, turn: { conversationId: "work", prompt: id } });

describe("whether a conversation's turn rests, for what waits on it", () => {
    it("rests once a clean turn left work on its branch, or landed it, whether or not anybody landed it", () => {
        expect(turnRested(turnReaders(work, { standing: "ready" }), "work")).toBe(true);
        expect(turnRested(turnReaders(work, { standing: "conflict" }), "work")).toBe(true);
        expect(turnRested(turnReaders(work, { standing: "landed" }), "work")).toBe(true);
    });

    it("does not rest on a turn that left nothing to look at, which a review would read as nothing", () => {
        expect(turnRested(turnReaders(work, { standing: "idle" }), "work")).toBe(false);
    });

    it("does not rest while the turn is live, a question or a permission parked on it included, or unwinding, landing or resuming", () => {
        expect(turnRested(turnReaders(work, { standing: "ready", state: running }), "work")).toBe(false);
        const parked: ConversationState = { ...running, phase: { kind: "running", startedAt: 1, parked: [{ requestId: "ask-1", kind: "question" }], stopping: undefined } };
        expect(turnRested(turnReaders(work, { standing: "ready", state: parked }), "work")).toBe(false);
        expect(turnRested(turnReaders(work, { standing: "ready", state: { ...idleConversation(), turn: { ...freshRuntime(), landing: true } } }), "work")).toBe(false);
        expect(turnRested(turnReaders(work, { standing: "ready", state: { ...idleConversation(), turn: { ...freshRuntime(), resuming: true } } }), "work")).toBe(false);
    });

    it("does not rest while the same work goes on by itself: a wake armed, words of its own waiting, a child still at work", () => {
        const watched: ConversationState = { ...idleConversation(), watches: [{ id: "w1", note: "CI", intervalSeconds: 60, deadlineAt: 1 }] };
        expect(turnRested(turnReaders(work, { standing: "ready", state: watched }), "work")).toBe(false);
        expect(turnRested(turnReaders(work, { standing: "ready", queue: joined(NO_QUEUE, workMessage("m1")) }), "work")).toBe(false);
        expect(turnRested(turnReaders(work, { standing: "ready", children: ["running"] }), "work")).toBe(false);
        expect(turnRested(turnReaders(work, { standing: "ready", children: ["completed"] }), "work")).toBe(true);
    });

    it("rests with words of its own booked for later, which are not this turn going on", () => {
        const booked = scheduled(NO_QUEUE, workMessage("m1"), { until: 99_000 });
        expect(turnRested(turnReaders(work, { standing: "ready", queue: booked }), "work")).toBe(true);
    });

    it("does not rest on a turn stopped, failed or held on a spent allowance, or one that left its own checklist open", () => {
        expect(turnRested(turnReaders({ ...work, ending: { kind: "stopped" } }, { standing: "ready" }), "work")).toBe(false);
        expect(turnRested(turnReaders({ ...work, ending: { kind: "failed", failure: "boom" } }, { standing: "ready" }), "work")).toBe(false);
        const open = { ...work, unfinished: { at: 1, steps: { open: 2, total: 5, next: "wire the route" } } };
        expect(turnRested(turnReaders(open, { standing: "ready" }), "work")).toBe(false);
    });

    it("never rests for a conversation that is gone, archived, or in the shared workspace", () => {
        expect(turnRested(turnReaders(undefined), "work")).toBe(false);
        expect(turnRested(turnReaders({ ...work, archivedAt: 1 }, { standing: "ready" }), "work")).toBe(false);
        expect(turnRested(turnReaders(conversationEntry({ id: "work" }), { standing: "ready" }), "work")).toBe(false);
    });
});

describe("whether a conversation's turn can be waited for", () => {
    it("names why not for one that is unknown, archived, in the shared workspace, or waiting for the asker; a live one can", () => {
        expect(turnUnwaitable(turnReaders(undefined), "nobody", "review")).toBe(`there is no conversation "nobody" to wait for`);
        expect(turnUnwaitable(turnReaders({ ...work, archivedAt: 1 }), "work", "review")).toBe("that conversation is archived, so no turn of it will end");
        expect(turnUnwaitable(turnReaders(conversationEntry({ id: "work" })), "work", "review")).toContain("shared workspace");
        const waitsForReview = scheduled(NO_QUEUE, workMessage("m1"), { after: { conversationId: "review", since: 1, turn: true } });
        expect(turnUnwaitable(turnReaders(work, { queue: waitsForReview }), "work", "review")).toBe("that conversation already waits for this one: one of the two has to go first");
        expect(turnUnwaitable(turnReaders(work), "work", "review")).toBeUndefined();
    });

    it("lets a spawned child be waited for, whose turn ends like any other wherever its work lands", () => {
        const child = { ...work, placement: { ...work.placement, parent: "parent" } };
        expect(turnUnwaitable(turnReaders(child), "work", "review")).toBeUndefined();
    });
});
