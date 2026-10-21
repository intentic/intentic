import { advance, type Progress, startProgress, tick } from "@intentic/sandbox-run/setup-progress";
import { useNow } from "@intentic/ui/async";
import { computed, type ComputedRef, type MaybeRefOrGetter, ref, toValue, watch } from "vue";
import type { ProgressStep } from "../../../components/progress/stagedSteps";
import { appendedLines, machinePlan, type SetupRunView, setupRunView, stagedPlan } from "./setupRunProgress";

// A RUN'S LINES, AS THEY ARRIVE, FOLDED INTO ITS PROGRESS: each new line once, at the moment it is heard, since the
// engine times a quiet step by when its line came; the clock moves the bar on between lines while the run goes. What
// comes back is what <StagedProgress> takes.

export interface SetupRunSource {
    /** The run's log so far: a window of its last lines, growing at its end. */
    readonly lines: MaybeRefOrGetter<readonly string[]>;
    /** It is running now. */
    readonly running: MaybeRefOrGetter<boolean>;
    /** It ended short. Read once it stops running. */
    readonly failed: MaybeRefOrGetter<boolean>;
}

export interface SetupRunProgress extends SetupRunView {
    readonly steps: readonly ProgressStep[];
    /** When each step was first heard, for the step's own clock. */
    readonly stageAt: Partial<Record<string, number>>;
    readonly startedAt: number;
    readonly endedAt: number | undefined;
}

export const useSetupRunProgress = ({ lines, running, failed }: SetupRunSource): ComputedRef<SetupRunProgress | undefined> => {
    const progress = ref<Progress>();
    const stageAt = ref<Partial<Record<string, number>>>({});
    const endedAt = ref<number>();
    // The log as last folded, to tell its new lines from the ones already read.
    let read: readonly string[] = [];

    // Folds `texts` in, noting when each step was first heard.
    const fold = (from: Progress, texts: readonly string[], now: number): Progress => {
        const next = texts.reduce((state, text) => advance(state, { kind: `line`, text }, now), from);
        const phase = next.plan[next.index]?.phase;
        if (phase !== undefined && stageAt.value[phase] === undefined) {
            stageAt.value = { ...stageAt.value, [phase]: now };
        }
        return next;
    };
    const restart = (texts: readonly string[], now: number): Progress => {
        stageAt.value = {};
        endedAt.value = undefined;
        return fold(startProgress(machinePlan(), now), texts, now);
    };

    watch(
        () => toValue(lines),
        (next) => {
            const now = Date.now();
            const before = progress.value;
            const appended = before === undefined ? undefined : appendedLines(read, next);
            progress.value = before === undefined || appended === undefined ? restart(next, now) : fold(before, appended, now);
            read = next;
        },
        { immediate: true },
    );

    // A press starts the run over: a fresh plan, read from its first line. Its end is the run's own word on how it went.
    watch(
        () => toValue(running),
        (on, was) => {
            const now = Date.now();
            if (on && was === false) {
                read = toValue(lines);
                progress.value = restart(read, now);
            } else if (!on && progress.value !== undefined && progress.value.ended === undefined && read.length > 0) {
                progress.value = advance(progress.value, { kind: `exit`, ok: !toValue(failed) }, now);
                endedAt.value = now;
            }
        },
        { immediate: true },
    );

    const now = useNow(() => toValue(running));
    return computed(() => {
        const state = progress.value;
        if (state === undefined || (!toValue(running) && read.length === 0)) {
            return undefined;
        }
        return {
            ...setupRunView(tick(state, now.value), now.value),
            steps: stagedPlan(state.plan),
            stageAt: stageAt.value,
            startedAt: state.startedAt,
            endedAt: endedAt.value,
        };
    });
};
