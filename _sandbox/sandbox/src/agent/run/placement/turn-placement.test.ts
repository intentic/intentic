import type { AgentEvent } from "@intentic/sandbox-contract";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import type { RepoSync } from "../../../conversations/land/sync.js";
import type { ConversationWorktree } from "../../../conversations/worktrees/worktrees.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import type { TurnCloser } from "./turn-close.js";
import {
    conversationIdentity,
    mainTreePlacement,
    type Placement,
    placedTurn,
    refusedBegin,
    runnerPlacement,
    type WorktreeFrame,
    worktreeFrame,
} from "./turn-placement.js";

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
    async *open() {
        steps.push(["open"]);
        yield { kind: "worktree", branch: "agent/c", base: "abc1234" };
        return body();
    },
    async *land(failed, awaiting) {
        steps.push(["land", failed, awaiting]);
        yield { kind: "landed", landed: true };
    },
    close: async (failed) => void steps.push(["close", failed]),
    settled: (ending) => void steps.push(["settled", ending]),
    thrown: "the placement's own words",
});

// The close's first steps, noted where they run; `awaiting` is what arming the wakes answers.
const closer = (steps: unknown[][], awaiting = false): TurnCloser => ({
    hush: () => void steps.push(["hush"]),
    armWakes: async () => {
        steps.push(["arm"]);
        return awaiting;
    },
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
        const frames = await drain(
            placedTurn(conversations, "c", placement(steps, stream([{ kind: "delta", text: "hi" }, { kind: "done" }])), closer(steps)),
        );

        expect(frames).toStrictEqual([
            { kind: "worktree", branch: "agent/c", base: "abc1234" },
            { kind: "delta", text: "hi" },
            { kind: "done" },
            { kind: "landed", landed: true },
        ]);
        expect(steps).toStrictEqual([
            ["open"],
            ["frame", "c", { kind: "delta", text: "hi" }],
            ["frame", "c", { kind: "done" }],
            ["hush"],
            ["arm"],
            ["land", false, false],
            ["close", false],
            ["settle", "c"],
            ["settled", "finished"],
        ]);
    });

    // The wake it armed is the turn that finishes the work: the land is told, and the ending says so.
    test("that armed a wake tells its land, and ends awaiting it", async () => {
        const { steps, conversations } = recorded();
        await drain(placedTurn(conversations, "c", placement(steps, stream([{ kind: "done" }])), closer(steps, true)));
        expect(steps.filter(([step]) => step !== "frame")).toStrictEqual([
            ["open"],
            ["hush"],
            ["arm"],
            ["land", false, true],
            ["close", false],
            ["settle", "c"],
            ["settled", "awaiting-wake"],
        ]);
    });

    test("whose body emitted an error frame is failed, which the land and the books are told", async () => {
        const { steps, conversations } = recorded();
        await drain(placedTurn(conversations, "c", placement(steps, stream([{ kind: "error", message: "died" }, { kind: "done" }])), closer(steps)));
        expect(steps.filter(([step]) => step !== "frame")).toStrictEqual([
            ["open"],
            ["hush"],
            ["arm"],
            ["land", true, false],
            ["close", true],
            ["settle", "c"],
            ["settled", "failed"],
        ]);
    });

    test("that throws is observed as failed with the error's own words, rethrown, and still finished", async () => {
        const { steps, conversations } = recorded();
        const run = drain(
            placedTurn(conversations, "c", placement(steps, stream([{ kind: "delta", text: "hi" }], new Error("the harness crashed"))), closer(steps)),
        );

        await expect(run).rejects.toThrow("the harness crashed");
        // What it left running is judged and its wakes armed all the same, once, before its books close.
        expect(steps).toStrictEqual([
            ["open"],
            ["frame", "c", { kind: "delta", text: "hi" }],
            ["frame", "c", { kind: "error", message: "the harness crashed" }],
            ["hush"],
            ["arm"],
            ["close", true],
            ["settle", "c"],
            ["settled", "failed"],
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
        await expect(drain(placedTurn(conversations, "c", placement(steps, stream([], aborted)), closer(steps, true)))).rejects.toBe(aborted);
        expect(steps).toStrictEqual([["open"], ["hush"], ["arm"], ["close", false], ["settle", "c"], ["settled", "stopped"]]);
    });

    test("whose placement fails to open is failed before any body ran", async () => {
        const { steps, conversations } = recorded();
        const broken: Placement = {
            ...placement(steps, stream([])),
            // oxlint-disable-next-line require-yield -- An opening that fails before it announces anything.
            async *open() {
                throw new Error("no worktree");
            },
        };
        await expect(drain(placedTurn(conversations, "c", broken))).rejects.toThrow("no worktree");
        expect(steps).toStrictEqual([
            ["frame", "c", { kind: "error", message: "no worktree" }],
            ["close", true],
            ["settle", "c"],
            ["settled", "failed"],
        ]);
    });

    // A close that could not arm its wakes still settles: a turn's ending never fails on what it left running.
    test("whose wakes could not be armed still closes, settles and announces, as awaiting nothing", async () => {
        const { steps, conversations } = recorded();
        const broken: TurnCloser = { hush: () => void steps.push(["hush"]), armWakes: () => Promise.reject(new Error("no watchers")) };
        await drain(placedTurn(conversations, "c", placement(steps, stream([{ kind: "done" }])), broken));
        expect(steps.filter(([step]) => step !== "frame")).toStrictEqual([
            ["open"],
            ["hush"],
            ["land", false, false],
            ["close", false],
            ["settle", "c"],
            ["settled", "finished"],
        ]);
    });

    // A close that throws must not leave the conversation running: settled, it takes the next turn.
    test("whose placement fails to close still settles and announces, and the close's error propagates", async () => {
        const { steps, conversations } = recorded();
        const broken: Placement = {
            ...placement(steps, stream([{ kind: "done" }])),
            close: async () => {
                steps.push(["close"]);
                throw new Error("books unreadable");
            },
        };
        await expect(drain(placedTurn(conversations, "c", broken, closer(steps)))).rejects.toThrow("books unreadable");
        expect(steps.filter(([step]) => step !== "frame")).toStrictEqual([
            ["open"],
            ["hush"],
            ["arm"],
            ["land", false, false],
            ["close"],
            ["settle", "c"],
            ["settled", "finished"],
        ]);
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
            titleSource: "model",
            postures: { limit: "resend" },
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
            profile: {
                agent: "codex",
                harness: "claude-code",
                model: "gpt-5.1",
                effort: "high",
                thinking: true,
                fast: false,
                account: "acct",
                actsAs: "reviewer",
            },
            title: "Parser",
            titleSource: "model",
            postures: { limit: "resend" },
            origin: { automationId: "nightly", provider: "schedule" },
            startedBy: "ada@example.com",
            owner: { email: "ada@example.com", name: "Ada" },
            areas: ["web"],
            startIn: "web",
            forkedFrom: { conversationId: "source", index: 4, files: "then" },
        });
    });
});

