import { promptAuthorOf, severalPeopleIn } from "./promptAuthor";
import type { ChatMessage } from "./transcript";

const self = { email: `owner@example.com`, name: `Owner` };
let next = 0;
const row = (fields: Partial<ChatMessage>): ChatMessage => ({ id: next++, role: `user`, text: `hi`, ...fields });
const by = (email: string, name?: string): ChatMessage =>
    row({ speaker: name === undefined ? { kind: `person`, email } : { kind: `person`, email, name } });

describe(`promptAuthorOf`, () => {
    test(`names the verified person on a user row`, () => {
        expect(promptAuthorOf(by(`a@example.com`, `Ann`), self)).toEqual({ email: `a@example.com`, name: `Ann` });
    });
    test(`a bubble this window drew is the signed-in person's`, () => {
        expect(promptAuthorOf(row({ local: true }), self)).toEqual(self);
    });
    test(`nobody for a program, an agent, an unattributed record row or the agent's own words`, () => {
        expect(promptAuthorOf(row({ speaker: { kind: `program`, token: `ci` } }), self)).toBeUndefined();
        expect(promptAuthorOf(row({ speaker: { kind: `agent`, conversationId: `c1` } }), self)).toBeUndefined();
        expect(promptAuthorOf(row({}), self)).toBeUndefined();
        expect(promptAuthorOf(row({ role: `assistant`, speaker: { kind: `person`, email: `a@example.com` } }), self)).toBeUndefined();
    });
});

describe(`severalPeopleIn`, () => {
    test(`one person, however many prompts and casings, is not several`, () => {
        expect(severalPeopleIn([by(`owner@example.com`), by(`Owner@Example.com`), row({ local: true })], self)).toBe(false);
    });
    test(`a second person makes it several`, () => {
        expect(severalPeopleIn([by(`owner@example.com`), row({ role: `assistant` }), by(`b@example.com`)], self)).toBe(true);
    });
    test(`the signed-in person's own unsent bubble counts as theirs`, () => {
        expect(severalPeopleIn([by(`b@example.com`), row({ local: true })], self)).toBe(true);
    });
});
