import { type AgentProvider, type NativeProvider, PROVIDER_SPECS } from "@intentic/sandbox-contract";

// Which way in a reader is choosing between, and which providers sit behind each. Pure: the view reads readiness and
// hardware from elsewhere and hands them in, so the ordering rules here are testable without a sandbox.
//
// The one product decision encoded here: cost leads. A reader who has connected nothing should be able to see, without
// connecting anything, which of these costs them money and which does not — so the free sign-in comes first, the
// machine they already own second, and the subscriptions they may or may not hold last.

export type ConnectLaneKey = "free" | "local" | "subscription";

export interface ConnectLane {
    readonly key: ConnectLaneKey;
    // Providers this lane connects, in offer order. Empty for `local`, whose subject is a model, not an account.
    readonly providers: readonly NativeProvider[];
}

// Derived from the spec table rather than listed, so a provider that stops being free stops being promoted, and a new
// row lands in a lane without an edit here.
const FREE = PROVIDER_SPECS.filter((spec) => spec.access.kind === "free").map((spec) => spec.id);
const SUBSCRIPTION = PROVIDER_SPECS.filter((spec) => spec.access.kind === "subscription").map((spec) => spec.id);

export const CONNECT_LANES: readonly ConnectLane[] = [
    { key: "free", providers: FREE },
    { key: "local", providers: [] },
    { key: "subscription", providers: SUBSCRIPTION },
];

export const connectLane = (key: ConnectLaneKey): ConnectLane => CONNECT_LANES.find((lane) => lane.key === key)!;

// Which lane a provider is reached through, for a deep link that names a provider rather than a lane.
export const laneOfProvider = (provider: AgentProvider): ConnectLaneKey | undefined =>
    CONNECT_LANES.find((lane) => (lane.providers as readonly string[]).includes(provider))?.key;

// The lane to open on arrival with nothing asked for: the first holding nothing yet, so a reader already signed in to
// Google is offered the next thing; every lane held opens none, since there is nothing left to decide.
export const firstUnmetLane = (held: (key: ConnectLaneKey) => boolean): ConnectLaneKey | undefined => CONNECT_LANES.find((lane) => !held(lane.key))?.key;

// Providers offered inside a lane, connected ones last: a row that is already done is still worth showing (a second
// account, a reconnect) but must not sit above the thing the reader came here to do.
export const laneProviders = (key: ConnectLaneKey, ready: (provider: AgentProvider) => boolean): readonly NativeProvider[] => {
    const providers = connectLane(key).providers;
    return [...providers.filter((provider) => !ready(provider)), ...providers.filter((provider) => ready(provider))];
};
