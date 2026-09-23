import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, test } from "bun:test";
import type { ConversationActors } from "../../../agents/actor/conversation-actors.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { conversationIdentity, mainTreePlacement, type Placement, placedTurn } from "./turn-placement.js";

// The two events a placed turn sends its conversation, and every step of the placement, in one running order.
const recorded = () => {
    const steps: unknown[][] = [];
    const conversations: Pick<ConversationActors, "send"> = {
        send: (id, event) => {
            steps.push(event.kind === "frame" ? ["frame", id, event.frame] : [event.kind, id]);
            return { reply: undefined, settled: Promise.resolve(undefined) } as never;
        },
    };
    return { steps, conversations };
};

const stream = (frames: readonly AgentEvent[], thrown?: unknown) =>
    async function* (): AsyncGenerator<AgentEvent> {
        yield* frames;
        if (thrown !== undefined) {
            throw thrown;
        }
    };

// A placement announcing itself with one frame and landing with another, each step noted where it runs.
const placement = (steps: unknown[][], body: () => AsyncIterable<AgentEvent>): Placement => ({
    async *open () {
        steps.push(["open"]);
        yield { kind: "worktree", branch: "agent/c", base: "abc1234" };
        return body();
    },
    async *land (failed) {
        steps.push(["land", failed]);
        yield { kind: "landed", landed: true };
    },
    close: async (failed) => void steps.push(["close", failed]),
    settled: (failed) => void steps.push(["settled", failed]),
    thrown: "the placement's own words",
});

const drain = async (frames: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
    const out: AgentEvent[] = [];
    for await (const frame of frames) {
        out.push(frame);
    }
    return out;
};

describe("a placed turn", () => {
    test("observes only its body's frames, lands after a clean body, and always closes, finishes and settles", async () => {
        const { steps, conversations } = recorded();
        const frames = await drain(placedTurn(conversations, "c", placement(steps, stream([{ kind: "delta", text: "hi" }, { kind: "done" }]))));

        expect(frames).toStrictEqual([{ kind: "worktree", branch: "agent/c", base: "abc1234" }, { kind: "delta", text: "hi" }, { kind: "done" }, { kind: "landed", landed: true }]);
        expect(steps).toStrictEqual([
            ["open"],
            ["frame", "c", { kind: "delta", text: "hi" }],
            ["frame", "c", { kind: "done" }],
            ["land", false],
            ["close", false],
            ["settle", "c"],
            ["settled", false],
        ]);
    });

    test("whose body emitted an error frame is failed, which the land and the books are told", async () => {
        const { steps, conversations } = recorded();
        await drain(placedTurn(conversations, "c", placement(steps, stream([{ kind: "error", message: "died" }, { kind: "done" }]))));
        expect(steps.filter(([step]) => step !== "frame")).toStrictEqual([["open"], ["land", true], ["close", true], ["settle", "c"], ["settled", true]]);
    });

    test("that throws is observed as failed with the error's own words, rethrown, and still finished", async () => {
        const { steps, conversations } = recorded();
        const run = drain(placedTurn(conversations, "c", placement(steps, stream([{ kind: "delta", text: "hi" }], new Error("the harness crashed")))));

        await expect(run).rejects.toThrow("the harness crashed");
        expect(steps).toStrictEqual([
            ["open"],
            ["frame", "c", { kind: "delta", text: "hi" }],
            ["frame", "c", { kind: "error", message: "the harness crashed" }],
            ["close", true],
            ["settle", "c"],
            ["settled", true],
        ]);
    });

    test("that throws something with no words of its own is observed in the placement's", async () => {
        const { steps, conversations } = recorded();
        await expect(drain(placedTurn(conversations, "c", placement(steps, stream([], "not an error"))))).rejects.toBe("not an error");
        expect(steps).toContainEqual(["frame", "c", { kind: "error", message: "the placement's own words" }]);
    });

    test("that is stopped is not failed: nothing is observed, and the books close as for a clean turn", async () => {
        const { steps, conversations } = recorded();
        const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
        await expect(drain(placedTurn(conversations, "c", placement(steps, stream([], aborted))))).rejects.toBe(aborted);
        expect(steps).toStrictEqual([["open"], ["close", false], ["settle", "c"], ["settled", false]]);
    });

    test("whose placement fails to open is failed before any body ran", async () => {
        const { steps, conversations } = recorded();
        const broken: Placement = {
            ...placement(steps, stream([])),
            // oxlint-disable-next-line require-yield -- An opening that fails before it announces anything.
            async *open () {
                throw new Error("no worktree");
            },
        };
        await expect(drain(placedTurn(conversations, "c", broken))).rejects.toThrow("no worktree");
        expect(steps).toStrictEqual([["frame", "c", { kind: "error", message: "no worktree" }], ["close", true], ["settle", "c"], ["settled", true]]);
    });
});

describe("the main tree", () => {
    test("hands over the body with nothing announced before it, and lands, settles and books nothing", async () => {
        const main = mainTreePlacement(stream([{ kind: "checkpoint", id: "snap-1" }, { kind: "done" }]));
        const { steps, conversations } = recorded();

        expect(await drain(placedTurn(conversations, "c", main))).toStrictEqual([{ kind: "checkpoint", id: "snap-1" }, { kind: "done" }]);
        expect(steps).toStrictEqual([
            ["frame", "c", { kind: "checkpoint", id: "snap-1" }],
            ["frame", "c", { kind: "done" }],
            ["settle", "c"],
        ]);
        expect(main.thrown).toBe("agent turn failed");
    });
});

describe("what a conversation's turn begins as", () => {
    // The registry defaults a runtime the turn never named; the identity itself says only what the turn said.
    test("carries only what the turn named, and a profile naming nothing when it named nothing", () => {
        expect(conversationIdentity({ prompt: "ship it" }, "c", { isolated: false, runner: undefined })).toStrictEqual({
            conversationId: "c",
            isolated: false,
            prompt: "ship it",
            profile: {},
        });
    });

    test("carries everything a turn can name, the actor as who started it and a fork as its source's cut", () => {
        const input: TurnInput = {
            prompt: "ship it",
            agent: "codex",
            harness: "claude-code",
            title: "Parser",
            model: "gpt-5.1",
            effort: "high",
            thinking: true,
            fast: false,
            account: "acct",
            origin: { automationId: "nightly", provider: "schedule" },
            actor: "ada@example.com",
            owner: { email: "ada@example.com", name: "Ada" },
            areas: ["web"],
            startIn: "web",
            actsAs: "reviewer",
            forkOf: { conversationId: "source", keep: 4, files: "then" },
        };
        expect(conversationIdentity(input, "c", { isolated: true, runner: "r-1" })).toStrictEqual({
            conversationId: "c",
            isolated: true,
            runner: "r-1",
            prompt: "ship it",
            profile: { agent: "codex", harness: "claude-code", model: "gpt-5.1", effort: "high", thinking: true, fast: false, account: "acct", actsAs: "reviewer" },
            title: "Parser",
            origin: { automationId: "nightly", provider: "schedule" },
            startedBy: "ada@example.com",
            owner: { email: "ada@example.com", name: "Ada" },
            areas: ["web"],
            startIn: "web",
            forkedFrom: { conversationId: "source", index: 4, files: "then" },
        });
    });
});
