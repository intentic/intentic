import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { useNow } from "@intentic/ui/async";

// The ref-count is the whole point: one interval however many readouts are up, none once the last one is gone,
// and a consumer that arms after an idle spell reads a fresh instant rather than the one the clock stopped on.
describe(`useNow`, () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
    });
    afterEach(() => vi.useRealTimers());

    it(`ticks while a consumer is mounted and stops with the last one`, async () => {
        const scope = effectScope();
        const now = scope.run(() => useNow())!;
        expect(now.value).toBe(1_000_000);

        vi.advanceTimersByTime(2_000);
        expect(now.value).toBe(1_002_000);

        scope.stop();
        vi.advanceTimersByTime(5_000);
        expect(now.value).toBe(1_002_000);
        await nextTick();
    });

    it(`shares one clock across consumers and keeps it while any survives`, () => {
        const first = effectScope();
        const second = effectScope();
        const a = first.run(() => useNow())!;
        const b = second.run(() => useNow())!;
        expect(a).toBe(b);

        first.stop();
        vi.advanceTimersByTime(1_000);
        expect(b.value).toBe(1_001_000);

        second.stop();
        vi.advanceTimersByTime(1_000);
        expect(b.value).toBe(1_001_000);
    });

    it(`arms and disarms with its active gate, re-stamping on arm`, async () => {
        const active = ref(false);
        const scope = effectScope();
        const now = scope.run(() => useNow(active))!;

        vi.advanceTimersByTime(3_000);
        active.value = true;
        await nextTick();
        // Re-stamped at arm: the 3s that passed while off must not read as a frozen clock.
        expect(now.value).toBe(1_003_000);
        vi.advanceTimersByTime(1_000);
        expect(now.value).toBe(1_004_000);

        active.value = false;
        await nextTick();
        vi.advanceTimersByTime(2_000);
        expect(now.value).toBe(1_004_000);
        scope.stop();
    });

    it(`a scope dying while inactive leaves the count alone`, async () => {
        const active = ref(false);
        const gated = effectScope();
        gated.run(() => useNow(active));

        const steady = effectScope();
        const now = steady.run(() => useNow())!;
        expect(now.value).toBe(1_000_000);

        gated.stop();
        vi.advanceTimersByTime(1_000);
        expect(now.value).toBe(1_001_000);
        steady.stop();
        await nextTick();
    });
});
