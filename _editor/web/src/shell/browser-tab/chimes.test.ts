import { CHIME_GAP_MS, CHIMES, claimChime } from "./chimes";

const store = (): Pick<Storage, `getItem` | `setItem`> & { readonly held: Map<string, string> } => {
    const held = new Map<string, string>();
    return { held, getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) };
};

describe(`one chime across every tab`, () => {
    it(`lets the first window ring and keeps the rest quiet inside the gap`, () => {
        const storage = store();
        expect(claimChime(storage, 10_000)).toBe(true);
        expect(claimChime(storage, 10_000 + CHIME_GAP_MS - 1)).toBe(false);
        expect(claimChime(storage, 10_000 + CHIME_GAP_MS)).toBe(true);
    });

    // A clock set back, or a stored value from another machine's time, must not silence every chime until it passes.
    it(`rings when the last claim is in the future or unreadable`, () => {
        const storage = store();
        storage.setItem(`intentic.chime-at`, String(99_000));
        expect(claimChime(storage, 10_000)).toBe(true);
        storage.setItem(`intentic.chime-at`, `garbage`);
        expect(claimChime(storage, 20_000)).toBe(true);
    });
});

describe(`the two sounds`, () => {
    // The doorbell falls and the finish rises: the direction is what tells them apart without looking.
    it(`fall for an ask and rise for a finish`, () => {
        const [askFirst, askSecond] = CHIMES.asks;
        const [doneFirst, doneSecond] = CHIMES.finished;
        expect(askSecond.hz).toBeLessThan(askFirst.hz);
        expect(doneSecond.hz).toBeGreaterThan(doneFirst.hz);
    });

    it(`keep the finish quieter than the ask`, () => {
        expect(Math.max(...CHIMES.finished.map((note) => note.gain))).toBeLessThan(Math.min(...CHIMES.asks.map((note) => note.gain)));
    });
});
