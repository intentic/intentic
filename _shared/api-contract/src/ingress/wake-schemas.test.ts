import { createHash } from "node:crypto";
import { RequestWakeAnswerSchema, RequestWakeBodySchema, WAKE_DIGESTS_MAX, WAKE_DOORS_MAX, WakeAlarmAnswerSchema, WakeAlarmBodySchema, wakeDoorCovers } from "./wake-schemas.js";

// Wake doors ride the alarm a hosted daemon already saves, so every alarm an older daemon sends keeps parsing, and a
// door list that does not parse costs the doors, never the alarm (COMPATIBILITY.md, "Across versions").

const digest = (secret: string): string => createHash("sha256").update(secret).digest("hex");
const door = { path: "/automations/auto-1/fire", digest: digest("fire-token") };

describe("an alarm with doors", () => {
    it("from a daemon from before doors parses as it always did, doors absent", () => {
        expect(WakeAlarmBodySchema.parse({ at: null, personAt: 0 })).toEqual({ at: null, personAt: 0 });
        expect(WakeAlarmBodySchema.parse({ at: 1_800_000_000_000 })).toEqual({ at: 1_800_000_000_000 });
    });

    it("keeps a list of doors, an empty one included, which clears the stored list", () => {
        expect(WakeAlarmBodySchema.parse({ at: null, doors: [door] })).toEqual({ at: null, doors: [door] });
        expect(WakeAlarmBodySchema.parse({ at: null, doors: [] })).toEqual({ at: null, doors: [] });
    });

    it("drops a door list it cannot read and keeps the alarm", () => {
        for (const doors of [
            [{ path: "automations/x", digest: door.digest }],
            [{ path: "/x", digest: "fire-token" }],
            [{ path: "/x y", digest: door.digest }],
            Array.from({ length: WAKE_DOORS_MAX + 1 }, () => door),
            "all of them",
        ]) {
            expect(WakeAlarmBodySchema.parse({ at: 1_800_000_000_000, doors })).toEqual({ at: 1_800_000_000_000 });
        }
    });

    it("is still refused for an alarm instant that is not one", () => {
        expect(WakeAlarmBodySchema.safeParse({ at: "soon", doors: [door] }).success).toBe(false);
    });

    it("is answered `ok` alone by a platform from before request wakes, and may say the boot was a request's", () => {
        expect(WakeAlarmAnswerSchema.parse({ ok: true })).toEqual({ ok: true });
        expect(WakeAlarmAnswerSchema.parse({ ok: true, requestWake: true })).toEqual({ ok: true, requestWake: true });
    });
});

describe("a door covers", () => {
    it("its own path and any path continuing it past a slash, never one that merely starts with its text", () => {
        expect(wakeDoorCovers(door, "/automations/auto-1/fire")).toBe(true);
        expect(wakeDoorCovers(door, "/automations/auto-1/fire/again")).toBe(true);
        expect(wakeDoorCovers(door, "/automations/auto-1/fireworks")).toBe(false);
        expect(wakeDoorCovers(door, "/automations/auto-1")).toBe(false);
        expect(wakeDoorCovers({ path: "/door/telegram/" }, "/door/telegram/hook")).toBe(true);
    });
});

describe("the edge's ask", () => {
    it("names a sandbox by its id and carries digests only, at most sixteen", () => {
        const ask = { sandboxId: "abcdef012345", path: "/automations/auto-1/fire", digests: [door.digest] };
        expect(RequestWakeBodySchema.parse(ask)).toEqual(ask);
        expect(RequestWakeBodySchema.safeParse({ ...ask, sandboxId: "ABC" }).success).toBe(false);
        expect(RequestWakeBodySchema.safeParse({ ...ask, digests: ["fire-token"] }).success).toBe(false);
        expect(RequestWakeBodySchema.safeParse({ ...ask, digests: Array.from({ length: WAKE_DIGESTS_MAX + 1 }, () => door.digest) }).success).toBe(false);
    });

    it("is answered whether a start is under way, whether the sandbox listens at all, and when to come back", () => {
        expect(RequestWakeAnswerSchema.parse({ waking: true, listening: true, retryAfter: 60 })).toEqual({ waking: true, listening: true, retryAfter: 60 });
        expect(RequestWakeAnswerSchema.parse({ waking: false, listening: false })).toEqual({ waking: false, listening: false });
        expect(RequestWakeAnswerSchema.safeParse({ waking: true, listening: true, retryAfter: 0 }).success).toBe(false);
    });
});
