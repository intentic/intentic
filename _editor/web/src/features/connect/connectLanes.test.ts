import { FREE_PROVIDERS, PROVIDER_SPECS } from "@intentic/sandbox-contract";
import { test, expect } from "bun:test";
import { anythingConnected, CONNECT_LANES, firstUnmetLane, laneOfProvider, laneProviders } from "./connectLanes";

/* The order a reader meets the ways in, and the rule that decides it: cost, not vendor. */

const none = () => false;
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

test("the lane that opens is the first with nothing in it", () => {
    expect(firstUnmetLane(none, false)).toBe(`free`);
    // Google already signed in: the next unanswered question is the machine, not another Google account.
    expect(firstUnmetLane(only(...FREE_PROVIDERS), false)).toBe(`local`);
    expect(firstUnmetLane(only(...FREE_PROVIDERS), true)).toBe(`subscription`);
    // Nothing left to decide opens nothing rather than falling back to the first lane.
    expect(firstUnmetLane(() => true, true)).toBeUndefined();
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

test("a local model alone counts as connected, with no account anywhere", () => {
    expect(anythingConnected(none, false)).toBe(false);
    expect(anythingConnected(none, true)).toBe(true);
    expect(anythingConnected(only(...FREE_PROVIDERS), false)).toBe(true);
});
