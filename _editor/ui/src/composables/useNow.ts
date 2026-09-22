import { computed, onScopeDispose, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from "vue";

// The wall clock, once: every live elapsed/time-ago readout shares this ref instead of its own interval.
// Ref-counted: the interval runs only while a consumer is armed. The first arm after an idle spell
// re-stamps the instant, so a readout doesn't reopen on a clock frozen where the last consumer left it.

const now = ref(Date.now());
let consumers = 0;
let ticker: ReturnType<typeof setInterval> | undefined;

const arm = (): void => {
    if (consumers++ > 0) {
        return;
    }
    now.value = Date.now();
    ticker = setInterval(() => (now.value = Date.now()), 1000);
};

const disarm = (): void => {
    if (--consumers > 0) {
        return;
    }
    clearInterval(ticker);
    ticker = undefined;
};

export function useNow(active: MaybeRefOrGetter<boolean> = true): ComputedRef<number> {
    const on = computed(() => toValue(active));
    // Tracked per consumer so a scope dying while inactive doesn't decrement a count it never raised.
    let armed = false;
    // The instant this consumer stopped following. Held so a settled readout keeps the time it settled at instead of
    // jumping to whenever some other consumer last ticked.
    const frozen = ref(now.value);
    watch(
        on,
        (next) => {
            if (next === armed) {
                return;
            }
            armed = next;
            if (next) {
                arm();
                return;
            }
            frozen.value = now.value;
            disarm();
        },
        { immediate: true },
    );
    onScopeDispose(() => {
        if (armed) {
            armed = false;
            disarm();
        }
    });
    // Reads the shared ref only while armed, so the gate binds the DEPENDENCY and not merely the interval. One running
    // card arms the clock for the whole window, and a consumer reading `now` unconditionally was woken once a second
    // by a tick it had asked not to receive — measured as three shell components re-evaluating every second on an
    // otherwise idle board.
    return computed(() => (on.value ? now.value : frozen.value));
}
