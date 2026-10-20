import { useNow } from "@intentic/ui/async";
import { computed, type ComputedRef, type MaybeRefOrGetter, ref, type Ref, toValue, watch } from "vue";
import { elapsedWords, type Expectation, type Progress, progressAt } from "./progress";

// THE CLOCK BEHIND A PROGRESS READOUT (progress.ts). The work starts at `startedAt` (an operation's own, through
// useOperationProgress in the ledger, or the moment a busy flag turned on, from `useBusySince`) and is read only while
// that is defined. The clock ticks only while the work runs, on the shared one-second clock every live readout uses.

export interface ProgressFacts extends Expectation {
    /** When it ended, for a readout that stays on screen after the work (a stage card's total); the clock stops there. */
    readonly endedAt?: number | undefined;
    /** The work's own count, 0 to 1, where it keeps one. */
    readonly measured?: number | undefined;
}

export const useProgress = (
    startedAt: MaybeRefOrGetter<number | undefined>,
    facts: MaybeRefOrGetter<ProgressFacts> = {},
): ComputedRef<Progress | undefined> => {
    const now = useNow(() => toValue(startedAt) !== undefined && toValue(facts).endedAt === undefined);
    return computed(() => {
        const since = toValue(startedAt);
        return since === undefined ? undefined : progressAt({ ...toValue(facts), startedAt: since }, now.value);
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

/** How long a wait has run ("1m 5s"), once it has outlasted a blip; undefined before then and while none runs. */
export const useElapsedWords = (startedAt: MaybeRefOrGetter<number | undefined>): ComputedRef<string | undefined> => {
    const progress = useProgress(startedAt);
    return computed(() => elapsedWords(progress.value));
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
