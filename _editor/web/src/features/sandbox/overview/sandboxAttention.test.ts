// @vitest-environment jsdom
// What the sandbox tells its owner it needs. One regression: a reader holding a usable free trial was told the agent
// could not run a turn, which sent them off to connect an account they did not need — the same beat access.ts already
// names for the chat's own gate, on a list that never consulted the endpoint half at all.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../chat/accounts/providerAccounts";
import { acpProviders, endpointProviders, endpointsLoaded, trialStatus } from "../../chat/accounts/providerCatalog";

// The four seams this list reads besides the accounts: each is a live query elsewhere, and none of them decides
// whether a turn can run, which is the only question these tests ask.
vi.mock(`../../capabilities/connect/useSecrets`, () => ({ useMissingSecretCount: () => ({ missingRequiredCount: { value: 0 } }) }));
vi.mock(`../devices/useDevices`, () => ({ useSyncHealth: () => ({ stoppedOn: { value: [] }, contendedPorts: { value: [] } }) }));
vi.mock(`../environment/useEnvironment`, () => ({ useEnvironment: () => ({ pending: { value: undefined }, proposal: { value: undefined } }) }));
vi.mock(`./useSandboxVersion`, () => ({ useSandboxVersion: () => ({ updateAvailable: { value: false }, updateStaged: { value: undefined } }) }));

const TRIAL_ENDPOINT = { id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` } as const;

// A sandbox that has finished reading both halves and holds no credential of any kind: the state a new workspace
// opens in, and the only one where the warning is the truth.
beforeEach(() => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    acpProviders.value = [];
    endpointProviders.value = [];
});

afterEach(() => {
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    acpProviders.value = [];
    endpointProviders.value = [];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
});

// `needs`, not `notes`: this is the half that claims something is owed, and the half the mobile menu heads with.
const messages = async (): Promise<string[]> => {
    const { useSandboxAttention } = await import(`./sandboxAttention`);
    return useSandboxAttention().needs.value.map((item) => item.message);
};

const NO_ACCOUNT = `No AI account connected, the agent can't run a turn`;

it(`says an empty sandbox cannot run a turn`, async () => {
    expect(await messages()).toContain(NO_ACCOUNT);
});

// The trial is an endpoint with an allowance, not an account, so the account half alone cannot see it. This is the
// sentence the reader in the recorded session acted on for the whole session while the trial sat ready with ten left.
it(`stays quiet while the free trial still has turns left in it`, async () => {
    endpointProviders.value = [TRIAL_ENDPOINT];
    trialStatus.value = { available: true, allowance: 12, used: 2, remaining: 10, health: `healthy` };
    expect(await messages()).not.toContain(NO_ACCOUNT);
});

// Spent is not connected: the allowance is the credential here, so the warning has to come back when it runs out.
it(`says so again once the trial's allowance is spent`, async () => {
    endpointProviders.value = [TRIAL_ENDPOINT];
    trialStatus.value = { available: true, allowance: 12, used: 12, remaining: 0, health: `healthy` };
    expect(await messages()).toContain(NO_ACCOUNT);
});

// Claiming "no account" before the endpoint read lands is the same false wall, one beat earlier.
it(`withholds the claim until both halves of the read have landed`, async () => {
    endpointsLoaded.value = false;
    expect(await messages()).not.toContain(NO_ACCOUNT);
});

it(`stays quiet for a stored provider account`, async () => {
    providerAccounts.value = {
        ...providerAccounts.value,
        claude: [{ id: `acc1`, label: `Claude Max`, connectedAt: Date.now() }],
    };
    const shown = await messages();
    providerAccounts.value = { ...providerAccounts.value, claude: [] };
    expect(shown).not.toContain(NO_ACCOUNT);
});

it(`stays quiet for a translator subscription`, async () => {
    translatorAccounts.value = { ...translatorAccounts.value, gemini: [{ name: `g`, label: `Google` }] };
    const shown = await messages();
    translatorAccounts.value = { ...translatorAccounts.value, gemini: [] };
    expect(shown).not.toContain(NO_ACCOUNT);
});
