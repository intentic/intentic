import { describe, expect, it } from "bun:test";
import { fakeTurns } from "../../../testing.js";
import { deliverWake, type Wake, type WakeDoors } from "./wake-delivery.js";

// The port's door as a wake meets it, on a conversation whose session is `sess-7`.
const fake = (over: Parameters<typeof fakeTurns>[0] = {}): ReturnType<typeof fakeTurns> & { readonly doors: WakeDoors } => {
    const turns = fakeTurns(over);
    return Object.assign(turns, { doors: { turns: turns.turns, sessionIdOf: () => "sess-7" } });
};

const wake = (over: Partial<Wake> = {}): Wake => ({
    conversationId: "conv-1",
    prompt: "Watch fired: …",
    voice: "sandbox",
    profile: { agent: "claude", model: "opus" },
    ...over,
});

describe("wake delivery", () => {
    it("lands in a live turn as a steer, in the voice it was given", async () => {
        const doors = fake({ live: true });
        expect(await deliverWake(doors.doors, wake({ outside: "watch-fetch" }))).toEqual({ delivered: "steered", run: "run-live" });
        expect(doors.steers).toEqual([{ text: "Watch fired: …", voice: "sandbox", outside: "watch-fetch" }]);
        expect(doors.started).toEqual([]);
    });

    it("otherwise opens a turn on the conversation's session and routing, born tainted by what it carries", async () => {
        const doors = fake();
        expect(await deliverWake(doors.doors, wake({ outside: "watch-fetch" }))).toEqual({ delivered: "started", run: "run-1" });
        expect(doors.started).toEqual([
            { agent: "claude", model: "opus", conversationId: "conv-1", prompt: "Watch fired: …", sessionId: "sess-7", outsideWake: "watch-fetch" },
        ]);
    });

    it("leaves a wake with nothing outside in it untainted", async () => {
        const doors = fake();
        await deliverWake(doors.doors, wake());
        expect(doors.started[0]).not.toHaveProperty("outsideWake");
    });

    // Nothing retries it and nothing drops it: the conversation delivers it when it is free, and every window sees it wait.
    it("waits in the conversation's queue while a turn that takes no words runs, and is answered as queued at once", async () => {
        const doors = fake({ busy: 1 });
        expect(await deliverWake(doors.doors, wake({ outside: "watch-fetch" }))).toEqual({ delivered: "queued" });
        expect(doors.queued).toEqual([
            {
                voice: "sandbox",
                outside: "watch-fetch",
                turn: { agent: "claude", model: "opus", conversationId: "conv-1", prompt: "Watch fired: …", sessionId: "sess-7" },
            },
        ]);
        expect(doors.started).toEqual([]);
    });
});
