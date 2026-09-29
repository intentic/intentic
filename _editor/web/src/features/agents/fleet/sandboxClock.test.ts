import { clockOffset, observeRoster, offsetOf, resetSandboxClock, SAMPLE_TTL_MS, sandboxNow } from "./sandboxClock";
import { formatElapsed } from "./agentStatus";

// The sandbox's clock read off the roster: a browser clock 96 s fast drew a turn one second old as "1m 36s".
const NOW = 1_700_000_000_000;
const entry = (id: string, updatedAt: number) => ({ id, updatedAt });

beforeEach(() => {
    resetSandboxClock();
});

describe("offsetOf", () => {
    it("takes the smallest reading, since delivery delay only ever adds to one", () => {
        expect(offsetOf([96_400, 96_050, 97_900])).toBe(96_050);
        expect(offsetOf([-30_000, -29_000])).toBe(-30_000);
    });

    it("leaves delivery delay alone: under two seconds is no wrong clock", () => {
        expect(offsetOf([1_999, 2_500])).toBe(0);
        expect(offsetOf([])).toBe(0);
    });
});

describe("observeRoster", () => {
    it("corrects a fast browser clock so a fresh turn counts from zero", () => {
        const sandboxTime = NOW - 96_000;
        observeRoster([entry(`a`, sandboxTime - 5_000)], [entry(`a`, sandboxTime)], NOW);
        expect(clockOffset.value).toBe(96_000);
        // The turn started on the sandbox a second ago; the card reads it against the corrected clock.
        expect(formatElapsed(sandboxTime - 1_000, sandboxNow(NOW))).toBe(`1s`);
    });

    it("corrects a slow one the other way", () => {
        observeRoster([entry(`a`, NOW)], [entry(`a`, NOW + 45_000)], NOW);
        expect(sandboxNow(NOW)).toBe(NOW + 45_000);
    });

    it("reads nothing from a card it had not seen, nor from an instant that did not move forward", () => {
        observeRoster([entry(`a`, NOW - 90_000)], [entry(`a`, NOW - 90_000), entry(`b`, NOW - 600_000)], NOW);
        observeRoster([entry(`a`, NOW - 90_000)], [entry(`a`, NOW - 95_000)], NOW);
        expect(clockOffset.value).toBe(0);
    });

    it("follows a clock the machine corrected, once the old readings age out", () => {
        observeRoster([entry(`a`, 0)], [entry(`a`, NOW - 96_000)], NOW);
        const later = NOW + SAMPLE_TTL_MS + 1;
        observeRoster([entry(`a`, NOW - 96_000)], [entry(`a`, later - 300)], later);
        expect(clockOffset.value).toBe(0);
    });
});
