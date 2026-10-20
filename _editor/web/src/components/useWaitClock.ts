import { formatElapsed } from "@intentic/ui/format";
import { useNow } from "@intentic/ui/async";
import { computed, type ComputedRef, type MaybeRefOrGetter, ref, type Ref, toValue, watch } from "vue";
import type { WaitExpectation } from "./waitProgress";

// THE CLOCK BEHIND A <WaitProgress>, for a wait that is not a sandbox outage: a press whose work runs for a while (a
// clone, an install, a move). The wait starts at `startedAt` (the operation ledger's own `startedAt`, or the moment
// a busy flag turned on, from `useBusySince`) and is shown only while that is defined. The clock ticks only while
// something is waiting, on the shared one-second clock every live readout uses.

type Expectation = Omit<WaitExpectation, `elapsedMs`>;

export const useWaitClock = (
    startedAt: MaybeRefOrGetter<number | undefined>,
    expect: MaybeRefOrGetter<Expectation> = {},
): ComputedRef<WaitExpectation | undefined> => {
    const now = useNow(() => toValue(startedAt) !== undefined);
    return computed(() => {
        const since = toValue(startedAt);
        return since === undefined ? undefined : { ...toValue(expect), elapsedMs: Math.max(0, now.value - since) };
    });
};

// When a busy flag last turned on, while it stays on; undefined while it is off. For a press that holds only a flag.
export const useBusySince = (busy: MaybeRefOrGetter<boolean>): Readonly<Ref<number | undefined>> => {
    const since = ref<number | undefined>(toValue(busy) ? Date.now() : undefined);
    watch(
        () => toValue(busy),
        (on) => {
            since.value = on ? (since.value ?? Date.now()) : undefined;
        },
    );
    return since;
};

// A wait most cases of which end in a moment (a reconnect, a first frame) says how long it has run only once it has
// outlasted one: "Reconnecting…" read the same after five seconds as after five minutes, and only the second is worth a
// look, while a counter on every blip would be noise.
export const SAY_ELAPSED_AFTER_MS = 5_000;

/** How long a wait has run ("1m 5s"), once it has outlasted a blip; undefined before then and while none runs. */
export const useElapsedWords = (startedAt: MaybeRefOrGetter<number | undefined>): ComputedRef<string | undefined> => {
    const clock = useWaitClock(startedAt);
    return computed(() => {
        const wait = clock.value;
        return wait === undefined || wait.elapsedMs < SAY_ELAPSED_AFTER_MS ? undefined : formatElapsed(wait.elapsedMs / 1000);
    });
};

/** A status line with that time after it ("Reconnecting… · 1m 5s"); the line alone until then. */
export const useLineWithElapsed = (
    line: MaybeRefOrGetter<string | undefined>,
    startedAt: MaybeRefOrGetter<number | undefined>,
): ComputedRef<string | undefined> => {
    const elapsed = useElapsedWords(startedAt);
    return computed(() => {
        const text = toValue(line);
        return text === undefined || elapsed.value === undefined ? text : `${text} · ${elapsed.value}`;
    });
};
