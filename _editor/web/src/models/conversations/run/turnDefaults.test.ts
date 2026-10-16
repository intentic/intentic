// What a new conversation is born pointing at. The reported bug: on a sandbox with nothing connected but the free
// trial, pressing "New agent" opened a chat on Claude — unrunnable, so the composer was replaced by a "connect a
// model" wall — and only a later unrelated read moved it onto the trial. Two rules for one question: the seed here
// stopped at the native list, while the watcher that repoints an open chat (useChat-accounts.ts) included the trial.
import "@intentic/testing/dom";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract/models/agent-catalog";
import { receivePreferenceChange } from "@intentic/ui/preference";
import { rememberedHarnessFor, rememberedModelFor, rememberedProviderFor, rememberHarness, turnDefaults } from "./turnDefaults";
import { advertisedLoops } from "../../providers/offeredLoops";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../providers/providerAccounts";
import {
    acpProviders,
    endpointProviders,
    endpointsLoaded,
    perProvider,
    providerModels,
    providerModelsState,
    trialStatus,
} from "../../providers/providerCatalog";

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

// A loop is remembered per provider, and read back only while this sandbox's daemon still offers it.
it(`reopens a provider on its remembered loop, and on its default once that loop is no longer offered`, () => {
    rememberHarness(`codex`, `claude-code`);
    expect(rememberedHarnessFor(`codex`)).toBe(`claude-code`);
    // Grok's pick is its own.
    expect(rememberedHarnessFor(`grok`)).toBe(`native`);

    advertisedLoops.value = { codex: [`codex`] };
    try {
        expect(rememberedHarnessFor(`codex`)).toBe(`native`);
    } finally {
        advertisedLoops.value = undefined;
    }
});

// The reported bug: after a self-heal wiped storage, the model map read back the seed floor's head (claude-opus-5), and
// every new chat for a day and a half opened on it while Opus 5.5 was in the list. A stray click on an older row did
// the same. What a new chat remembers is the family, at its newest version; the older pick stays with its own chat.
describe(`the model a new chat opens on`, () => {
    const claudeCatalog = (ids: readonly string[]): void => {
        providerModels.value = { ...providerModels.value, claude: ids.map((id) => ({ label: id, value: id })) };
        providerModelsState.value = { ...providerModelsState.value, claude: `loaded` };
    };
    afterEach(() => {
        providerModels.value = perProvider(() => []);
        providerModelsState.value = perProvider(() => `idle`);
        turnDefaults.models.value = perProvider(() => ``);
    });

    it(`is the newest version of the family last chosen, not the older version itself`, () => {
        claudeCatalog([`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`]);
        turnDefaults.models.value = { ...turnDefaults.models.value, claude: `claude-opus-5` };
        expect(rememberedModelFor(`claude`)).toBe(`claude-opus-5-5`);
        // The pick itself is left as it was: resolved at read, never rewritten.
        expect(turnDefaults.models.value[`claude`]).toBe(`claude-opus-5`);
    });

    it(`keeps a pick that is its family's newest, and another family's pick within its own family`, () => {
        claudeCatalog([`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5`]);
        turnDefaults.models.value = { ...turnDefaults.models.value, claude: `claude-opus-5-5` };
        expect(rememberedModelFor(`claude`)).toBe(`claude-opus-5-5`);
        turnDefaults.models.value = { ...turnDefaults.models.value, claude: `claude-sonnet-5` };
        expect(rememberedModelFor(`claude`)).toBe(`claude-sonnet-5-5`);
    });

    it(`never upgrades onto a row a chat cannot run`, () => {
        providerModels.value = {
            ...providerModels.value,
            claude: [
                { label: `Claude Opus 5.5`, value: `claude-opus-5-5`, helperOnly: `instant-tier` },
                { label: `Claude Opus 5`, value: `claude-opus-5` },
            ],
        };
        providerModelsState.value = { ...providerModelsState.value, claude: `loaded` };
        turnDefaults.models.value = { ...turnDefaults.models.value, claude: `claude-opus-5` };
        expect(rememberedModelFor(`claude`)).toBe(`claude-opus-5`);
    });

    it(`rides the stored pick untouched until the catalog has answered`, () => {
        turnDefaults.models.value = { ...turnDefaults.models.value, claude: `claude-opus-5` };
        expect(rememberedModelFor(`claude`)).toBe(`claude-opus-5`);
    });
});
