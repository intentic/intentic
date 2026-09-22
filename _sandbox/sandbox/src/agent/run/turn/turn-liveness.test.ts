import { afterEach, expect, test } from "bun:test";
import { registerTurn } from "../../checkpoints/agent-steering.js";
import { watchProjection } from "../../verification/watch-state.js";
import { conversationBusy } from "./turn-liveness.js";

afterEach(() => {
    watchProjection.forget(["c-watch", "c-idle", "c-turn"]);
});

test("a conversation with nothing in flight is not busy", () => {
    expect(conversationBusy("c-idle")).toBe(false);
});

test("a registered turn keeps its conversation busy", () => {
    const unregister = registerTurn("c-turn", { abort: () => {} });
    expect(conversationBusy("c-turn")).toBe(true);
    unregister();
    expect(conversationBusy("c-turn")).toBe(false);
});

// A watched conversation's processes are what its watch waits on; reclaiming them strands the watch.
test("a conversation parked on an armed watch is busy, and stops being so once the watch is gone", () => {
    watchProjection.set("c-watch", [{ id: "watch-k3f9", note: "final sweep", intervalSeconds: 120, deadlineAt: Date.now() + 60_000 }]);
    expect(conversationBusy("c-watch")).toBe(true);
    watchProjection.set("c-watch", []);
    expect(conversationBusy("c-watch")).toBe(false);
});
