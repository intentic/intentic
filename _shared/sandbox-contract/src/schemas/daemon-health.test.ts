import { type DaemonHealth, DaemonHealthReadingSchema, DaemonHealthSchema } from "./system.js";

const answer: DaemonHealth = {
    ok: true,
    sandboxId: "0123456789ab",
    profile: "workspace",
    boot: { ready: true, startedAt: 1, steps: [] },
    state: { journal: "none", engine: 84 },
    announce: { state: "registered", at: 2 },
    reach: { state: "reachable", at: 3 },
    reachedBy: "tunnel",
    build: { version: "1.2.3" },
};

test("the daemon's answer parses whole as the contract's health", () => {
    expect(DaemonHealthSchema.parse(answer)).toEqual(answer);
});

test("a reader takes any daemon's answer, a field of the wrong shape reading as missing", () => {
    expect(DaemonHealthReadingSchema.parse({ ok: true, ready: false, boot: "starting", state: { journal: 7 }, reachedBy: "tunnel" })).toEqual({
        ok: true,
        ready: false,
        boot: undefined,
        state: { journal: undefined },
        reachedBy: "tunnel",
    });
    expect(DaemonHealthReadingSchema.parse(answer)).toMatchObject({ sandboxId: "0123456789ab", boot: { ready: true }, announce: { state: "registered" } });
});
