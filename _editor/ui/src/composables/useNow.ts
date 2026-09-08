import { onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

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

export function useNow(active: MaybeRefOrGetter<boolean> = true): Ref<number> {
    // Tracked per consumer so a scope dying while inactive doesn't decrement a count it never raised.
    let armed = false;
    watch(
        () => toValue(active),
        (on) => {
            if (on === armed) {
                return;
            }
            armed = on;
            if (on) {
                arm();
            } else {
                disarm();
            }
        },
        { immediate: true },
    );
    onScopeDispose(() => {
        if (armed) {
            armed = false;
            disarm();
        }
    });
    return now;
}
