import { describe, expect, it } from "vitest";
import { applyConnectionSignal, classifyFailure, initialConnection, type ConnectionSignal, type ConnectionState } from "./connection";
import { SANDBOX_BUSY_AFTER_MS, sandboxAvailability, sandboxRequiresGate } from "./availability";

const drive = (...signals: readonly ConnectionSignal[]): ConnectionState => signals.reduce(applyConnectionSignal, initialConnection);
const failed = (at: number): ConnectionSignal => ({ kind: "failed", failure: classifyFailure({ message: "tunnel down" }), at });

describe(`sandboxAvailability`, () => {
    it(`keeps an established workspace quietly stale through transient retries`, () => {
        const state = drive({ kind: "frame" }, failed(1_000), { kind: "connect" }, { kind: "opened" }, failed(2_000));
        expect(sandboxAvailability(state, true, true, 1_000 + SANDBOX_BUSY_AFTER_MS - 1)).toBe("stale");
        // Retry velocity does not move the presentation clock: the first observed failure owns it.
        expect(state.unavailableSince).toBe(1_000);
    });

    it(`names a wait only after elapsed unavailability crosses the busy threshold`, () => {
        const state = drive({ kind: "frame" }, failed(1_000));
        expect(sandboxAvailability(state, true, true, 1_000 + SANDBOX_BUSY_AFTER_MS)).toBe("busy");
    });

    it(`treats a restored snapshot as established even before this session receives a frame`, () => {
        const state = drive({ kind: "connect" }, failed(1_000));
        expect(state.everOnline).toBe(false);
        expect(sandboxAvailability(state, true, true, 1_000 + SANDBOX_BUSY_AFTER_MS)).toBe("busy");
        expect(sandboxAvailability(state, true, false, 1_000 + SANDBOX_BUSY_AFTER_MS)).toBe("starting");
    });

    it(`surfaces blocked causes immediately and warming separately`, () => {
        const blocked = drive({
            kind: "failed",
            failure: classifyFailure({ unaddressed: true, message: "no address" }),
            at: 1_000,
        });
        expect(sandboxAvailability(blocked, true, true, 1_000)).toBe("blocked");
        expect(sandboxAvailability(drive({ kind: "frame" }), false, true, 1_000)).toBe("warming");
    });

    it(`returns live and clears the outage clock on the first recovered frame`, () => {
        const state = drive({ kind: "frame" }, failed(1_000), { kind: "frame" });
        expect(state.unavailableSince).toBeUndefined();
        expect(sandboxAvailability(state, true, true, 1_000 + SANDBOX_BUSY_AFTER_MS)).toBe("live");
    });
});

describe(`sandboxRequiresGate`, () => {
    it(`keeps an established workspace mounted through stale, busy, and warming states`, () => {
        expect(sandboxRequiresGate(false, true, "stale")).toBe(false);
        expect(sandboxRequiresGate(false, true, "busy")).toBe(false);
        expect(sandboxRequiresGate(false, true, "warming")).toBe(false);
    });

    it(`gates a first connection and every blocked cause`, () => {
        expect(sandboxRequiresGate(false, false, "starting")).toBe(true);
        expect(sandboxRequiresGate(false, true, "blocked")).toBe(true);
    });

    it(`lets a reachable first view own its ordinary data-loading state`, () => {
        expect(sandboxRequiresGate(true, false, "live")).toBe(false);
    });
});
