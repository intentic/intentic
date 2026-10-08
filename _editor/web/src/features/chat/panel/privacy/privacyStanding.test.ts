import { ACP, CLAUDE_CODE, CURSOR, DEFAULT_PRIVACY_SHIELD, type PrivacyShieldPolicy, type PrivacyShieldStatus } from "@intentic/sandbox-contract";
import { privacyStanding } from "./privacyStanding";

const statusOf = (policy: Partial<PrivacyShieldPolicy>): PrivacyShieldStatus => ({
    policy: { ...DEFAULT_PRIVACY_SHIELD, mode: `on`, ...policy },
    known: 0,
    tokens: 0,
    readers: { ocr: false, model: false },
    providers: [
        { id: `cursor`, label: `Cursor`, shieldable: true, local: false },
        { id: `claude`, label: `Claude`, shieldable: true, local: false },
        { id: `my-acp`, label: `My agent`, shieldable: false, local: false },
    ],
});

describe(`where a conversation stands with the privacy shield before the send`, () => {
    // The reported case (2026-10-08): opening a Cursor chat showed the refusal before a word was written. The shield reads
    // Cursor by content now, so nothing is said until it has found something.
    test(`a runtime the shield reads through its hooks is said nothing about before anything was found`, () => {
        expect(privacyStanding(statusOf({}), `cursor`, CURSOR, `c-1`)).toBeUndefined();
        expect(privacyStanding(statusOf({}), `cursor`, CURSOR, `c-1`, { code: `sandbox-memory-low` })).toBeUndefined();
    });

    test(`what it found when the last turn was sent is said from then on, in the daemon's own words`, () => {
        const reason = `The privacy shield did not send this to Cursor: AGENTS.md holds personal data (names).`;
        expect(privacyStanding(statusOf({}), `cursor`, CURSOR, `c-1`, { code: `privacy-instructions`, text: reason })).toEqual({
            kind: `found`,
            provider: `cursor`,
            label: `Cursor`,
            reason,
        });
        expect(privacyStanding(statusOf({}), `cursor`, CURSOR, `c-1`, { code: `privacy-unshielded` })?.kind).toBe(`found`);
    });

    test(`an untrusted provider on a runtime the shield can't read at all is said to be turned away, by its label`, () => {
        expect(privacyStanding(statusOf({}), `my-acp`, ACP, `c-1`)).toEqual({ kind: `refused`, provider: `my-acp`, label: `My agent` });
    });

    test(`a grant for this conversation reads as granted, and one for another conversation does not`, () => {
        const status = statusOf({ conversations: [{ conversationId: `c-1`, provider: `my-acp` }] });
        expect(privacyStanding(status, `my-acp`, ACP, `c-1`)?.kind).toBe(`granted`);
        expect(privacyStanding(status, `my-acp`, ACP, `c-2`)?.kind).toBe(`refused`);
        const cursor = statusOf({ conversations: [{ conversationId: `c-1`, provider: `cursor` }] });
        expect(privacyStanding(cursor, `cursor`, CURSOR, `c-1`)?.kind).toBe(`granted`);
    });

    test(`nothing to say while the shield is off or watching, for a runtime the gateway masks, or a provider trusted everywhere`, () => {
        expect(privacyStanding(statusOf({ mode: `off` }), `my-acp`, ACP, `c-1`)).toBeUndefined();
        expect(privacyStanding(statusOf({ mode: `watch` }), `my-acp`, ACP, `c-1`)).toBeUndefined();
        expect(privacyStanding(statusOf({}), `claude`, CLAUDE_CODE, `c-1`)).toBeUndefined();
        expect(privacyStanding(statusOf({ trusted: [`my-acp`] }), `my-acp`, ACP, `c-1`)).toBeUndefined();
        expect(privacyStanding(undefined, `my-acp`, ACP, `c-1`)).toBeUndefined();
    });
});
