import type { Capability, ExitConfig, IntenticLine } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
// Static, and the mock below still wins: vitest hoists `vi.mock` above every import. Dynamic `await import()`
// inside the test would charge this module graph's load time to the test's own timeout.
import { startExitOnce } from "../exit/exit-links.js";
import { resolveProfileExit } from "./browser-exit.js";

/* THE BUDGET, and why turn setup has one at all.
 *
 * resolveProfileExit runs before every turn, for every owner bound to an exit, whether or not the turn goes
 * anywhere near a browser. Unbudgeted it waits out the whole start, and a cold tor exit allows itself two
 * minutes to bootstrap: a turn that only wanted to edit a file would sit behind it.
 *
 * What must NOT be lost in fixing that is the guarantee the binding exists for. Giving up waiting can only
 * ever produce a REFUSAL, never a browser opened without the proxy, because an account set to browse from
 * Berlin browsing from this sandbox's own address is the one outcome the whole feature is built to prevent.
 * And the abandoned start has to carry on, or the next turn would begin again from cold forever.
 */

// HOME decides where this exit's remembered state would land; pinned to a temp dir so a run leaves nothing in
// the real one.
process.env["HOME"] = "/tmp/browser-exit-budget-home";

const started = vi.fn();

// A handoff rather than a polled flag: each parked dial queues its resolver and `parked()` takes the next one,
// so there is no iteration budget to starve when the rest of the suite is running beside this file.
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

vi.mock("../exit/exit-drivers.js", () => ({
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
    // A refusal, never an exit: the caller must have nothing it could hand to a browser.
    expect(bound).not.toHaveProperty("exit");
    expect(started).toHaveBeenCalledTimes(1);

    /* And the start it walked away from is STILL RUNNING. This is the half that makes the budget cheap rather
     * than merely fast: the next turn joins this attempt and finds the exit up, instead of paying the cold
     * start again and timing out again forever. */
    const joined = startExitOnce({ id: "berlin", config: capabilities[1]?.config as ExitConfig }, "DE");
    expect(started).toHaveBeenCalledTimes(1);
    (await parked())();
    await joined;
});
