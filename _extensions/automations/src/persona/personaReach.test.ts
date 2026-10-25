import { defaultActsAs, personaReach } from "./personaReach";

const ACCOUNTS = [`cli`, `browser`];
const facts = (personas: readonly string[] | undefined, capabilityKinds: readonly string[] = ACCOUNTS) => ({ personas, capabilityKinds });

test(`no persona, with signed-in accounts in the sandbox, says the wake cannot use them`, () => {
    expect(personaReach({}, facts([`marketing`]))).toEqual({ kind: `no-accounts` });
    // An identity is an account too: its browser holds every account born from it.
    expect(personaReach({}, facts([], [`identity`]))).toEqual({ kind: `no-accounts` });
});

test(`no persona and no signed-in account to miss says nothing`, () => {
    expect(personaReach({}, facts([], [`cli`, `mcp`]))).toBeUndefined();
});

test(`a persona that exists says nothing`, () => {
    expect(personaReach({ actsAs: `marketing` }, facts([`marketing`]))).toBeUndefined();
});

test(`a persona that is gone, its own or a sender rule's, is named, and outranks the missing accounts`, () => {
    expect(personaReach({ actsAs: `reddit-writer` }, facts([`marketing`]))).toEqual({ kind: `missing`, ids: [`reddit-writer`] });
    const senders = { rules: [{ actsAs: `ghost` }, { actsAs: `marketing` }, { actsAs: `ghost` }], others: `ignore` as const };
    expect(personaReach({ senders }, facts([`marketing`]))).toEqual({ kind: `missing`, ids: [`ghost`] });
});

test(`while the persona list loads, a named persona is not called missing`, () => {
    expect(personaReach({ actsAs: `reddit-writer` }, facts(undefined))).toBeUndefined();
});

test(`a wake that continues a conversation or only notifies wears no persona, so nothing is said`, () => {
    expect(personaReach({ target: { kind: `notify` } }, facts([]))).toBeUndefined();
    expect(personaReach({ actsAs: `gone`, target: { kind: `conversation`, conversationId: `c1` } }, facts([]))).toBeUndefined();
    expect(personaReach({ target: { kind: `agent` } }, facts([]))).toEqual({ kind: `no-accounts` });
});

test(`a built-in is never missing, and naming No accounts outright says the same as naming none`, () => {
    expect(personaReach({ actsAs: `full-access` }, facts([]))).toBeUndefined();
    expect(personaReach({ actsAs: `no-accounts` }, facts([]))).toEqual({ kind: `no-accounts` });
    const senders = { rules: [{ actsAs: `full-access` }], others: `ignore` as const };
    expect(personaReach({ actsAs: `full-access`, senders }, facts([]))).toBeUndefined();
});

test(`a new automation starts on Full access only where nothing from outside reaches its prompt`, () => {
    expect(defaultActsAs(`schedule`, `none`)).toBe(`full-access`);
    expect(defaultActsAs(`once`, `none`)).toBe(`full-access`);
    expect(defaultActsAs(`workspace`, `none`)).toBe(`full-access`);
    // Somebody else's words: a listener, a webhook.
    expect(defaultActsAs(`listener`, `none`)).toBe(``);
    expect(defaultActsAs(`event`, `none`)).toBe(``);
    // A check's output rides into the prompt.
    expect(defaultActsAs(`schedule`, `guard`)).toBe(``);
    expect(defaultActsAs(`schedule`, `url`)).toBe(``);
});
