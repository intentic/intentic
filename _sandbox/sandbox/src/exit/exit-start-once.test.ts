import type { ExitConfig, IntenticLine } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { startExitOnce } from "./exit-links.js";

// A turn's browser setup gives an exit a budget, then moves on; the abandoned start keeps running. A later call for the
// same exit must join that attempt, not begin a second one against the same interface and port.

// HOME decides where this start's observation lands; pinned to a temp dir so a test run leaves nothing real.
process.env["HOME"] = "/tmp/exit-start-once-home";

const started: string[] = [];

// A handoff, not a poll: dials are matched to waiters in order, so releasing one start can never fire a different one's
// resolver, and there's no iteration budget to starve.
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

vi.mock("./exit-drivers.js", () => ({
    exitDrivers: {
        tor: {
            missingTool: async () => undefined,
            probe: async () => ({ state: "down" }),
            // Parked until the test releases it, which is what makes a second call while one is in flight testable.
            async *start(id: string): AsyncGenerator<IntenticLine> {
                started.push(id);
                await new Promise<void>((resolve) => onDial(resolve));
                yield { kind: "log", message: "up" };
            },
            observe: async () => ({ ip: "5.9.1.1", country: "DE", countryName: "Germany" }),
            stop: async () => undefined,
        },
    },
}));

const entry = { id: "berlin", config: { provider: "tor", autoStart: "off" } as ExitConfig };

test("a second start joins the one already in flight, and a new one is allowed once it settles", async () => {
    const first = startExitOnce(entry, "DE");
    const second = startExitOnce(entry, "DE");
    // The same promise, not merely an equivalent one: the point is that no second dial was attempted.
    expect(second).toBe(first);

    const release = await parked();
    expect(started).toEqual(["berlin"]);
    release();
    await first;
    expect(started).toEqual(["berlin"]);

    // The sharing must not outlive the attempt: an exit that went down after a successful start must be startable
    // again, not resolve to a tunnel that no longer exists.
    const later = startExitOnce(entry, "DE");
    expect(later).not.toBe(first);
    (await parked())();
    await later;
    expect(started).toEqual(["berlin", "berlin"]);
});
