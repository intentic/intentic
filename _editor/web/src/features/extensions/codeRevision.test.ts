import { codeRevisionOf } from "./codeRevision";

describe(`codeRevisionOf`, () => {
    const commit = `a`.repeat(40);

    it(`reads the pinned commit for an install running its pinned version`, () => {
        expect(codeRevisionOf({ commit })).toBe(commit);
    });

    it(`reads the checkout's bundle fingerprint while one runs from source, so a rebuild reads as a new revision`, () => {
        const before = codeRevisionOf({ commit, dev: { path: `extensions/maintenance`, revision: `0123456789ab` } });
        const after = codeRevisionOf({ commit, dev: { path: `extensions/maintenance`, revision: `ba9876543210` } });
        expect(before).toBe(`0123456789ab`);
        expect(after).not.toBe(before);
    });

    it(`falls back to the pinned commit while the checkout is held, since that is what runs`, () => {
        expect(codeRevisionOf({ commit, dev: { path: `extensions/maintenance`, held: `not built yet` } })).toBe(commit);
    });
});
