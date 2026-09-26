import { conversationEntry, isolatedAgent, memoryFleet } from "../../testing.js";
import { checkpointSteeredMessage } from "./steer-checkpoints.js";

// Pins that a steered message's position is fixed when the turn accepts it, before its snapshot resolves; a queue that
// reordered by finish time would file one message's state under another's index.

const logger = { warn: jest.fn() } as never;

// A history whose captures are named in call order (snap-1, snap-2, ...). A capture named in `held` resolves only
// once the test releases it, so the test, not a timer race a loaded runner can lose, decides which one finishes first.
const history = (held: readonly string[] = []) => {
    const gates = new Map(held.map((id) => [id, Promise.withResolvers<void>()]));
    let next = 0;
    return {
        release: (id: string) => gates.get(id)?.resolve(),
        history: {
            snapshot: async () => {
                const id = `snap-${++next}`;
                await gates.get(id)?.promise;
                return id;
            },
            list: async () => [],
        } as never,
    };
};

// Each test's boxes live in its own fleet's actors, taken back the way the settle takes them.
const services = (agents: unknown, extra: Record<string, unknown> = {}) => {
    const { conversations } = memoryFleet();
    return { agents, conversations, agentWorktrees: { worktreeDir: () => "/w" }, logger, ...extra } as never;
};
const taken = (deps: { readonly conversations: ReturnType<typeof memoryFleet>["conversations"] }, conversationId: string) =>
    deps.conversations.send(conversationId, { kind: "steers-taken" }).reply;

// A main-tree conversation: no branch, so its before-state is a workspace checkpoint.
const mainTree = { agents: { entry: () => conversationEntry() } };

test("a slow capture keeps its place, so states stay paired with the messages that took them", async () => {
    // The first steer's capture resolves after the second's has been filed: what a finish-order queue would reorder.
    const captures = history(["snap-1", "snap-2"]);
    const deps = services(mainTree.agents, { history: captures.history });

    const first = checkpointSteeredMessage(deps, "c1");
    const second = checkpointSteeredMessage(deps, "c1");
    captures.release("snap-2");
    await second;
    captures.release("snap-1");
    await first;

    expect(taken(deps, "c1")).toEqual([
        { kind: "tree", snapshot: "snap-1" },
        { kind: "tree", snapshot: "snap-2" },
    ]);
});

// Skipping a box would shift every later message's index in the turn; an empty box, not no box, keeps positions
// aligned.
test("a conversation whose state is elsewhere leaves an empty box rather than no box", async () => {
    const entries = [isolatedAgent([], { placement: { kind: "worktree", branch: "agent/c1", repos: [], runner: "mac-1" } }), conversationEntry()];
    let at = 0;
    const deps = services({ entry: () => entries[at++] }, { history: history().history });

    await checkpointSteeredMessage(deps, "c1");
    await checkpointSteeredMessage(deps, "c1");

    expect(taken(deps, "c1")).toEqual([undefined, { kind: "tree", snapshot: "snap-1" }]);
});

// The queue always drains; a box left behind would be picked up by the next turn and filed under one of its rows.
test("draining empties the queue, so nothing carries into the next turn", async () => {
    const deps = services(mainTree.agents, { history: history().history });

    await checkpointSteeredMessage(deps, "c1");
    expect(taken(deps, "c1")).toHaveLength(1);
    expect(taken(deps, "c1")).toEqual([]);
});

// An unknown conversation has nothing to checkpoint against, and a failing capture isn't fatal: both just mean no bookmark.
test("an unknown conversation and a failing capture both come back empty rather than throwing", async () => {
    const unknown = services({ entry: () => undefined }, { history: history().history });
    await checkpointSteeredMessage(unknown, "c2");
    expect(taken(unknown, "c2")).toEqual([undefined]);

    const broken = services(mainTree.agents, {
        history: {
            snapshot: async () => {
                throw new Error("history is down");
            },
            list: async () => [],
        },
    });
    await checkpointSteeredMessage(broken, "c3");
    expect(taken(broken, "c3")).toEqual([undefined]);
});
