import { beforeEach, expect, test } from "vitest";
import { forgetRemoteRequest, forgetRemoteRequestsOf, noteRemoteRequest, remoteRequestOf, resetRemoteRequests } from "./runner-requests.js";

/* The table that lets a parent answer a card it did not raise. Its whole job is to survive a stream a remote
 * agent controls, so what is pinned here is the bounding and the forgetting, not the happy path alone. */

beforeEach(() => resetRemoteRequests());

test("an id remembers the machine and the conversation it was raised for", () => {
    noteRemoteRequest("req-1", { runnerId: "rog", conversationId: "c1" });
    expect(remoteRequestOf("req-1")).toEqual({ runnerId: "rog", conversationId: "c1" });
    expect(remoteRequestOf("never-raised")).toBeUndefined();
});

test("a card's resolution forgets it: a late answer must not be sent at a runner that closed it", () => {
    noteRemoteRequest("req-1", { runnerId: "rog", conversationId: "c1" });
    forgetRemoteRequest("req-1");
    expect(remoteRequestOf("req-1")).toBeUndefined();
});

test("a turn ending drops every card it still had parked, and leaves other conversations alone", () => {
    noteRemoteRequest("a", { runnerId: "rog", conversationId: "c1" });
    noteRemoteRequest("b", { runnerId: "rog", conversationId: "c1" });
    noteRemoteRequest("c", { runnerId: "omen", conversationId: "c2" });
    forgetRemoteRequestsOf("c1");
    expect(remoteRequestOf("a")).toBeUndefined();
    expect(remoteRequestOf("b")).toBeUndefined();
    expect(remoteRequestOf("c")).toEqual({ runnerId: "omen", conversationId: "c2" });
});

/* THE BOUND, and the reason it evicts the OLDEST rather than refusing new ones: the ids arrive from a remote
 * agent's own frames, so an unbounded table is memory a stranger's turn can grow, and refusing the newest
 * would make the currently-parked card the one that cannot be answered. */
test("the table is bounded, oldest-first, and re-noting an id does not renew its place", () => {
    for (let index = 0; index < 2_000; index += 1) {
        noteRemoteRequest(`req-${index}`, { runnerId: "rog", conversationId: `c${index}` });
    }
    // Re-noting the oldest keeps its original position, so it is still the next to go.
    noteRemoteRequest("req-0", { runnerId: "rog", conversationId: "moved?" });
    expect(remoteRequestOf("req-0")?.conversationId).toBe("c0");
    noteRemoteRequest("req-2000", { runnerId: "rog", conversationId: "c2000" });
    expect(remoteRequestOf("req-0")).toBeUndefined();
    expect(remoteRequestOf("req-1")).toEqual({ runnerId: "rog", conversationId: "c1" });
    expect(remoteRequestOf("req-2000")).toEqual({ runnerId: "rog", conversationId: "c2000" });
});
