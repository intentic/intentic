// What the composer's model control says. A chat with nothing that could answer says so, quietly: the line above the
// composer carries the one way on, and the pill must neither be a second door to it nor wear the name of a vendor
// nobody chose. A model somebody did pick is named, with its lock, so a pick from the list visibly takes.
import "@intentic/testing/dom";
import { composerModelName, composerModelReading, stillRunningOn } from "./composerModelLabel";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../../models/providers/providerAccounts";
import { acpProviders, endpointProviders, endpointsLoaded, perProvider, providerModels, trialStatus } from "../../../models/providers/providerCatalog";
import { advertisedLoops } from "../../../models/providers/offeredLoops";
import { turnDefaults } from "../../../models/conversations/run/turnDefaults";

const CHAT = { provider: `claude`, harness: `native`, model: `claude-opus-5`, auto: false } as const;

beforeEach(() => {
    providerAccounts.value = perProvider(() => []);
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    acpProviders.value = [];
    endpointProviders.value = [];
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    providerModels.value = { ...perProvider(() => []), claude: [{ value: `claude-opus-5`, label: `Claude Opus 5` }] };
    turnDefaults.provider.value = undefined;
});

// Before the reads land, an empty account list means "haven't asked". Calling it unconnected for that one frame is
// the flicker itself, so the control keeps naming the model until the picture is in.
it(`keeps naming the model while the connection reads are still out`, () => {
    expect(composerModelReading(CHAT)).toEqual({ label: `Claude Opus 5`, unset: false });
});

it(`says there is no model once the reads confirm nothing here can answer`, () => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;

    expect(composerModelReading(CHAT)).toEqual({ label: `No model`, unset: true });
});

// The reported "nothing changes": a model picked from the list while nothing is connected left the pill on the same
// words. Picked, it is named, locked until its provider is connected, and said so to a screen reader.
it(`names a model somebody picked, locked, until its provider is connected`, () => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    turnDefaults.provider.value = `claude`;

    const reading = composerModelReading(CHAT);
    expect(reading).toEqual({ label: `Claude Opus 5`, unset: true, locked: true });
    expect(composerModelName(reading)).toBe(`Claude Opus 5, not connected`);

    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, label: `ada@acme.dev`, connectedAt: 0 }] };
    expect(composerModelReading(CHAT)).toEqual({ label: `Claude Opus 5`, unset: false });
});

it(`names the model again as soon as an account answers for it`, () => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, label: `ada@acme.dev`, connectedAt: 0 }] };

    expect(composerModelReading(CHAT)).toEqual({ label: `Claude Opus 5`, unset: false });
});

// Auto is a pick, not the absence of one: it outranks the model underneath, and loses to nothing-connected, which is
// the one state where Auto has no ladder to read (and where the list refuses it, ChatModelPicker.vue).
it(`says Auto over a connected provider, and that there is no model over an unconnected one`, () => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, label: `ada@acme.dev`, connectedAt: 0 }] };
    expect(composerModelReading({ ...CHAT, auto: true })).toEqual({ label: `Auto`, unset: false });

    providerAccounts.value = perProvider(() => []);
    expect(composerModelReading({ ...CHAT, auto: true })).toEqual({ label: `No model`, unset: true });
});

// A pick made while a reply runs is for the next message; the reply keeps the model it was sent under.
it(`names the model a running reply keeps when the pick is for the next message`, () => {
    providerModels.value = {
        ...perProvider(() => []),
        claude: [
            { value: `claude-opus-5`, label: `Claude Opus 5` },
            { value: `claude-haiku-4-5`, label: `Claude Haiku 4.5` },
        ],
    };

    expect(stillRunningOn(CHAT, { streaming: true, sentModel: `claude-haiku-4-5` })).toBe(`Claude Haiku 4.5`);
});

it(`says nothing once the reply has ended, or while it runs on the model picked`, () => {
    expect(stillRunningOn(CHAT, { streaming: false, sentModel: `claude-haiku-4-5` })).toBeUndefined();
    expect(stillRunningOn(CHAT, { streaming: true, sentModel: `claude-opus-5` })).toBeUndefined();
    expect(stillRunningOn(CHAT, { streaming: true, sentModel: undefined })).toBeUndefined();
});

// The same model through another loop is another run, so the pill says which; the default loop goes unsaid.
it(`names the loop after the model where it isn't the provider's default`, () => {
    providerModels.value = { ...perProvider(() => []), codex: [{ value: `gpt-5.6`, label: `GPT-5.6` }] };
    const codex = { provider: `codex`, harness: `claude-code`, model: `gpt-5.6`, auto: false } as const;

    expect(composerModelReading(codex)).toEqual({ label: `GPT-5.6 · Claude Code`, unset: false });
    expect(composerModelReading({ ...codex, harness: `native` })).toEqual({ label: `GPT-5.6`, unset: false });
    // Claude's own loop IS Claude Code: naming it would be naming the default.
    expect(composerModelReading({ ...CHAT, harness: `claude-code` })).toEqual({ label: `Claude Opus 5`, unset: false });
});

it(`says nothing of a loop the daemon no longer offers the provider on, which runs as the default`, () => {
    providerModels.value = { ...perProvider(() => []), codex: [{ value: `gpt-5.6`, label: `GPT-5.6` }] };
    advertisedLoops.value = { codex: [`codex`] };

    expect(composerModelReading({ provider: `codex`, harness: `claude-code`, model: `gpt-5.6`, auto: false }).label).toBe(`GPT-5.6`);
    advertisedLoops.value = undefined;
});
