import type { Capability, ExitConfig, IntenticLine } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { startExitOnce } from "../../exit/exit-links.js";
import { resolveProfileExit } from "./browser-exit.js";

// Budgets resolveProfileExit's wait, since an unbudgeted cold start (tor's ~2min bootstrap) would stall every turn.
// Giving up must only ever refuse, never hand back a browser with no proxy; the abandoned start keeps running for the
// next turn to join.

// HOME decides where this exit's state lands; pinned to a temp dir so a run leaves nothing in the real one.
process.env["HOME"] = "/tmp/browser-exit-budget-home";

const started = vi.fn();

// Handoff, not a polled flag: each parked dial queues its resolver, so nothing starves under a loaded suite.
const dials: (() => void)[] = [];
const waiters: ((release: () => void) => void)[] = [];

const onDial = (release: () => void): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
        dials.push(release);
        return;
    }
    waiter(release);
};

const parked = (): Promise<() => void> => {
    const ready = dials.shift();
    return ready === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(ready);
};

vi.mock("../../exit/exit-drivers.js", () => ({
    exitDrivers: {
        tor: {
            missingTool: async () => undefined,
            probe: async () => ({ state: "down" }),
            async *start(id: string): AsyncGenerator<IntenticLine> {
                started(id);
                await new Promise<void>((resolve) => onDial(resolve));
                yield { kind: "log", message: "up" };
            },
            observe: async () => ({ ip: "5.9.1.1", country: "DE", countryName: "Germany" }),
            stop: async () => undefined,
        },
    },
}));

const capabilities: Capability[] = [
    { id: "work", kind: "identity", config: { email: "work@example.com", openAccounts: "off", exit: "berlin" } } as Capability,
    { id: "berlin", kind: "exit", config: { provider: "tor", autoStart: "off" } as ExitConfig } as Capability,
];

test("a start that outruns the budget refuses the browser instead of stalling the turn", async () => {
    const began = Date.now();
    const bound = await resolveProfileExit(capabilities, "work", 250);
    const waited = Date.now() - began;

    // Released by the budget, not by the start: the driver is still parked at this point.
    expect(waited).toBeLessThan(3_000);
    expect(bound).toEqual(expect.any(Object));
    expect(bound).toHaveProperty("refusal");
    expect(bound).not.toHaveProperty("exit");
    expect(started).toHaveBeenCalledTimes(1);

    // Start walked away from keeps running: the next turn joins it and finds the exit already coming up.
    const joined = startExitOnce({ id: "berlin", config: capabilities[1]?.config as ExitConfig }, "DE");
    expect(started).toHaveBeenCalledTimes(1);
    (await parked())();
    await joined;
});
