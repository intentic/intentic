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
    const note = createReachabilityTelemetry(capture);
    const asleep = sandbox({ region: "iad", warm: false, state: "asleep" });
    note(asleep);
    note(asleep);
    note({ ...sandbox({ region: "iad", warm: false, state: "starting" }), id: "booting" });
    note({ ...sandbox(null), id: "local" });
    note({ ...sandbox({ region: "iad", warm: false, state: "awake" }), id: "down" });
    expect(capture.mock.calls).toEqual([
        ["sandbox_unreachable", { cause: "asleep", hosted: true }],
        ["sandbox_unreachable", { cause: "starting", hosted: true }],
        ["sandbox_unreachable", { cause: "down", hosted: false }],
        ["sandbox_unreachable", { cause: "down", hosted: true }],
    ]);
});
