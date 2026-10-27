// Pins the editor's reading of a person's AI accounts (Access ▸ People) against the daemon's own rule
// (agent/run/decide/account-reach.ts): which providers are not theirs to run at all, that such a provider never reads as
// one to connect, and that a model is spent when THEIR accounts are, whatever room another account has.
import { computed, ref } from "vue";
import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";

const keys = ref<readonly string[] | undefined>(undefined);
const realMembers = { ...(await import("../../client/sandbox/useMembers")) };
jest.mock("../../client/sandbox/useMembers", () => ({ ...realMembers, selfAiAccounts: () => computed(() => keys.value) }));

const { mayRunOn, providerWithheld, spentModels } = await import("./aiReach");
const { accessBadge, anyProviderReady, firstReadyProvider, nothingShared, providerReady, providerReadyOn, providerRunnable, withheldBadge } = await import("./access");
const { accountsLoaded, providerAccounts, translatorAccounts, usageByAccount } = await import("./providerAccounts");
const { acpProviders, endpointProviders, endpointsLoaded, perProvider, trialStatus } = await import("./providerCatalog");

const LOCAL = `endpoint/ollama`;
const REMOTE = `endpoint/openrouter`;
const NOW = Date.UTC(2026, 9, 27, 12);

// One reading of a Claude plan: its week at `used` percent, resetting in a day.
const week = (used: number): AccountUsage => ({
    measuredAt: NOW - 60_000,
    windows: [{ kind: `seven_day`, utilization: used, resetsAt: Math.round(NOW / 1000) + 24 * 3600, gates: `all` }],
});

beforeEach(() => {
    keys.value = undefined;
    providerAccounts.value = {
        ...perProvider(() => []),
        claude: [
            { id: `max`, label: `Claude Max`, connectedAt: 0, usage: week(20) },
            { id: `pro`, label: `Claude Pro`, connectedAt: 0, usage: week(100) },
        ],
    };
    translatorAccounts.value = { codex: [{ name: `chatgpt-ada`, label: `ada@acme.dev` }], grok: [], kimi: [], gemini: [] };
    usageByAccount.value = {};
    acpProviders.value = [];
    endpointProviders.value = [
        { id: LOCAL, label: `ollama`, kind: `localmodel` },
        { id: REMOTE, label: `openrouter`, kind: `endpoint` },
    ];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
});

it(`withholds nothing from a person nobody limited, nor before their access read lands`, () => {
    expect([`claude`, `codex`, `gemini`, LOCAL, REMOTE].some(providerWithheld)).toBe(false);
    expect(mayRunOn(`claude`, `pro`)).toBe(true);
});

it(`withholds a connected provider none of whose accounts is on the person's list`, () => {
    keys.value = [`codex:chatgpt-ada`];

    expect(providerWithheld(`claude`)).toBe(true);
    expect(providerWithheld(`codex`)).toBe(false);
    // Connected, so the connection's own answer stands; runnable is what the person can send on.
    expect(providerReady(`claude`)).toBe(true);
    expect(providerRunnable(`claude`)).toBe(false);
    expect(providerReadyOn(`claude`, `native`)).toBe(false);
    // Not a price to pay: connecting would not make it theirs.
    expect(accessBadge(`claude`)).toBeUndefined();
    expect(withheldBadge(`claude`)).toBe(`Not shared with you`);
    // A provider nothing is connected for and no key names is not theirs either, so it is never offered as Connect.
    expect(providerWithheld(`grok`)).toBe(true);
    expect(accessBadge(`grok`)).toBeUndefined();
});

it(`hands over a whole provider by its own key, and holds an accountless one to that key alone`, () => {
    keys.value = [`gemini`, `claude:pro`];

    expect(providerWithheld(`gemini`)).toBe(false);
    expect(providerWithheld(`claude`)).toBe(false);
    expect(mayRunOn(`claude`, `pro`)).toBe(true);
    expect(mayRunOn(`claude`, `max`)).toBe(false);
    // An API-key endpoint holds no accounts: only its own key lets a turn run on it.
    expect(providerWithheld(REMOTE)).toBe(true);
    keys.value = [REMOTE];
    expect(providerWithheld(REMOTE)).toBe(false);
});

it(`never holds back a local model, which spends nobody's allowance`, () => {
    keys.value = [];

    expect(providerWithheld(LOCAL)).toBe(false);
});

it(`trusts a key naming an account this window cannot list, since the daemon may hold it`, () => {
    // A reader who may not list accounts sees none: the provider stands on the daemon's word that it is connected.
    providerAccounts.value = perProvider(() => []);
    keys.value = [`claude:pro`];

    expect(providerWithheld(`claude`)).toBe(false);
    expect(providerWithheld(`kimi`)).toBe(true);
});

it(`seats a new chat on a provider the person may run, and says when none of what is connected is theirs`, () => {
    keys.value = [`codex:chatgpt-ada`];
    expect(firstReadyProvider()).toBe(`codex`);
    expect(nothingShared()).toBe(false);

    keys.value = [`kimi:nobody`];
    expect(anyProviderReady()).toBe(true);
    // The local model still runs for them: something is theirs.
    expect(nothingShared()).toBe(false);
    endpointProviders.value = [{ id: REMOTE, label: `openrouter`, kind: `endpoint` }];
    expect(anyProviderReady()).toBe(false);
    expect(nothingShared()).toBe(true);
});

it(`judges a model spent by the person's own accounts, not by room on one they may not spend`, () => {
    const rows = [{ key: `claude:claude-opus-5`, provider: `claude`, value: `claude-opus-5`, label: `Claude Opus 5` }];
    expect(spentModels(rows, NOW).has(`claude:claude-opus-5`)).toBe(false);

    // Held to the Pro account, whose week is spent: Max's room is not theirs.
    keys.value = [`claude:pro`];
    expect(spentModels(rows, NOW).get(`claude:claude-opus-5`)?.kind).toBe(`spent`);
});