describe("a turn its conversation would not take", () => {
    // Busy is a wait a client knows by its code; archived has no code, since no wait lifts it.
    test("says why and ends, busy by its code and archived in words", () => {
        expect([...refusedBegin("busy")]).toStrictEqual([
            { kind: "error", code: "agent-busy", message: "This agent is already running a turn, wait for it to finish." },
            { kind: "done" },
        ]);
        expect([...refusedBegin("archived")]).toStrictEqual([
            { kind: "error", message: "This conversation is archived: only a person's message reopens it." },
            { kind: "done" },
        ]);
    });
});

const worktree = (repos: ConversationWorktree["repos"]): ConversationWorktree => ({
    cwd: "/w",
    branch: "agent/c",
    repos,
    fence: undefined,
    elsewhere: [],
});
const moved = (repo: string, commits: number): RepoSync => ({ repo, onto: "f".repeat(40), commits, moved: [], overlap: [] });
const blocked = (repo: string): RepoSync => ({ repo, onto: "e".repeat(40), commits: 0, moved: [], overlap: [], blocked: true });

describe("where the branch stands", () => {
    const frames: [string, ConversationWorktree, ReadonlyMap<string, string>, boolean, readonly RepoSync[], WorktreeFrame][] = [
        [
            "names the root repo's base, cut to seven",
            worktree([
                { repo: "web", base: "b".repeat(40) },
                { repo: "root", base: "a".repeat(40) },
            ]),
            new Map(),
            true,
            [],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa" },
        ],
        [
            "names the first repo's when there is no root",
            worktree([{ repo: "web", base: "b".repeat(40) }]),
            new Map(),
            true,
            [],
            { kind: "worktree", branch: "agent/c", base: "bbbbbbb" },
        ],
        ["names nothing when there are no repos", worktree([]), new Map(), true, [], { kind: "worktree", branch: "agent/c", base: "" }],
        [
            "names where a rebase moved the root",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map([["root", "c".repeat(40)]]),
            true,
            [],
            { kind: "worktree", branch: "agent/c", base: "ccccccc" },
        ],
        [
            "says when the container cannot enforce the tree",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map(),
            false,
            [],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa", unenforced: true },
        ],
        [
            "counts what a rebase moved and names what it could not",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map(),
            true,
            [moved("root", 2), moved("web", 3), blocked("docs")],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa", sync: { commits: 5, blocked: ["docs"] } },
        ],
        [
            "reports a rebase that found nothing to move",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map(),
            true,
            [moved("root", 0)],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa", sync: { commits: 0, blocked: [] } },
        ],
    ];
    test.each(frames)("%s", (_case, composed, onto, enforced, synced, frame) => {
        expect(worktreeFrame(composed, onto, enforced, synced)).toStrictEqual(frame);
    });
});

describe("a runner's mirror", () => {
    // Read before the anchor, so nothing past the announcement touches a checkout.
    test("is announced as a worktree frame where the mirror stands, naming the runner", async () => {
        const mirror = worktree([
            { repo: "web", base: "b".repeat(40) },
            { repo: "root", base: "a".repeat(40) },
        ]);
        const opened = runnerPlacement({} as never, { conversationId: "c", snapshot: { conversationId: "c", index: 0 }, runner: "box" }, {
            compose: async () => mirror,
            dispatch: stream([]),
        }).open();
        expect((await opened.next()).value).toStrictEqual({ kind: "worktree", branch: "agent/c", base: "aaaaaaa", remote: "box" });
        await opened.return(stream([])());
    });
});
