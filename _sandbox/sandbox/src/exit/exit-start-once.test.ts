import type { ExitConfig, IntenticLine } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
// Statically imported even though the mock below has to win: vitest hoists `vi.mock` above every import, so
// this still gets the fake drivers. Dynamic `await import()` inside the test would work too, and would charge
// this module graph's load time to the test's own timeout, which is what made these fail under a full run.
import { startExitOnce } from "./exit-links.js";

/* SHARING ONE START, which stopped being a nicety the moment a caller could WALK AWAY from one.
 *
 * A turn's browser setup gives an exit a few seconds to come up and then gets on with the turn (see
 * resolveProfileExit's budget). The start it abandoned keeps running, so the next turn asking the same
 * question must JOIN that attempt rather than begin a second one against the same interface, the same conf
 * and the same derived proxy port, where the loser's failure would tear down the winner's working exit.
 */

// HOME decides where the observation this start writes would land; pinned to a temp dir, as tor.test.ts does,
// so a test run leaves nothing in the real one.
process.env["HOME"] = "/tmp/exit-start-once-home";

const started: string[] = [];

/* A HANDOFF, NOT A POLL. Each parked dial queues its resolver and `parked()` takes the next one, waiting on a
 * promise if it has not happened yet. Two properties matter and a polled flag has neither: dials are matched
 * to waiters IN ORDER, so releasing one start can never fire the previous one's resolver, and there is no
 * iteration budget to starve, which is what made the polled version fail only when the rest of the suite was
 * running beside it. */
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
            // Parked until the test lets it go, which is what makes "a second call while one is in flight"
            // expressible at all.
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

    /* And the sharing does NOT outlive the attempt. An exit that went down after a successful start has to be
     * startable again; a map entry left behind would hand every later caller a promise that resolved to a
     * tunnel which no longer exists. */
    const later = startExitOnce(entry, "DE");
    expect(later).not.toBe(first);
    (await parked())();
    await later;
    expect(started).toEqual(["berlin", "berlin"]);
});
