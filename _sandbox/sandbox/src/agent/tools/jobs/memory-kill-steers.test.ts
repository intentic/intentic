import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { killSteers, steerText } from "./memory-kill-steers.js";

/* 2026-11-17, the shinobi-society audit: a burst of memory kills reached one turn as one steer per kill. A conversation's
   kills in one window are said together, once the window after its first closes. */

const actors = memoryFleet().conversations;

const listening = () => {
    const steered: { conversationId: string; text: string }[] = [];
    const conversations = {
        ...actors,
        steer: (conversationId: string, text: string) => {
            steered.push({ conversationId, text });
            return true;
        },
    };
    return { conversations, steered };
};

test("a conversation's kills in one window are said once, when the window closes; a kill after it opens the next", async () => {
    const { conversations, steered } = listening();
    const steers = killSteers(conversations, 30);
    steers.add("conv-a", "sccache was killed");
    steers.add("conv-b", "python was killed");
    steers.add("conv-a", "rustc was killed");
    expect(steered).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(steered).toEqual([
        { conversationId: "conv-a", text: "2 processes this conversation started were killed for memory:\n- sccache was killed\n- rustc was killed" },
        { conversationId: "conv-b", text: "python was killed" },
    ]);
    steers.add("conv-a", "cc1plus was killed");
    steers.flush();
    expect(steered.at(-1)).toEqual({ conversationId: "conv-a", text: "cc1plus was killed" });
    steers.flush();
    expect(steered).toHaveLength(3);
});

test("one kill is said as it is, several as a counted list", () => {
    expect(steerText(["one"])).toBe("one");
    expect(steerText(["one", "two"])).toBe("2 processes this conversation started were killed for memory:\n- one\n- two");
});
