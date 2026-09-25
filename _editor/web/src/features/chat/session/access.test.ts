// Pins that access.ts treats an endpoint as ready by existing, the trial's readiness as a spendable measurement,
// and accessKnown as gating both reads landing before either is trusted.
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { accessKnown, firstReadyProvider, providerReady, providerReadyOn, trialExhausted, trialPhase } from "./access";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../accounts/providerAccounts";
import { acpProviders, endpointProviders, endpointsLoaded, perProvider, trialStatus } from "../accounts/providerCatalog";

const OLLAMA = `endpoint/ollama`;

// Nothing connected, no capabilities, no trial: every test states the part of the picture it's about.
beforeEach(() => {
    providerAccounts.value = perProvider(() => []);
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    acpProviders.value = [];
    endpointProviders.value = [];
    accountsLoaded.value = false;
    endpointsLoaded.value = false;
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
});

it(`counts a configured endpoint as ready: it carries its own credential`, () => {
    expect(providerReady(OLLAMA)).toBe(false);

    endpointProviders.value = [{ id: OLLAMA, label: `ollama`, kind: `endpoint` }];

    expect(providerReady(OLLAMA)).toBe(true);
    expect(providerReadyOn(OLLAMA, `claude-code`)).toBe(true);
    expect(providerReadyOn(OLLAMA, `native`)).toBe(true);
});

it(`serves the trial while there is allowance left, and stops when there is none`, () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];

    // Discovered but not yet confirmed: unknown is treated as absent everywhere the trial is read.
    expect(providerReady(TRIAL_PROVIDER)).toBe(false);

    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    expect(providerReady(TRIAL_PROVIDER)).toBe(true);
    expect(providerReadyOn(TRIAL_PROVIDER, `claude-code`)).toBe(true);

    trialStatus.value = { available: true, allowance: 12, used: 12, remaining: 0, health: `healthy` };
    expect(providerReady(TRIAL_PROVIDER)).toBe(false);
});

it(`does not invent a trial the daemon never provisioned`, () => {
    // Allowance without the endpoint existing: the capability read hasn't landed yet.
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };

    expect(providerReady(TRIAL_PROVIDER)).toBe(false);
});

// Two independent reads: accounts return in one hop, endpoints take a capability read, a catalog fetch, and a
// platform round-trip for the allowance.
it(`withholds the whole access picture until the slower half has landed too`, () => {
    expect(accessKnown.value).toBe(false);

    accountsLoaded.value = true;
    expect(accessKnown.value).toBe(false);

    endpointsLoaded.value = true;
    expect(accessKnown.value).toBe(true);
});

// The ladder both the seed for a new conversation and the watcher that repoints an open one fall down. They used to
// hold two different ones — the seed stopped at the native list — so a chat opened on a sandbox whose only model was
// the trial was born on an unrunnable provider and only moved once some unrelated read changed. That gap is what
// flashed "connect a model" over a chat that could in fact send.
it(`falls to a connected account first, and to the trial only as the floor under nothing connected`, () => {
    expect(firstReadyProvider()).toBeUndefined();

    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    expect(firstReadyProvider()).toBe(TRIAL_PROVIDER);

    // A real account outranks it: the trial is a floor, never a substitute for a subscription someone is paying for.
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acc-1`, label: `ada@acme.dev`, connectedAt: 0 }] };
    expect(firstReadyProvider()).toBe(`claude`);
});

// One reading of the day's allowance for every surface (the empty pane's offer, the trial strip, the spent row): the
// boundary is half the allowance, by value.
it(`reads the trial's day as one phase: fresh up to half spent, low past it, spent at nothing left`, () => {
    expect(trialPhase(TRIAL_PROVIDER)).toBe(`none`);
    const at = (remaining: number): string => {
        trialStatus.value = { available: true, allowance: 12, used: 12 - remaining, remaining, health: `healthy` };
        return trialPhase(TRIAL_PROVIDER);
    };
    expect([at(12), at(7), at(6), at(1), at(0)]).toEqual([`fresh`, `fresh`, `low`, `low`, `spent`]);
    expect(trialExhausted(TRIAL_PROVIDER)).toBe(true);
    // Another provider is never on the trial.
    expect(trialPhase(`claude`)).toBe(`none`);
});
