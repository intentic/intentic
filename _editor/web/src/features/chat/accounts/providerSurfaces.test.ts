// Every provider the contract knows must be servable by this app, walked from the spec table. Unlike
// the daemon, the browser has no init check that fails loudly when a new provider is missing a tab, a
// readiness rule, or a connect panel shape; each test below asks one such question of every provider.
import { accessFor, modelsFor, NATIVE_PROVIDERS, PROVIDER_SPECS, providerLabel, providerSpec, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { beforeEach, expect, it } from "vitest";
import { accessBadge, connectPitch, hasSignIn, providerReady } from "../session/access";
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
    // The label is the assertion: a blank tab is as unusable as no tab, and a missing one fails just as
    // loudly.
    expect(providerTabs.find((entry) => entry.value === provider)?.label.trim(), `${provider} has no account tab`).toBe(
        providerSpec(provider)?.accountLabel,
    );
});

it.each(NATIVE_PROVIDERS)(`%s reads as not connected on a sandbox with nothing connected`, (provider) => {
    // With no account anywhere, no provider may claim it can send.
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
    // Two labels, two questions: the picker names the runtime, the account rows name whose account it is.
    expect(providerLabel(provider), `${provider} has no picker label`).not.toBe(provider);
    expect(providerDisplayLabel(provider), `${provider} has no display label`).not.toBe(provider);
});

// A connected provider can send, per credential mechanism; each arm connects the thing that mechanism
// actually stores.
it.each(PROVIDER_SPECS.map((spec) => ({ id: spec.id, kind: spec.auth.kind })))(`$id can send once its $kind credential is connected`, ({ id }) => {
    const spec = providerSpec(id)!;
    if (spec.auth.kind === `translator`) {
        translatorAccounts.value = { ...translatorAccounts.value, [id]: [{ name: `${id}.json`, label: `an account` }] };
    } else {
        providerAccounts.value = { ...providerAccounts.value, [id]: [{ id: `a`, label: `an account`, connectedAt: 1 }] };
    }
    expect(providerReady(id), `${id} cannot send with its own credential connected`).toBe(true);
    // A connected provider stops advertising a price; the badge's absence is what says so.
    expect(accessBadge(id)).toBeUndefined();
});

// Only Claude carries a static browser-side floor; every other provider's list is deliberately empty
// until its first live load.
it.each(NATIVE_PROVIDERS)(`%s's browser-side model floor is Claude's alone`, (provider) => {
    expect(modelOptionsFor(provider).length > 0).toBe(provider === `claude`);
    expect(modelsFor(provider).length > 0).toBe(provider === `claude`);
});

// The trial endpoint is not a native provider; every rule above would ask it for a spec row it lacks.
it(`the free trial is not a native provider`, () => {
    expect(NATIVE_PROVIDERS).not.toContain(TRIAL_PROVIDER);
    expect(providerSpec(TRIAL_PROVIDER)).toBeUndefined();
});

/* WHICH PROVIDERS MAY BE OFFERED A SIGN-IN, asked of the spec table rather than by elimination.
 *
 * The account card used to ask it the other way round, "is this a translator subscription?", and treat every
 * other answer as a provider holding native accounts. A provider with no spec row is neither, and the free
 * trial is one: a fresh sandbox parks its first chat on it, the card followed the chat there, and drew
 * "endpoint/free-trial account · not connected" with a Connect button whose POST matched no route at all. */
it.each(NATIVE_PROVIDERS)(`%s has a sign-in a card may offer`, (provider) => {
    expect(hasSignIn(provider), `${provider} has nothing to connect`).toBe(true);
});

it(`the providers that carry their own credentials have no sign-in to offer`, () => {
    expect(hasSignIn(TRIAL_PROVIDER)).toBe(false);
    // An endpoint the user configured, and an installed ACP agent: same answer, and for the same reason.
    expect(hasSignIn(`endpoint/my-gateway`)).toBe(false);
    expect(hasSignIn(`some-acp-agent`)).toBe(false);
});
