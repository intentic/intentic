import { PEAK, PHRASES, renderPhrase } from "./chimeSound";
import { CHIME_GAP_MS, claimChime } from "./chimes";

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

describe(`the roneat thung`, () => {
    const { asks, finished } = PHRASES;

    // The doorbell falls and the finish rises: the direction is what tells them apart without looking.
    it(`falls for an ask and rises for a finish`, () => {
        expect(asks.at(-1)!.hz).toBeLessThan(asks[0]!.hz);
        expect(finished.at(-1)!.hz).toBeGreaterThan(finished[0]!.hz);
    });

    // Nothing shrill: every fundamental stays low.
    it(`stays low`, () => {
        for (const note of [...asks, ...finished]) {
            expect(note.hz).toBeGreaterThanOrEqual(150);
            expect(note.hz).toBeLessThanOrEqual(600);
        }
    });

    it(`renders finite sound at its phrase's peak, the finish quieter, the same every time`, () => {
        const ask = renderPhrase(`asks`, 16_000);
        const done = renderPhrase(`finished`, 16_000);
        const peak = (samples: Float32Array): number => samples.reduce((top, sample) => Math.max(top, Math.abs(sample)), 0);
        expect(ask.every(Number.isFinite)).toBe(true);
        expect(peak(ask)).toBeCloseTo(PEAK.asks, 3);
        expect(peak(done)).toBeCloseTo(PEAK.finished, 3);
        expect(renderPhrase(`asks`, 16_000)).toEqual(ask);
        // Silent at the end, so a cut tail never clicks.
        expect(Math.abs(ask.at(-1)!)).toBeLessThan(1e-3);
    });
});
