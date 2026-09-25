import { legacyKindOf, type PushFindingKind, pushFindingRecheckable, pushFindingSource } from "./mainline.js";

// What measured a push finding is the repository's own word for it now (`source`), and older daemons filed only the
// kind enum: every reader names a finding the same way whichever daemon filed it.

describe(`what measured a push finding`, () => {
    test(`is its source when filed with one, else the check it was filed under, else its kind`, () => {
        expect(pushFindingSource({ source: `mypy`, kind: `check`, check: `mypy` })).toBe(`mypy`);
        expect(pushFindingSource({ kind: `check`, check: `paths` })).toBe(`paths`);
        expect(pushFindingSource({ kind: `ratchet` })).toBe(`ratchet`);
        expect(pushFindingSource({ kind: `check` })).toBe(`check`);
    });

    test(`is filed for an older editor as the kind it knows, or a check of that name`, () => {
        expect(legacyKindOf(`lint`)).toEqual({ kind: `lint` });
        expect(legacyKindOf(`rustfmt`)).toEqual({ kind: `rustfmt` });
        expect(legacyKindOf(`pre-push`)).toEqual({ kind: `check`, check: `pre-push` });
    });

    test(`can be measured again as filed, else only a check's or the linter's could`, () => {
        expect(pushFindingRecheckable({ recheckable: false, kind: `check` })).toBe(false);
        expect(pushFindingRecheckable({ recheckable: true, kind: `ratchet` })).toBe(true);
        const kinds: readonly PushFindingKind[] = [`check`, `lint`, `ratchet`, `lockstep`, `rustfmt`];
        expect(kinds.map((kind) => pushFindingRecheckable({ kind }))).toEqual([
            true,
            true,
            false,
            false,
            false,
        ]);
    });
});
