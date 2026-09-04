/* EVERY PROVIDER THE CONTRACT KNOWS IS SERVABLE BY THIS APP, walked from the spec table rather than from a
 * list kept here.
 *
 * It exists because this side of the wire is where a provider used to go missing. The daemon's registry throws
 * at init on a module it has no row for; the browser has no such moment, so a provider added to the contract
 * appeared in the model picker (that list was already derived) and then had no tab to connect it on, no
 * readiness rule that knew how its credential is held, and a connect panel that fell through to a shape meant
 * for something else. Nothing failed. It just could not be used.
 *
 * So each test below asks one question of EVERY provider, and the answer has to be one a surface can render. */
import { accessFor, modelsFor, NATIVE_PROVIDERS, PROVIDER_SPECS, providerLabel, providerSpec, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { beforeEach, expect, it } from "vitest";
import { accessBadge, connectPitch, providerReady } from "./access";
import { accountsLoaded, noTranslatorAccounts, providerAccounts, translatorAccounts } from "./providerAccounts";
import {
    acpProviders,
    endpointProviders,
    endpointsLoaded,
    modelOptionsFor,
    perProvider,
    providerDisplayLabel,
    providerTabs,
} from "./providerCatalog";

beforeEach(() => {
    providerAccounts.value = perProvider(() => []);
    translatorAccounts.value = noTranslatorAccounts();
    acpProviders.value = [];
    endpointProviders.value = [];
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
});

it.each(NATIVE_PROVIDERS)(`%s has a tab to connect it on`, (provider) => {
    // The label is the assertion: a tab that exists with nothing written on it is the same unusable row as
    // no tab at all, and `find` returning undefined fails this line just as loudly.
    expect(providerTabs.find((entry) => entry.value === provider)?.label.trim(), `${provider} has no account tab`).toBe(
        providerSpec(provider)?.accountLabel,
    );
});

it.each(NATIVE_PROVIDERS)(`%s reads as not connected on a sandbox with nothing connected`, (provider) => {
    // The floor every surface stands on: with no account anywhere, no provider may claim it can send. The rule
    // this replaced fell through to "any account exists" for a provider it did not name, so a new one reported
    // itself ready the moment an unrelated Claude account was connected.
    expect(providerReady(provider), `${provider} claims it can send with nothing connected`).toBe(false);
});

it.each(NATIVE_PROVIDERS)(`%s says what it costs and what to connect while it is locked`, (provider) => {
    // A locked row must state its price; an empty badge is a row a user cannot act on.
    expect(accessBadge(provider), `${provider} is locked with no badge`).toContain(accessFor(provider)?.requirement);
    for (const harness of [`native`, `claude-code`] as const) {
        const pitch = connectPitch(provider, harness);
        expect(pitch?.copy, `${provider}/${harness}`).toContain(accessFor(provider)?.requirement);
        expect(pitch?.action.trim()).not.toBe(``);
    }
});

it.each(NATIVE_PROVIDERS)(`%s has a name every surface can print`, (provider) => {
    // Two labels, two questions: the picker names the runtime, the account rows name whose account it is. Both
    // must resolve to something other than the raw id, which is what a provider nobody described falls back to.
    expect(providerLabel(provider), `${provider} has no picker label`).not.toBe(provider);
    expect(providerDisplayLabel(provider), `${provider} has no display label`).not.toBe(provider);
});

/* A CONNECTED PROVIDER CAN SEND, per credential mechanism, which is the other half of the "not connected" test
 * above: a readiness rule that answered false for everything would pass that one and break the product. Each
 * arm connects the thing that mechanism actually stores. */
it.each(PROVIDER_SPECS.map((spec) => ({ id: spec.id, kind: spec.auth.kind })))(`$id can send once its $kind credential is connected`, ({ id }) => {
    const spec = providerSpec(id)!;
    if (spec.auth.kind === `translator`) {
        translatorAccounts.value = { ...translatorAccounts.value, [id]: [{ name: `${id}.json`, label: `an account` }] };
    } else {
        providerAccounts.value = { ...providerAccounts.value, [id]: [{ id: `a`, label: `an account`, connectedAt: 1 }] };
    }
    expect(providerReady(id), `${id} cannot send with its own credential connected`).toBe(true);
    // …and a connected provider stops advertising a price, which is what the badge's absence means.
    expect(accessBadge(id)).toBeUndefined();
});

/* A PROVIDER'S PICKER IS NEVER BLANK BEFORE ITS FIRST LIVE LOAD — or rather, it is blank for a stated reason.
 * Only Claude carries a static floor in the browser; every other provider's catalog is one route away and
 * never empty daemon-side, which is why the picker shows a per-provider spinner rather than an empty list. This
 * pins that the browser's floor is deliberately empty for them rather than accidentally so. */
it.each(NATIVE_PROVIDERS)(`%s's browser-side model floor is Claude's alone`, (provider) => {
    expect(modelOptionsFor(provider).length > 0).toBe(provider === `claude`);
    expect(modelsFor(provider).length > 0).toBe(provider === `claude`);
});

// The reserved endpoint the daemon provisions is not a native provider and must never be mistaken for one:
// every rule above would then ask it for a spec row it does not have.
it(`the free trial is not a native provider`, () => {
    expect(NATIVE_PROVIDERS).not.toContain(TRIAL_PROVIDER);
    expect(providerSpec(TRIAL_PROVIDER)).toBeUndefined();
});
