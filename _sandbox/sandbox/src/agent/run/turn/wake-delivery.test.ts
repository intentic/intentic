import { pino } from "pino";
import { describe, expect, it } from "bun:test";
import { fakeTurns } from "../../../testing.js";
import { deliverWake, type Wake, type WakeDoors, wakeOnce } from "./wake-delivery.js";

const logger = pino({ level: "silent" });

// The port's doors as a wake meets them, on a conversation whose session is `sess-7`.
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

const pacing = { attempts: 3, retryMs: 1, logger, context: {} };

describe("wake delivery", () => {
    it("lands in a live turn as a steer, in the voice it was given", async () => {
        const doors = fake({ live: true });
        expect(await wakeOnce(doors.doors, wake({ outside: "watch-fetch" }))).toBe("steered");
        expect(doors.steers).toEqual([{ text: "Watch fired: …", voice: "sandbox", outside: "watch-fetch" }]);
        expect(doors.started).toEqual([]);
    });

    it("otherwise opens a turn on the conversation's session and routing, born tainted by what it carries", async () => {
        const doors = fake();
        expect(await wakeOnce(doors.doors, wake({ outside: "watch-fetch" }))).toBe("started");
        expect(doors.started).toEqual([
            { agent: "claude", model: "opus", conversationId: "conv-1", prompt: "Watch fired: …", sessionId: "sess-7", outsideWake: "watch-fetch" },
        ]);
    });

    it("leaves a wake with nothing outside in it untainted", async () => {
        const doors = fake();
        await wakeOnce(doors.doors, wake());
        expect(doors.started[0]).not.toHaveProperty("outsideWake");
    });

    it("retries while a turn is live but takes no words, and through a start that throws", async () => {
        const doors = fake({ busy: 1, throwsFirst: true });
        expect(await deliverWake(doors.doors, wake(), pacing)).toBe("started");
        expect(doors.started).toHaveLength(1);
    });

    it("answers busy once every attempt found the conversation occupied, for the caller to report", async () => {
        const doors = fake({ busy: 5 });
        expect(await deliverWake(doors.doors, wake(), pacing)).toBe("busy");
        expect(doors.started).toEqual([]);
    });
});
