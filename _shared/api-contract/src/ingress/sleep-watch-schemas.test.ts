import { PLATFORM_INGRESS } from "./routes.js";
import {
    SLEEP_WATCHES_MAX,
    SleepHeardBodySchema,
    SleepHeardSchema,
    SleepWatchAnswerSchema,
    SleepWatchBodySchema,
} from "./sleep-watch-schemas.js";

// A sleep watch hands a credential to the platform, so its shapes are strict: a service the watcher does not speak, an
// empty credential or more connections than one sleep may hand over are refused outright, never trimmed.

const watch = { service: "discord" as const, connection: "discord-team", credential: "MTIz.bot.token" };

describe("handing connections over before a sleep", () => {
    it("takes up to the cap, and an empty list, which drops every held one", () => {
        expect(SleepWatchBodySchema.parse({ watches: [watch] })).toEqual({ watches: [watch] });
        expect(SleepWatchBodySchema.parse({ watches: [] })).toEqual({ watches: [] });
        expect(SleepWatchBodySchema.safeParse({ watches: Array.from({ length: SLEEP_WATCHES_MAX + 1 }, () => watch) }).success).toBe(false);
    });

    it("refuses a service the platform does not speak, and a connection with no credential", () => {
        expect(SleepWatchBodySchema.safeParse({ watches: [{ ...watch, service: "slack" }] }).success).toBe(false);
        expect(SleepWatchBodySchema.safeParse({ watches: [{ ...watch, credential: "" }] }).success).toBe(false);
        expect(SleepWatchBodySchema.safeParse({ watches: [{ service: "discord", connection: "discord-team" }] }).success).toBe(false);
    });

    it("is answered with how many it holds", () => {
        expect(SleepWatchAnswerSchema.parse({ ok: true, held: 1 })).toEqual({ ok: true, held: 1 });
    });
});

describe("what was heard while it slept", () => {
    it("names where a message is, never what it says", () => {
        const heard = { service: "discord" as const, connection: "discord-team", channelId: "1180", messageId: "1181", guildId: "1179", at: 1_800_000_000_000 };
        expect(SleepHeardSchema.parse({ heard: [heard] })).toEqual({ heard: [heard] });
        const { guildId: _dm, ...direct } = heard;
        expect(SleepHeardSchema.parse({ heard: [direct] })).toEqual({ heard: [direct] });
        expect(SleepHeardSchema.parse({ heard: [{ ...heard, content: "hello" }] }).heard[0]).not.toHaveProperty("content");
        expect(SleepHeardSchema.safeParse({ heard: [{ ...heard, channelId: "general" }] }).success).toBe(false);
    });

    it("is asked for the connections of one extension's cards", () => {
        expect(SleepHeardBodySchema.parse({ connections: ["discord-team"] })).toEqual({ connections: ["discord-team"] });
        expect(SleepHeardBodySchema.safeParse({ connections: [""] }).success).toBe(false);
    });
});

test("both routes are the daemon's own, under its connect token", () => {
    expect(PLATFORM_INGRESS.sleepWatch).toMatchObject({ method: "POST", path: "/sandbox/sleep-watch", auth: "connect" });
    expect(PLATFORM_INGRESS.sleepHeard).toMatchObject({ method: "POST", path: "/sandbox/sleep-watch/heard", auth: "connect" });
});
