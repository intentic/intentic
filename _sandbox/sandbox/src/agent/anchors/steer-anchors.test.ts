import { expect, test, vi } from "vitest";
import { anchorSteeredMessage, takeSteerAnchors } from "./steer-anchors.js";

// Pins that a steered message's position is fixed when the turn accepts it, before its snapshot resolves; a queue that
// reordered by finish time would file one message's state under another's index.

const logger = { warn: vi.fn() } as never;

// A history whose capture takes as long as it is told to, so the test can make two steers finish out of order.
const history = (order: string[], delays: Record<string, number>) => {
    let next = 0;
    return {
        snapshot: async () => {
            const id = `snap-${++next}`;
            await new Promise((resolve) => setTimeout(resolve, delays[id] ?? 0));
            order.push(id);
            return id;
        },
        list: async () => [],
    } as never;
};

const services = (agents: unknown, extra: Record<string, unknown> = {}) =>
    ({ agents, agentWorktrees: { worktreeDir: () => "/w" }, logger, ...extra }) as never;

// A main-tree conversation: no branch, so its before-state is a workspace checkpoint.
const mainTree = { agents: { entry: () => ({ id: "c1" }) } };

test("a slow capture keeps its place, so states stay paired with the messages that took them", async () => {
    const finished: string[] = [];
    // The first steer's capture is slower, resolving after the second's: what a finish-order queue would reorder.
    const deps = services(mainTree.agents, { history: history(finished, { "snap-1": 20 }) });

    const first = anchorSteeredMessage(deps, "c1");
    const second = anchorSteeredMessage(deps, "c1");
    await Promise.all([first, second]);

    expect(finished).toEqual(["snap-2", "snap-1"]);
    expect(takeSteerAnchors("c1")).toEqual([
        { kind: "tree", snapshot: "snap-1" },
        { kind: "tree", snapshot: "snap-2" },
    ]);
});

// Skipping a box would shift every later message's index in the turn; an empty box, not no box, keeps positions
// aligned.
test("a conversation whose state is elsewhere leaves an empty box rather than no box", async () => {
    const entries = [{ id: "c1", runner: "mac-1" }, { id: "c1" }];
    let at = 0;
    const deps = services({ entry: () => entries[at++] }, { history: history([], {}) });

    await anchorSteeredMessage(deps, "c1");
    await anchorSteeredMessage(deps, "c1");

    expect(takeSteerAnchors("c1")).toEqual([undefined, { kind: "tree", snapshot: "snap-1" }]);
});

// The queue always drains; a box left behind would be picked up by the next turn and filed under one of its rows.
test("draining empties the queue, so nothing carries into the next turn", async () => {
    const deps = services(mainTree.agents, { history: history([], {}) });

    await anchorSteeredMessage(deps, "c1");
    expect(takeSteerAnchors("c1")).toHaveLength(1);
    expect(takeSteerAnchors("c1")).toEqual([]);
});

// An unknown conversation has nothing to anchor against, and a failing capture isn't fatal: both just mean no bookmark.
test("an unknown conversation and a failing capture both come back empty rather than throwing", async () => {
    const unknown = services({ entry: () => undefined }, { history: history([], {}) });
    await anchorSteeredMessage(unknown, "c2");
    expect(takeSteerAnchors("c2")).toEqual([undefined]);

    const broken = services(mainTree.agents, {
        history: {
            snapshot: async () => {
                throw new Error("history is down");
            },
            list: async () => [],
        },
    });
    await anchorSteeredMessage(broken, "c3");
    expect(takeSteerAnchors("c3")).toEqual([undefined]);
});
