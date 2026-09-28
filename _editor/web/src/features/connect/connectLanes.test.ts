import { FREE_PROVIDERS, PROVIDER_SPECS } from "@intentic/sandbox-contract";
import { arrivalLane, CONNECT_LANES, laneOfProvider, laneProviders } from "./connectLanes";

/* The order a reader meets the ways in, and the rule that decides it: cost, not vendor. */

const only =
    (...connected: string[]) =>
    (provider: string) =>
        connected.includes(provider);

test("cost leads: free first, this machine second, subscriptions last", () => {
    expect(CONNECT_LANES.map((lane) => lane.key)).toEqual([`free`, `local`, `subscription`]);
    // Membership is the spec table's own verdict, never a list typed here.
    expect(connectLaneProviders(`free`)).toEqual(FREE_PROVIDERS);
    expect(connectLaneProviders(`subscription`)).toEqual(PROVIDER_SPECS.filter((spec) => spec.access.kind === `subscription`).map((spec) => spec.id));
    // Every provider is reachable through exactly one lane: one the reader cannot get to is one they cannot connect.
    expect(PROVIDER_SPECS.map((spec) => laneOfProvider(spec.id))).toEqual(
        PROVIDER_SPECS.map((spec) => (spec.access.kind === `free` ? `free` : `subscription`)),
    );
});

const connectLaneProviders = (key: `free` | `local` | `subscription`) => CONNECT_LANES.find((lane) => lane.key === key)!.providers;

test("the free lane opens only for a reader who has connected nothing", () => {
    expect(arrivalLane(() => false)).toBe(`free`);
    // A subscription already connected: the reader chose a way in, so the free sign-in is not opened at them again.
    expect(arrivalLane((key) => key === `subscription`)).toBeUndefined();
    // Nor is the next lane after a Google sign-in: one connected model ends the offering, whichever lane it was.
    expect(arrivalLane((key) => key === `free`)).toBeUndefined();
    expect(arrivalLane((key) => key === `local`)).toBeUndefined();
    expect(arrivalLane(() => true)).toBeUndefined();
});

test("a connected provider keeps its row but loses its place at the top", () => {
    const subscriptions = connectLaneProviders(`subscription`);
    const first = subscriptions[0]!;
    const ordered = laneProviders(`subscription`, only(first));
    expect(ordered).toHaveLength(subscriptions.length);
    expect(ordered.at(-1)).toBe(first);
    // Order among the unconnected is the table's, untouched.
    expect(ordered.slice(0, -1)).toEqual(subscriptions.filter((provider) => provider !== first));
});
