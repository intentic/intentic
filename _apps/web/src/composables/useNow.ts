import { onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

/* THE WALL CLOCK, once. Every live elapsed/time-ago readout — a card's "2m", a turn's ticking counter, a boot
 * total — reads this one ref instead of owning a `now` + setInterval of its own, which four views had grown
 * independently before this existed.
 *
 * Ref-counted, not always-on: the interval runs only while at least one consumer is armed, so a session parked
 * on a screen with no live readout pays nothing per second. `active` is what arms a consumer — defaulted to
 * "while mounted", and passed as a getter by readouts that only matter sometimes (a message view ticks only
 * while its turn streams). The first arm after an idle spell re-stamps the instant, so a readout appearing
 * minutes after the last one disappeared never opens on a clock frozen where the previous consumer left it. */

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
