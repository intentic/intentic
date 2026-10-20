import { DEFAULT_PRIVACY_SHIELD, type PrivacyShieldMode, type PrivacyShieldPolicy, withConversationTrust } from "./privacy.js";
import { isPrivacyRefusal, ownerTrusted, type PrivacyEgress, type PrivacyRoute, shieldVerdict, turnRoute } from "./privacy-egress.js";

// One verdict for every place bytes leave for a model, and for the editor's word before a send. Each scenario the shield
// once got wrong at one of those places is a row here, so a place that reads the verdict cannot get it wrong again.

const policy = (mode: PrivacyShieldMode, extra: Partial<PrivacyShieldPolicy> = {}): PrivacyShieldPolicy => ({ ...DEFAULT_PRIVACY_SHIELD, mode, ...extra });
const egress = (route: PrivacyRoute, extra: Partial<PrivacyEgress> = {}): PrivacyEgress => ({ provider: "cursor", local: false, route, ...extra });

const ROUTES: readonly PrivacyRoute[] = ["gateway", "hooks", "sealed", "runtime", "runner", "own-key", "shared-server"];

describe(`shieldVerdict`, () => {
    it(`passes everything while the shield is off, and only reads while it watches`, () => {
        for (const route of ROUTES) {
            expect(shieldVerdict(policy(`off`), egress(route))).toEqual({ kind: `pass`, because: `off` });
        }
        expect(ROUTES.map((route) => shieldVerdict(policy(`watch`), egress(route)).kind)).toEqual([
            `watch`,
            `watch`,
            `watch`,
            `pass`,
            `pass`,
            `pass`,
            `pass`,
        ]);
    });

    it(`masks every seam and refuses every bypass while it is on`, () => {
        expect(ROUTES.map((route) => shieldVerdict(policy(`on`), egress(route)))).toEqual([
            { kind: `mask` },
            { kind: `mask` },
            { kind: `mask` },
            { kind: `refuse`, route: `runtime` },
            { kind: `refuse`, route: `runner` },
            { kind: `refuse`, route: `own-key` },
            { kind: `refuse`, route: `shared-server` },
        ]);
    });

    it(`passes a local model, a trusted provider and a granted conversation on every route`, () => {
        const granted = withConversationTrust(policy(`on`), `c-1`, `cursor`, true);
        for (const route of ROUTES) {
            expect(shieldVerdict(policy(`on`), egress(route, { local: true }))).toEqual({ kind: `pass`, because: `local` });
            expect(shieldVerdict(policy(`on`, { trusted: [`cursor`] }), egress(route))).toEqual({ kind: `pass`, because: `trusted` });
            expect(shieldVerdict(granted, egress(route, { conversationId: `c-1` }))).toEqual({ kind: `pass`, because: `granted` });
            // The grant is that conversation's alone, and a request outside any conversation (a helper) has none.
            expect(shieldVerdict(granted, egress(route, { conversationId: `c-2` })).kind).not.toBe(`pass`);
            expect(shieldVerdict(granted, egress(route)).kind).not.toBe(`pass`);
        }
    });

    // grand-mesa-dsjg (2026-10-07): commit messages on Composer were refused before a word was read, while a turn on the
    // same provider ran. A helper's prompt is sealed, so it is read and masked like a turn's, never refused for its runtime.
    it(`reads a helper's sealed prompt exactly as a hooked turn is read`, () => {
        expect(shieldVerdict(policy(`on`), egress(`sealed`))).toEqual(shieldVerdict(policy(`on`), egress(`hooks`)));
    });

    // calm-lichen-5wrn (2026-10-08): opening a Cursor composer warned before anything was sent. A hooked runtime is a seam.
    // deft-shale-590s (2026-10-11): the same conversation on a runner was refused only after the send.
    it(`refuses a turn by its placement, not by its runtime`, () => {
        expect(shieldVerdict(policy(`on`), egress(turnRoute(`hooks`)))).toEqual({ kind: `mask` });
        expect(shieldVerdict(policy(`on`), egress(turnRoute(`hooks`, `omen`)))).toEqual({ kind: `refuse`, route: `runner` });
        expect(shieldVerdict(policy(`on`), egress(turnRoute(`gateway`, `omen`)))).toEqual({ kind: `refuse`, route: `runner` });
        expect(shieldVerdict(policy(`on`), egress(turnRoute(`none`)))).toEqual({ kind: `refuse`, route: `runtime` });
    });

    it(`calls only the owner's own choices trusted`, () => {
        expect(ownerTrusted({ kind: `pass`, because: `granted` })).toBe(true);
        expect(ownerTrusted({ kind: `pass`, because: `local` })).toBe(true);
        expect(ownerTrusted({ kind: `pass`, because: `off` })).toBe(false);
        expect(ownerTrusted({ kind: `pass`, because: `unwatched` })).toBe(false);
        expect(ownerTrusted({ kind: `mask` })).toBe(false);
    });
});

describe(`isPrivacyRefusal`, () => {
    it(`knows the shield's own refusals and nothing else`, () => {
        expect(isPrivacyRefusal(`privacy-unshielded`)).toBe(true);
        expect(isPrivacyRefusal(`privacy-instructions`)).toBe(true);
        expect(isPrivacyRefusal(`model-unavailable`)).toBe(false);
        expect(isPrivacyRefusal(undefined)).toBe(false);
    });
});
