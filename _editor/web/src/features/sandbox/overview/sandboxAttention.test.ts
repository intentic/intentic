// What the sandbox tells its owner it needs. One regression: a reader holding a usable free trial was told the agent
// could not run a turn, which sent them off to connect an account they did not need — the same beat access.ts already
// names for the chat's own gate, on a list that never consulted the endpoint half at all.
import "@intentic/testing/dom";
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../../chat/accounts/providerAccounts";
import { acpProviders, endpointProviders, endpointsLoaded, trialStatus } from "../../chat/accounts/providerCatalog";
import { PUBLISH_ANCHOR } from "../access/publishAnchor";
import { effectScope } from "vue";
import { UPDATE_ACTION_ANCHOR } from "./version/updateAnchor";

// The four seams this list reads besides the accounts: each is a live query elsewhere, and none of them decides
// whether a turn can run, which is the only question these tests ask.
jest.mock(`../../capabilities/connect/secrets/useSecrets`, () => ({ useMissingSecretCount: () => ({ missingRequiredCount: { value: 0 } }) }));
jest.mock(`../devices/useDevices`, () => ({ useSyncHealth: () => ({ stoppedOn: { value: [] }, heldPorts: { value: [] } }) }));
// An approved recipe not yet built, only where a test says so; and the hosted build of it, none unless a test starts one.
const pending: { value: { hash: string; content: string } | undefined } = { value: undefined };
jest.mock(`../environment/useEnvironment`, () => ({ useEnvironment: () => ({ pending, proposal: { value: undefined } }) }));
const hostedBuild: { value: { state: `building`; hash: string; startedAt: string } | undefined } = { value: undefined };
jest.mock(`../secrets/useHostedBuild`, () => ({ useHostedBuild: () => ({ build: hostedBuild, applied: { value: undefined } }) }));
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active: { value: { id: `sb1`, hosted: { region: `iad`, warm: true } } }, reachable: { value: true } }),
}));
// No update unless a test offers one.
const update = { available: false, staged: false };
// Work held here alone, with no repository to push it to, only where a test says so.
const unbacked = { value: false };
jest.mock(`./backup/useUnbackedWork`, () => ({ useUnbackedWork: () => ({ unbacked }) }));
jest.mock(`./version/useSandboxVersion`, () => ({
    useSandboxVersion: () => ({ updateAvailable: { value: update.available }, updateStaged: { value: update.staged } }),
}));

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
    pending.value = undefined;
    hostedBuild.value = undefined;
    unbacked.value = false;
    update.available = false;
    update.staged = false;
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    acpProviders.value = [];
    endpointProviders.value = [];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
});

// The list as a surface holds it: inside a scope, as a component's setup is, which its clock is disposed with.
const attention = async () => {
    const { useSandboxAttention } = await import(`./sandboxAttention`);
    return effectScope().run(() => useSandboxAttention())!;
};

// `needs`, not `notes`: this is the half that claims something is owed, and the half the mobile menu heads with.
const messages = async (): Promise<string[]> => (await attention()).needs.value.map((item) => item.message);

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

// The switcher's update row clicked five times while already on /sandbox, going nowhere: both update notes point at
// the update card's own button, which the switcher scrolls to and focuses once the page is there.
it(`points both update notes at the update's own button rather than at the page`, async () => {
    update.available = true;
    expect((await attention()).notes.value.map((item) => item.to)).toEqual([`/sandbox#${UPDATE_ACTION_ANCHOR}`]);
    update.staged = true;
    expect((await attention()).notes.value.map((item) => [item.to, item.badges])).toEqual([[`/sandbox#sandbox-update-action`, true]]);
});

// "No repository to push this work to" landed on Environment with nothing saying where the fix was, and its reader
// clicked it twice: it points at the Publish row, which says what it needs and links to connecting it.
it(`points the missing repository at the Publish row, not at the page`, async () => {
    unbacked.value = true;
    expect((await attention()).needs.value.find((item) => item.message === `No repository to push this work to`)?.to).toBe(
        `/sandbox/environment#${PUBLISH_ANCHOR}`,
    );
});

// "Rebuild needed" for an hour, its reader clicking the Environment card's tabs and refresh without finding the rebuild:
// the row points at the rebuild step itself, and carries the press a surface may offer beside it.
it(`points the rebuild at the card's rebuild step, with the press beside it`, async () => {
    pending.value = { hash: `h1`, content: `RUN true` };
    const row = (await attention()).needs.value.find((item) => item.message === `Rebuild needed to finish setting up your new capabilities`);
    expect([row?.to, row?.action]).toEqual([`/sandbox/environment#sandbox-rebuild`, `rebuild`]);
});

// A build the platform is running is nothing owed: the row stops asking for one and says it is under way.
it(`says the environment is building instead of asking for a rebuild while one runs`, async () => {
    pending.value = { hash: `h1`, content: `RUN true` };
    hostedBuild.value = { state: `building`, hash: `h1`, startedAt: new Date().toISOString() };
    const list = await attention();
    expect(list.needs.value.map((item) => item.message)).not.toContain(`Rebuild needed to finish setting up your new capabilities`);
    expect(list.notes.value.map((item) => [item.message, item.to])).toEqual([
        [`Your sandbox's new environment is building`, `/sandbox/environment#sandbox-rebuild`],
    ]);
});
