// @vitest-environment jsdom
// What the composer's model control says. A chat with nothing that could answer must not wear a model's name: the
// line above the composer says nothing is connected, and a pill reading "Claude Opus 5" beside it contradicts it and
// hides the one thing the control is there for.
import { beforeEach, expect, it } from "vitest";
import { composerModelReading } from "./composerModelLabel";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../accounts/providerAccounts";
import { acpProviders, endpointProviders, endpointsLoaded, perProvider, providerModels, trialStatus } from "../accounts/providerCatalog";

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
});

// Before the reads land, an empty account list means "haven't asked". Calling it unconnected for that one frame is
// the flicker itself, so the control keeps naming the model until the picture is in.
it(`keeps naming the model while the connection reads are still out`, () => {
    expect(composerModelReading(CHAT)).toEqual({ label: `Claude Opus 5`, unset: false });
});

it(`becomes the press once the reads confirm nothing here can answer`, () => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;

    expect(composerModelReading(CHAT)).toEqual({ label: `Choose a model`, unset: true });
});

it(`names the model again as soon as an account answers for it`, () => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, label: `ada@acme.dev`, connectedAt: 0 }] };

    expect(composerModelReading(CHAT)).toEqual({ label: `Claude Opus 5`, unset: false });
});

// Auto is a pick, not the absence of one: it outranks the model underneath, and loses to nothing-connected, which is
// the one state where Auto has no ladder to read.
it(`says Auto over a connected provider, and the press over an unconnected one`, () => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, label: `ada@acme.dev`, connectedAt: 0 }] };
    expect(composerModelReading({ ...CHAT, auto: true })).toEqual({ label: `Auto`, unset: false });

    providerAccounts.value = perProvider(() => []);
    expect(composerModelReading({ ...CHAT, auto: true })).toEqual({ label: `Choose a model`, unset: true });
});
