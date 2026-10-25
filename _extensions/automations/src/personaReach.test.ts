import { personaReach } from "./personaReach";

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
