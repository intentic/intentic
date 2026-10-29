import type { SandboxSummary } from "@intentic/api-contract";
import { createReachabilityTelemetry, retrySandboxRead } from "../reachability";

const sandbox = (hosted: SandboxSummary["hosted"]): SandboxSummary => ({
    id: "box",
    name: "Box",
    image: null,
    daemonUrl: null,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    hosted,
    token: null,
    role: "owner",
    providedAddress: false,
    localHostname: null,
});

test("hosted Retry waits for the platform wake, then re-reads", async () => {
    const calls: string[] = [];
    let finish = () => {};
    const wake = jest.fn(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve;
                calls.push("wake");
            }),
    );
    const read = () => {
        calls.push("read");
    };
    const pending = retrySandboxRead(sandbox({ region: "iad", warm: true, state: "asleep" }), wake, read);
    expect(calls).toEqual(["wake"]);
    finish();
    await pending;
    expect(wake).toHaveBeenCalledWith("box", "retry");
    expect(calls).toEqual(["wake", "read"]);
});

test("a local Retry reads without waking another machine; a refused hosted wake remains visible", async () => {
    const wake = jest.fn(async () => {
        throw new Error("hours used up");
    });
    const read = jest.fn();
    await retrySandboxRead(sandbox(null), wake, read);
    expect(wake).toHaveBeenCalledTimes(0);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(retrySandboxRead(sandbox({ region: "iad", warm: true }), wake, read)).rejects.toThrow("hours used up");
    expect(read).toHaveBeenCalledTimes(1);
});

test("unreachable telemetry names the cause and is shared once per sandbox in a session", () => {
    const capture = jest.fn();
    const note = createReachabilityTelemetry(capture, { leaving: () => false, later: (run) => run() });
    const asleep = sandbox({ region: "iad", warm: false, state: "asleep" });
    note(asleep);
    note(asleep);
    note({ ...sandbox({ region: "iad", warm: false, state: "starting" }), id: "booting" });
    note({ ...sandbox(null), id: "local" });
    note({ ...sandbox({ region: "iad", warm: false, state: "awake" }), id: "down" });
    // (2026-10-29) One its own computer put to sleep, and one whose computer is off, are not outages either.
    note({ ...sandbox(null), id: "own-asleep", sleep: { heardAt: "2026-10-29T09:00:00.000Z", wakeable: true } });
    note({ ...sandbox(null), id: "own-offline", sleep: { heardAt: "2026-10-29T09:00:00.000Z", wakeable: false } });
    expect(capture.mock.calls).toEqual([
        ["sandbox_unreachable", { cause: "asleep", hosted: true }],
        ["sandbox_unreachable", { cause: "starting", hosted: true }],
        ["sandbox_unreachable", { cause: "down", hosted: false }],
        ["sandbox_unreachable", { cause: "down", hosted: true }],
        ["sandbox_unreachable", { cause: "asleep", hosted: false }],
        ["sandbox_unreachable", { cause: "machine-offline", hosted: false }],
    ]);
});

// In the week to 2026-10-27, 201 of 245 of these reports came from pages within 100 ms of leaving: the page cut its own
// requests, and each cut read like the sandbox going away.
test("a page on its way out reports nothing, however its failures arrive", () => {
    const capture = jest.fn();
    let leaving = true;
    const waiting: (() => void)[] = [];
    const note = createReachabilityTelemetry(capture, { leaving: () => leaving, later: (run) => waiting.push(run) });
    note(sandbox(null));
    expect(waiting).toHaveLength(0);
    // It starts leaving while the failure waits to count: dropped, and once the page turns out to stay, the box's next
    // failure is reported after all.
    leaving = false;
    note(sandbox(null));
    leaving = true;
    waiting.shift()?.();
    leaving = false;
    note(sandbox(null));
    waiting.shift()?.();
    expect(capture.mock.calls).toEqual([["sandbox_unreachable", { cause: "down", hosted: false }]]);
});

test("a failure counts only after it settles, so a page that leaves first never sends it", () => {
    const capture = jest.fn();
    const later = jest.fn();
    const note = createReachabilityTelemetry(capture, { leaving: () => false, later });
    note(sandbox(null));
    expect(capture).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledWith(expect.any(Function), 1_000);
});
