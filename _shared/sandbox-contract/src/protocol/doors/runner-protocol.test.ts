import { runnerLinkReading, RunnerLinkReadingSchema } from "./runner-protocol.js";

// What the machine's keeper reads to tell a runner whose link is down from one that is up (runner-protocol.ts).

const PARENT = "https://sandbox-a4ba63bf2aa5.sbx.intentic.dev";

test("an open link says so and nothing about an outage it is not in", () => {
    const reading = runnerLinkReading({ state: () => "open", outage: () => undefined }, PARENT, false, 0, 1_000);
    expect(reading).toEqual({ at: 1_000, parent: PARENT, state: "open", working: 0 });
    expect(RunnerLinkReadingSchema.parse(reading)).toEqual(reading);
});

test("a failing link says since when, how many tries, and the work a restart would cut", () => {
    const reading = runnerLinkReading({ state: () => "connecting", outage: () => ({ failures: 7, since: 500 }) }, PARENT, false, 2, 1_000);
    expect(reading).toEqual({ at: 1_000, parent: PARENT, state: "connecting", since: 500, failures: 7, working: 2 });
});

test("a refused enrollment is said, since only re-pairing brings that runner back", () => {
    const reading = runnerLinkReading({ state: () => "closed", outage: () => undefined }, PARENT, true, 0, 1_000);
    expect(reading.revoked).toBe(true);
    expect(reading.state).toBe("closed");
});
