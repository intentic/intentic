import { CLAUDE_CODE, CURSOR, DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy, type PrivacyShieldStatus } from "@intentic/sandbox-contract";
import { privacyStanding } from "./privacyStanding";

const statusOf = (policy: Partial<PrivacyShieldPolicy>): PrivacyShieldStatus => ({
    policy: { ...DEFAULT_PRIVACY_SHIELD, mode: `on`, ...policy },
    known: 0,
    tokens: 0,
    readers: { ocr: false, model: false },
    providers: [
        { id: `cursor`, label: `Cursor`, shieldable: false, local: false },
        { id: `claude`, label: `Claude`, shieldable: true, local: false },
    ],
});

describe(`where a conversation stands with the privacy shield before the send`, () => {
    test(`an untrusted provider the gateway cannot cover is said to be turned away, by its label`, () => {
        expect(privacyStanding(statusOf({}), `cursor`, CURSOR, `c-1`)).toEqual({ kind: `refused`, provider: `cursor`, label: `Cursor` });
    });

    test(`a grant for this conversation reads as granted, and one for another conversation does not`, () => {
        const status = statusOf({ conversations: [{ conversationId: `c-1`, provider: `cursor` }] });
        expect(privacyStanding(status, `cursor`, CURSOR, `c-1`)?.kind).toBe(`granted`);
        expect(privacyStanding(status, `cursor`, CURSOR, `c-2`)?.kind).toBe(`refused`);
    });

    test(`nothing to say while the shield is off or watching, for a runtime the gateway masks, or a provider trusted everywhere`, () => {
        expect(privacyStanding(statusOf({ mode: `off` }), `cursor`, CURSOR, `c-1`)).toBeUndefined();
        expect(privacyStanding(statusOf({ mode: `watch` }), `cursor`, CURSOR, `c-1`)).toBeUndefined();
        expect(privacyStanding(statusOf({}), `claude`, CLAUDE_CODE, `c-1`)).toBeUndefined();
        expect(privacyStanding(statusOf({ trusted: [`cursor`] }), `cursor`, CURSOR, `c-1`)).toBeUndefined();
        expect(privacyStanding(undefined, `cursor`, CURSOR, `c-1`)).toBeUndefined();
    });
});
