import { FREE_PROVIDERS, PROVIDER_SPECS } from "@intentic/sandbox-contract";
import { arrivalLane, CONNECT_LANES, justLanded, landedLine, laneOfProvider, laneProviders, linkArrival } from "./connectLanes";

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

// The chat's Reconnect lands here for a provider that is connected, one account of it needing a new sign-in: the page
// said "Connected" and "Connecting Claude… paste the code" at once, having started a sign-in nobody pressed.
test("a link naming a connected provider opens its lane and leaves the sign-in to the reader's press", () => {
    const subscription = connectLaneProviders(`subscription`)[0]!;
    expect(linkArrival(subscription, only(subscription))).toEqual({ lane: `subscription`, signIn: false });
    // Nothing of it connected: the link is the request, and asking for the tile as well would be asking twice.
    expect(linkArrival(subscription, only())).toEqual({ lane: `subscription`, signIn: true });
    expect(linkArrival(`no-such-provider`, only())).toBeUndefined();
});

test("a sign-in has landed only when the picked provider becomes settled, not when an already settled one is picked", () => {
    expect(justLanded({ provider: `claude`, settled: true }, { provider: `claude`, settled: false })).toBe(`claude`);
    // Picked while already connected (a second account, a reconnect): the sign-in is only starting.
    expect(justLanded({ provider: `claude`, settled: true }, undefined)).toBeUndefined();
    expect(justLanded({ provider: `claude`, settled: true }, { provider: `codex`, settled: false })).toBeUndefined();
    // Still waiting on the reconnect, or never picked.
    expect(justLanded({ provider: `claude`, settled: false }, { provider: `claude`, settled: false })).toBeUndefined();
    expect(justLanded(undefined, { provider: `claude`, settled: false })).toBeUndefined();
});

// What a reader connects lives in one sandbox, so the banner names it: one connected ChatGPT in a second sandbox,
// removed that sandbox, and lost the connection without having been told where it went.
test("the landed banner names the sandbox the account was connected to", () => {
    expect(landedLine(`ChatGPT`, `workspace-2`)).toBe(`ChatGPT connected to "workspace-2". Chats in this sandbox can use it now.`);
    // No sandbox name to give (none bound yet): the plain line rather than an empty pair of quotes.
    expect(landedLine(`ChatGPT`, undefined)).toBe(`Connected. This workspace can run turns now.`);
});
