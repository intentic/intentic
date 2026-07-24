import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttleTrailing } from "./throttleTrailing";

describe(`throttleTrailing`, () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it(`runs the first call immediately, then at most once per window`, () => {
        const fn = vi.fn();
        const throttled = throttleTrailing(fn, 1000);
        throttled();
        expect(fn).toHaveBeenCalledTimes(1);
        throttled();
        throttled();
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    // The reason this is a throttle and not a debounce: the daemon's watcher keeps emitting batches for as long as
    // an upload or a build writes, and a debounce would reset its timer on every one and never fire at all.
    it(`keeps firing through an unending burst instead of starving`, () => {
        const fn = vi.fn();
        const throttled = throttleTrailing(fn, 1000);
        for (let elapsed = 0; elapsed < 5000; elapsed += 250) {
            throttled();
            vi.advanceTimersByTime(250);
        }
        // 20 batches over 5s collapse to the leading run plus one per closing window.
        expect(fn).toHaveBeenCalledTimes(6);
    });

    // A closed window leaves no timer behind, so an idle stretch doesn't delay the next change.
    it(`runs immediately again once the burst has drained`, () => {
        const fn = vi.fn();
        const throttled = throttleTrailing(fn, 1000);
        throttled();
        vi.advanceTimersByTime(5000);
        expect(fn).toHaveBeenCalledTimes(1);
        throttled();
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
