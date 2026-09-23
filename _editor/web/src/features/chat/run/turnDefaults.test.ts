// What a new conversation is born pointing at. The reported bug: on a sandbox with nothing connected but the free
// trial, pressing "New agent" opened a chat on Claude — unrunnable, so the composer was replaced by a "connect a
// model" wall — and only a later unrelated read moved it onto the trial. Two rules for one question: the seed here
// stopped at the native list, while the watcher that repoints an open chat (useChat-accounts.ts) included the trial.
import "@intentic/testing/dom";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { receivePreferenceChange } from "@intentic/ui/preference";
import { rememberedProviderFor, turnDefaults } from "./turnDefaults";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../accounts/providerAccounts";
import { acpProviders, endpointProviders, endpointsLoaded, perProvider, trialStatus } from "../accounts/providerCatalog";

const trialServed = (): void => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
};

const read = (): void => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
};

beforeEach(() => {
    localStorage.clear();
    turnDefaults.provider.value = undefined;
    providerAccounts.value = perProvider(() => []);
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    acpProviders.value = [];
    endpointProviders.value = [];
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
});

it(`opens a chat on the trial when that is all this sandbox can run`, () => {
    trialServed();
    read();

    expect(rememberedProviderFor()).toBe(TRIAL_PROVIDER);
});

it(`keeps a stored pick that can still run, and steps over one that cannot`, () => {
    turnDefaults.provider.value = `codex`;
    trialServed();
    read();
    expect(rememberedProviderFor()).toBe(TRIAL_PROVIDER);

    translatorAccounts.value = { ...translatorAccounts.value, codex: [{ name: `chatgpt`, label: `ChatGPT Pro` }] };
    expect(rememberedProviderFor()).toBe(`codex`);
});

// An empty account list before the reads land means "haven't asked", not "nothing connected"; resolving against it
// would move every chat off its owner's pick for the first second of every session.
it(`lets a stored pick ride untouched until the connection reads have landed`, () => {
    turnDefaults.provider.value = `codex`;

    expect(rememberedProviderFor()).toBe(`codex`);
});

// The second half of the same bug: `endpoint/…` is a legal stored pick, and reading it back as Claude meant choosing
// the free trial did not survive a reload. `receivePreferenceChange` runs the preference's own `read` on a raw
// string, which is exactly what a reload does with what is in storage.
it(`restores an endpoint pick from storage, and forgets an ACP agent this sandbox may no longer have`, () => {
    turnDefaults.provider.value = TRIAL_PROVIDER;
    expect(localStorage.getItem(`ui-chat-provider`)).toBe(TRIAL_PROVIDER);

    receivePreferenceChange({ key: `ui-chat-provider`, raw: TRIAL_PROVIDER });
    expect(turnDefaults.provider.value).toBe(TRIAL_PROVIDER);

    receivePreferenceChange({ key: `ui-chat-provider`, raw: `acp/some-agent` });
    expect(turnDefaults.provider.value).toBeUndefined();
});

// With nothing chosen and nothing runnable the chat still needs somewhere to point — but nothing may SAY it, which
// is why the pick itself stays undefined for the surfaces that name a provider to read.
it(`points an unchosen chat at a floor without recording a choice`, () => {
    read();

    expect(rememberedProviderFor()).toBe(`claude`);
    expect(turnDefaults.provider.value).toBeUndefined();
});
