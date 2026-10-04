import { computed, onScopeDispose, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from "vue";

// One shared wall clock per cadence, not one interval per readout. Live elapsed/countdowns use seconds; relative
// dates use minutes so settled cards are not woken by every running card's tick. Each timer is ref-counted.
interface Clock {
    readonly now: Ref<number>;
    readonly intervalMs: number;
    consumers: number;
    ticker: ReturnType<typeof setInterval> | undefined;
}

const clocks = new Map<number, Clock>();
const clockFor = (intervalMs: number): Clock => {
    const existing = clocks.get(intervalMs);
    if (existing !== undefined) {
        return existing;
    }
    const clock: Clock = { now: ref(Date.now()), intervalMs, consumers: 0, ticker: undefined };
    clocks.set(intervalMs, clock);
    return clock;
};

const arm = (clock: Clock): void => {
    // A minute clock may have last ticked nearly a minute ago. Starting to follow it must show the current instant,
    // even when another consumer already keeps its timer alive; do not restart that timer and postpone its next tick.
    clock.now.value = Date.now();
    if (clock.consumers++ > 0) {
        return;
    }
    clock.ticker = setInterval(() => (clock.now.value = Date.now()), clock.intervalMs);
};

const disarm = (clock: Clock): void => {
    if (--clock.consumers > 0) {
        return;
    }
    clearInterval(clock.ticker);
    clock.ticker = undefined;
};

export function useNow(active: MaybeRefOrGetter<boolean> = true, intervalMs = 1000): ComputedRef<number> {
    const clock = clockFor(intervalMs);
    const on = computed(() => toValue(active));
    // Tracked per consumer so a scope dying while inactive doesn't decrement a count it never raised.
    let armed = false;
    // The instant this consumer stopped following. Held so a settled readout keeps the time it settled at instead of
    // jumping to whenever some other consumer last ticked.
    const frozen = ref(clock.now.value);
    watch(
        on,
        (next) => {
            if (next === armed) {
                return;
            }
            armed = next;
            if (next) {
                arm(clock);
                return;
            }
            frozen.value = clock.now.value;
            disarm(clock);
        },
        { immediate: true },
    );
    onScopeDispose(() => {
        if (armed) {
            armed = false;
            disarm(clock);
        }
    });
    // Reads the shared ref only while armed, so the gate binds the DEPENDENCY and not merely the interval. One running
    // card arms the clock for the whole window, and a consumer reading `now` unconditionally was woken once a second
    // by a tick it had asked not to receive — measured as three shell components re-evaluating every second on an
    // otherwise idle board.
    return computed(() => (on.value ? clock.now.value : frozen.value));
}
