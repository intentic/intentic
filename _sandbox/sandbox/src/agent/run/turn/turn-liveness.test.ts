import { memoryFleet } from "../../../testing.js";
import { conversationBusy } from "./turn-liveness.js";

test("a conversation with nothing in flight is not busy", () => {
    expect(conversationBusy(memoryFleet().conversations, "c-idle")).toBe(false);
});

test("a registered turn keeps its conversation busy", () => {
    const { conversations } = memoryFleet();
    const unregister = conversations.registerTurn("c-turn", { abort: () => {} });
    expect(conversationBusy(conversations, "c-turn")).toBe(true);
    unregister();
    expect(conversationBusy(conversations, "c-turn")).toBe(false);
});

// A watched conversation's processes are what its watch waits on; reclaiming them strands the watch.
test("a conversation parked on an armed watch is busy, and stops being so once the watch is gone", () => {
    const { conversations } = memoryFleet();
    conversations.send("c-watch", {
        kind: "watches-shown",
        watches: [{ id: "watch-k3f9", note: "final sweep", intervalSeconds: 120, deadlineAt: Date.now() + 60_000 }],
    });
    expect(conversationBusy(conversations, "c-watch")).toBe(true);
    conversations.send("c-watch", { kind: "watches-shown", watches: [] });
    expect(conversationBusy(conversations, "c-watch")).toBe(false);
});
