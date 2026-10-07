import { type AgentProvider, type NativeProvider, PROVIDER_SPECS, type ProviderKey, type ProviderKeySource } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

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

// The lane to open on arrival with nothing asked for: the free one, but only while no lane holds anything. A reader
// who has connected a model has already chosen a way in, and opening the free sign-in on every later visit would be a
// pitch; they get every lane shut and pick for themselves.
export const arrivalLane = (held: (key: ConnectLaneKey) => boolean): ConnectLaneKey | undefined =>
    CONNECT_LANES.some((lane) => held(lane.key)) ? undefined : CONNECT_LANES[0]!.key;

// Providers offered inside a lane, connected ones last: a row that is already done is still worth showing (a second
// account, a reconnect) but must not sit above the thing the reader came here to do.
export const laneProviders = (key: ConnectLaneKey, ready: (provider: AgentProvider) => boolean): readonly NativeProvider[] => {
    const providers = connectLane(key).providers;
    return [...providers.filter((provider) => !ready(provider)), ...providers.filter((provider) => ready(provider))];
};

// What a link naming a provider (`?provider=`: the chat's Reconnect, a picker row) does on arrival: open that provider's
// lane, and start its sign-in only while nothing of it is connected. One already connected, an account needing a
// reconnect included, waits for the reader's press on its tile: a sign-in the page started by itself sat under
// "Connected" and read as the page contradicting itself. Undefined for a provider no lane connects.
export const linkArrival = (
    provider: AgentProvider,
    ready: (provider: AgentProvider) => boolean,
): { readonly lane: ConnectLaneKey; readonly signIn: boolean } | undefined => {
    const lane = laneOfProvider(provider);
    return lane === undefined ? undefined : { lane, signIn: !ready(provider) };
};

// The picked provider's standing, as the view reads it on every change: connected with nothing left to reconnect.
export interface PickedStanding {
    readonly provider: AgentProvider;
    readonly settled: boolean;
}

// The provider whose sign-in just landed: settled now and not before, for the same pick. Picking one that is already
// settled (to add a second account) is a sign-in starting, not one that landed.
export const justLanded = (now: PickedStanding | undefined, before: PickedStanding | undefined): AgentProvider | undefined =>
    now?.settled === true && before?.provider === now.provider && !before.settled ? now.provider : undefined;

// The banner once a sign-in lands: what was connected, and to which sandbox. What a reader connects lives in that one
// sandbox, not on the account: a new user connected ChatGPT in a second sandbox, removed it, and lost the connection.
export const landedLine = (label: string, sandboxName: string | undefined): string =>
    sandboxName === undefined || sandboxName === ``
        ? t(`connect.connect.landed`)
        : t(`connect.connect.landedIn`, { provider: label, sandbox: sandboxName });

// "Found on this computer", above the lanes: the providers the desktop app found signed in here (`?found=`) that this
// sandbox does not hold yet, in lane order, so the same rule (cost leads) orders them as orders everything below. One
// that becomes ready leaves the list, and the banner over the lanes says so instead.
export const foundSignIns = (found: readonly AgentProvider[], ready: (provider: AgentProvider) => boolean): readonly NativeProvider[] =>
    CONNECT_LANES.flatMap((lane) => lane.providers).filter((provider) => found.includes(provider) && !ready(provider));

// The API keys from the owner's devices offered beside them: only ones this sandbox can reach, and not ones an endpoint
// already held when the view opened. A key added during this visit keeps its row, marked as added, rather than
// vanishing under the press that added it.
export const offeredKeys = (keys: readonly ProviderKey[], addedHere: ReadonlySet<string>): readonly ProviderKey[] =>
    keys.filter((key) => key.applicable && (!key.added || addedHere.has(key.id)));

// The tool a found API key was read from, by its own name: product names, the same in every language.
export const KEY_SOURCE_LABELS = {
    hermes: `Hermes`,
    openclaw: `OpenClaw`,
    opencode: `opencode`,
    gemini: `Gemini CLI`,
    codex: `Codex`,
} as const satisfies Record<ProviderKeySource, string>;
