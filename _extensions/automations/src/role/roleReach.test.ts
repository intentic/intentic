import { defaultActsAs, roleReach } from "./roleReach";

const ACCOUNTS = [`cli`, `browser`];
const facts = (roles: readonly string[] | undefined, capabilityKinds: readonly string[] = ACCOUNTS) => ({ roles, capabilityKinds });

test(`no role, with signed-in accounts in the sandbox, says the wake cannot use them`, () => {
    expect(roleReach({}, facts([`marketing`]))).toEqual({ kind: `no-accounts` });
    // An identity is an account too: its browser holds every account born from it.
    expect(roleReach({}, facts([], [`identity`]))).toEqual({ kind: `no-accounts` });
});

test(`no role and no signed-in account to miss says nothing`, () => {
    expect(roleReach({}, facts([], [`cli`, `mcp`]))).toBeUndefined();
});

test(`a role that exists says nothing`, () => {
    expect(roleReach({ actsAs: `marketing` }, facts([`marketing`]))).toBeUndefined();
});

test(`a role that is gone, its own or a sender rule's, is named, and outranks the missing accounts`, () => {
    expect(roleReach({ actsAs: `reddit-writer` }, facts([`marketing`]))).toEqual({ kind: `missing`, ids: [`reddit-writer`] });
    const senders = { rules: [{ actsAs: `ghost` }, { actsAs: `marketing` }, { actsAs: `ghost` }], others: `ignore` as const };
    expect(roleReach({ senders }, facts([`marketing`]))).toEqual({ kind: `missing`, ids: [`ghost`] });
});

test(`while the role list loads, a named role is not called missing`, () => {
    expect(roleReach({ actsAs: `reddit-writer` }, facts(undefined))).toBeUndefined();
});

test(`a wake that continues a conversation or only notifies wears no role, so nothing is said`, () => {
    expect(roleReach({ target: { kind: `notify` } }, facts([]))).toBeUndefined();
    expect(roleReach({ actsAs: `gone`, target: { kind: `conversation`, conversationId: `c1` } }, facts([]))).toBeUndefined();
    expect(roleReach({ target: { kind: `agent` } }, facts([]))).toEqual({ kind: `no-accounts` });
});

test(`a built-in is never missing, and naming No accounts outright says the same as naming none`, () => {
    expect(roleReach({ actsAs: `full-access` }, facts([]))).toBeUndefined();
    expect(roleReach({ actsAs: `no-accounts` }, facts([]))).toEqual({ kind: `no-accounts` });
    const senders = { rules: [{ actsAs: `full-access` }], others: `ignore` as const };
    expect(roleReach({ actsAs: `full-access`, senders }, facts([]))).toBeUndefined();
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
