import { FREE_PROVIDERS, NATIVE_PROVIDERS, type ProviderKey } from "@intentic/sandbox-contract";
import {
    arrivalTile,
    foundSignIns,
    isFreeTile,
    landedLine,
    linkArrival,
    LOCAL_TILE,
    MODEL_TILES,
    offeredKeys,
    type TileFacts,
    tileLine,
    tileOf,
} from "./providerGrid";

/* Sandbox ▸ Models' grid: every way in as a peer, opened onto one panel each. */

const only =
    (...connected: string[]) =>
    (provider: string) =>
        connected.includes(provider);

test("every provider has a tile, in the spec table's order, with this machine last; free is a label, not a place", () => {
    expect(MODEL_TILES).toEqual([...NATIVE_PROVIDERS, LOCAL_TILE]);
    // Free is said on the tile: the spec table's free providers and the machine the reader owns, nothing else.
    expect(MODEL_TILES.filter(isFreeTile)).toEqual([...FREE_PROVIDERS, LOCAL_TILE]);
    // A model this sandbox serves or is pointed at lives under Local models; a provider under its own tile.
    expect(tileOf(`claude`)).toBe(`claude`);
    expect(tileOf(`endpoint/qwen`)).toBe(LOCAL_TILE);
    expect(tileOf(`no-such-provider`)).toBeUndefined();
});

const facts = (overrides: Partial<TileFacts> = {}): TileFacts => ({
    count: 0,
    standing: undefined,
    signingIn: false,
    failed: false,
    found: false,
    ...overrides,
});

test("a tile's one line says what is happening, else what it holds, else that this computer has it", () => {
    // Nothing to say is nothing said; the price is the tile's corner label, not this line.
    expect(tileLine(`claude`, facts())).toBeUndefined();
    expect(tileLine(`gemini`, facts())).toBeUndefined();
    expect(tileLine(`claude`, facts({ found: true }))).toEqual({ text: `On this computer`, tone: `live` });
    expect(tileLine(`gemini`, facts({ count: 31, standing: `waiting` }))).toEqual({ text: `31 accounts`, tone: `muted` });
    expect(tileLine(`claude`, facts({ count: 1, standing: `attention` }))).toEqual({ text: `1 account`, tone: `warning` });
    expect(tileLine(LOCAL_TILE, facts({ count: 2, standing: `ready` }))).toEqual({ text: `2 models`, tone: `muted` });
    // What is happening outranks everything.
    expect(tileLine(`claude`, facts({ count: 3, signingIn: true }))).toEqual({ text: `Signing in…`, tone: `live` });
    expect(tileLine(`claude`, facts({ count: 3, failed: true }))).toEqual({ text: `Didn't connect`, tone: `danger` });
});

// The chat's "Finish sign-in" landed on a page with nothing open, and the sign-in it pointed at was nowhere in sight.
test("on arrival the tile whose turn it is opens, and nothing opens for its own sake", () => {
    expect(arrivalTile({})).toBeUndefined();
    expect(arrivalTile({ needing: `codex` })).toBe(`codex`);
    expect(arrivalTile({ failed: `kimi`, needing: `codex` })).toBe(`kimi`);
    expect(arrivalTile({ live: `cursor`, failed: `kimi`, needing: `codex` })).toBe(`cursor`);
    expect(arrivalTile({ asked: `claude`, live: `cursor` })).toBe(`claude`);
    expect(arrivalTile({ asked: `endpoint/qwen` })).toBe(LOCAL_TILE);
});

// The chat's Reconnect lands here for a provider that is connected, one account of it needing a new sign-in: the page
// said "Connected" and "Connecting Claude… paste the code" at once, having started a sign-in nobody pressed.
test("a link naming a connected provider opens its tile and leaves the sign-in to the reader's press", () => {
    expect(linkArrival(`claude`, only(`claude`))).toEqual({ tile: `claude`, signIn: false });
    // Nothing of it connected: the link is the request, and asking for the press as well would be asking twice.
    expect(linkArrival(`claude`, only())).toEqual({ tile: `claude`, signIn: true });
    expect(linkArrival(`endpoint/qwen`, only())).toEqual({ tile: LOCAL_TILE, signIn: false });
    expect(linkArrival(`no-such-provider`, only())).toBeUndefined();
});

// What a reader connects lives in one sandbox, so the banner names it: one connected ChatGPT in a second sandbox,
// removed that sandbox, and lost the connection without having been told where it went.
test("the landed banner names the sandbox the account was connected to", () => {
    expect(landedLine(`ChatGPT`, `workspace-2`)).toBe(`ChatGPT connected to "workspace-2". Chats in this sandbox can use it now.`);
    // No sandbox name to give (none bound yet): the plain line rather than an empty pair of quotes.
    expect(landedLine(`ChatGPT`, undefined)).toBe(`Connected. This workspace can run turns now.`);
});

// The desktop app's `?found=`: the AI tools already signed in on this computer, offered above the grid.
test("what this computer is signed in to is offered in grid order, minus what this sandbox already holds", () => {
    expect(foundSignIns([`gemini`, `codex`, `claude`], only())).toEqual([`claude`, `codex`, `gemini`]);
    // One connected here is nothing left to do, and leaves the list.
    expect(foundSignIns([`codex`, `claude`], only(`claude`))).toEqual([`codex`]);
    expect(foundSignIns([`codex`], only(`codex`))).toEqual([]);
    expect(foundSignIns([], only())).toEqual([]);
});

const key = (id: string, overrides: Partial<Pick<ProviderKey, `added` | `applicable` | `provider`>> = {}): ProviderKey => ({
    id,
    provider: `openrouter`,
    label: `OpenRouter`,
    source: `hermes`,
    host: `laptop`,
    hint: `abcd`,
    applicable: true,
    added: false,
    ...overrides,
});

test("a device's key is offered when this sandbox can reach its provider and has not added it", () => {
    const keys = [key(`a`), key(`b`, { added: true }), key(`c`, { applicable: false, provider: `some-gateway` }), key(`d`, { added: true })];
    expect(offeredKeys(keys, new Set()).map((entry) => entry.id)).toEqual([`a`]);
    // Added during this visit: the row stays, marked, rather than vanishing under the press.
    expect(offeredKeys(keys, new Set([`d`])).map((entry) => entry.id)).toEqual([`a`, `d`]);
});
