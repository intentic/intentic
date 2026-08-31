import { expect, test, vi } from "vitest";
import { anchorSteeredMessage, takeSteerAnchors } from "./steer-anchors.js";

/* THE STRAP BETWEEN THE TWO MOMENTS A STEERED MESSAGE'S BOOKMARK EXISTS IN: the state is pinned when the turn
 * accepts the message, its index only once the turn settles. What is asserted here is the property that makes
 * pairing them safe — POSITION IS FIXED AT RESERVE TIME — because the failure it prevents is the only one on
 * this path that loses work: a queue that reordered itself files one message's state under another message's
 * index, and the rewind then restores a point the reader never saw. */

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
    // The FIRST steer's capture is the slow one, so it resolves after the second's: exactly the interleaving
    // that a queue of finished anchors (rather than of reserved boxes) would silently reorder.
    const deps = services(mainTree.agents, { history: history(finished, { "snap-1": 20 }) });

    const first = anchorSteeredMessage(deps, "c1");
    const second = anchorSteeredMessage(deps, "c1");
    await Promise.all([first, second]);

    // The captures really did finish out of order…
    expect(finished).toEqual(["snap-2", "snap-1"]);
    // …and the queue is still in the order the turn accepted the messages.
    expect(takeSteerAnchors("c1")).toEqual([
        { kind: "tree", snapshot: "snap-1" },
        { kind: "tree", snapshot: "snap-2" },
    ]);
});

/* A message that declines to be anchored still takes its box. Skipping it would shift every later message in
 * the turn up one place, which is the mis-indexing this file exists to make impossible: an empty box is a
 * message with no state behind it, which every surface already draws honestly. */
test("a conversation whose state is elsewhere leaves an empty box rather than no box", async () => {
    const entries = [{ id: "c1", runner: "mac-1" }, { id: "c1" }];
    let at = 0;
    const deps = services({ entry: () => entries[at++] }, { history: history([], {}) });

    await anchorSteeredMessage(deps, "c1");
    await anchorSteeredMessage(deps, "c1");

    expect(takeSteerAnchors("c1")).toEqual([undefined, { kind: "tree", snapshot: "snap-1" }]);
});

// The queue drains whatever happened, because a box left behind is picked up by the NEXT turn and filed under
// one of ITS rows.
test("draining empties the queue, so nothing carries into the next turn", async () => {
    const deps = services(mainTree.agents, { history: history([], {}) });

    await anchorSteeredMessage(deps, "c1");
    expect(takeSteerAnchors("c1")).toHaveLength(1);
    expect(takeSteerAnchors("c1")).toEqual([]);
});

// A conversation the registry has never heard of has nothing to anchor against, and a failing capture is not
// fatal: both are "this message keeps no bookmark".
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
