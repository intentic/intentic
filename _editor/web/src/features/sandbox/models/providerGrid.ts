import {
    type AgentProvider,
    isEndpointProvider,
    isFreeProvider,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type ProviderKey,
    type ProviderKeySource,
} from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import type { ModelSourceStanding } from "./modelSources";

// SANDBOX ▸ MODELS IS A GRID: one tile per way this sandbox can run a model, each pressed open onto one panel that holds
// everything about it (its accounts, the one button that adds one, the sign-in while it runs). Pure: the view reads the
// stores and hands facts in, so the order, the words on a tile and which tile opens on arrival are testable without a
// sandbox.
//
// It replaced a list of what was connected stacked over three "ways in" lanes, which offered two doors to the same act
// (a connected provider's "Add another account", and its tile again in a lane below) and led with the free sign-in as
// if it were the recommended one. Here every provider is a peer, and free is a label, not a position.

/** The tile for models this sandbox runs itself, beside the providers' own. */
export const LOCAL_TILE = `local`;
export type TileKey = NativeProvider | typeof LOCAL_TILE;

/**
 * The grid, in the spec table's order (the product's own order of providers) and this machine last. Fixed: connecting
 * one never moves a tile, so a reader who learnt where Claude is finds it there next time.
 */
export const MODEL_TILES: readonly TileKey[] = [...NATIVE_PROVIDERS, LOCAL_TILE];

export const isProviderTile = (key: string): key is NativeProvider => NATIVE_PROVIDERS.some((provider) => provider === key);

/** Which tile a provider lives under: its own, or Local models for a model this sandbox serves or is pointed at. */
export const tileOf = (provider: AgentProvider): TileKey | undefined =>
    isProviderTile(provider) ? provider : isEndpointProvider(provider) ? LOCAL_TILE : undefined;

/** Free to connect: a free sign-in, or the machine the reader already owns. A label on the tile, never its position. */
export const isFreeTile = (key: TileKey): boolean => key === LOCAL_TILE || isFreeProvider(key);

export interface TileFacts {
    // Accounts held (a provider), or models served and servers pointed at (Local models).
    readonly count: number;
    // The worst any of them is in (modelSources.ts), when there is any.
    readonly standing: ModelSourceStanding | undefined;
    // Its sign-in is the one in flight, or the one that just ended without connecting anything.
    readonly signingIn: boolean;
    readonly failed: boolean;
    // The desktop app found it signed in on this computer (lib/foundOnComputer.ts).
    readonly found: boolean;
}

export type TileTone = `muted` | `live` | `warning` | `danger`;

/**
 * The one line under a tile's name: what is happening with it, else that this computer already has it. How many it holds
 * is the tile's top-right corner (tileCount), not this line. Not the price: "Free" is the tile's own corner label
 * (isFreeTile), so it stays said once the tile holds accounts.
 */
export const tileLine = (_key: TileKey, facts: TileFacts): { readonly text: string; readonly tone: TileTone } | undefined => {
    if (facts.signingIn) {
        return { text: t(`connect.providerTile.signingIn`), tone: `live` };
    }
    if (facts.failed) {
        return { text: t(`connect.providerGrid.didntConnect`), tone: `danger` };
    }
    return facts.found && facts.count === 0 ? { text: t(`connect.providerGrid.onThisComputer`), tone: `live` } : undefined;
};

/** How many accounts or models the tile holds, when there is any; drawn as a number only, in the tile's top-right corner. */
export const tileCount = (facts: TileFacts): number | undefined => (facts.count > 0 ? facts.count : undefined);

/**
 * The tile open on arrival, when one is worth opening: the provider a link named, the sign-in in flight or the one that
 * just failed (it is the reader's turn), else whatever needs a person. Nothing else: an open panel the reader did not ask
 * for is a pitch, and the grid alone already says what is here.
 */
export const arrivalTile = (facts: {
    readonly asked?: AgentProvider;
    readonly live?: AgentProvider;
    readonly failed?: AgentProvider;
    readonly needing?: AgentProvider;
}): TileKey | undefined =>
    [facts.asked, facts.live, facts.failed, facts.needing]
        .map((provider) => (provider === undefined ? undefined : tileOf(provider)))
        .find((key) => key !== undefined);

/**
 * What a link naming a provider (`?provider=`: the chat's Try again, a picker row, a job whose model is missing) does:
 * opens its tile, and starts its sign-in only while nothing of it is connected. One already connected, an account needing
 * a reconnect included, waits for the reader's press: a sign-in the page started by itself over a provider that is
 * already connected read as the page contradicting itself. Undefined for a provider no tile holds.
 */
export const linkArrival = (
    provider: AgentProvider,
    ready: (provider: AgentProvider) => boolean,
): { readonly tile: TileKey; readonly signIn: boolean } | undefined => {
    const tile = tileOf(provider);
    return tile === undefined ? undefined : { tile, signIn: tile !== LOCAL_TILE && !ready(provider) };
};

// The banner once a sign-in lands: what was connected, and to which sandbox. What a reader connects lives in that one
// sandbox, not on the account: a new user connected ChatGPT in a second sandbox, removed it, and lost the connection.
export const landedLine = (label: string, sandboxName: string | undefined): string =>
    sandboxName === undefined || sandboxName === ``
        ? t(`connect.connect.landed`)
        : t(`connect.connect.landedIn`, { provider: label, sandbox: sandboxName });

/**
 * "Found on this computer": the providers the desktop app found signed in here (`?found=`) that this sandbox does not
 * hold yet, in grid order. One that becomes ready leaves the list.
 */
export const foundSignIns = (found: readonly AgentProvider[], ready: (provider: AgentProvider) => boolean): readonly NativeProvider[] =>
    NATIVE_PROVIDERS.filter((provider) => found.includes(provider) && !ready(provider));

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
