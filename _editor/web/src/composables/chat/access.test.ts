/* THE ONE RULE THAT DECIDES WHETHER A TURN CAN BE SENT, on the axis the free trial added.
 *
 * Two things are asserted here and they are the two that were wrong. First, an endpoint provider is ready — the
 * composer used to keep its own copy of this rule that knew nothing about endpoints, so a sandbox running the
 * free trial listed a trial row with an allowance badge on it and refused to send the moment anybody chose it.
 * Second, the trial is the one endpoint whose readiness is a MEASUREMENT: a spent allowance is not ready, which
 * is what hands the screen back to the connect offer instead of letting a user type into a box that can only
 * answer with a 429. */
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { beforeEach, expect, it } from "vitest";
import { providerReady, providerReadyOn } from "./access";
import { providerAccounts, translatorAccounts } from "./providerAccounts";
import { acpProviders, endpointProviders, perProvider, trialStatus } from "./providerCatalog";

const OLLAMA = `endpoint/ollama`;

// Nothing connected, no capabilities, no trial — every test states the part of the picture it is about.
beforeEach(() => {
    providerAccounts.value = perProvider(() => []);
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    acpProviders.value = [];
    endpointProviders.value = [];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
});

it(`counts a configured endpoint as ready — it carries its own credential`, () => {
    expect(providerReady(OLLAMA)).toBe(false);

    endpointProviders.value = [{ id: OLLAMA, label: `ollama` }];

    expect(providerReady(OLLAMA)).toBe(true);
    // The composer's gate is this same rule, so it cannot disagree — which it did, and that disagreement is
    // the whole reason this file exists.
    expect(providerReadyOn(OLLAMA, `claude-code`)).toBe(true);
    expect(providerReadyOn(OLLAMA, `native`)).toBe(true);
});

it(`serves the trial while there is allowance left, and stops when there is none`, () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial` }];

    // Discovered but not yet confirmed by the platform: no trial. Unknown is treated as absent everywhere the
    // trial is read, because offering an allowance that may not exist costs the user their first message.
    expect(providerReady(TRIAL_PROVIDER)).toBe(false);

    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    expect(providerReady(TRIAL_PROVIDER)).toBe(true);
    expect(providerReadyOn(TRIAL_PROVIDER, `claude-code`)).toBe(true);

    trialStatus.value = { available: true, allowance: 12, used: 12, remaining: 0, health: `healthy` };
    expect(providerReady(TRIAL_PROVIDER)).toBe(false);
});

it(`does not invent a trial the daemon never provisioned`, () => {
    // The allowance says yes and the endpoint isn't there. That combination means the capability read hasn't
    // landed yet, and a chat pointed at a provider with no catalog sends an empty model id.
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };

    expect(providerReady(TRIAL_PROVIDER)).toBe(false);
});
