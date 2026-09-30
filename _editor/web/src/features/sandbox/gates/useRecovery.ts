import { useNow } from "@intentic/ui/async";
import { computed, onScopeDispose, ref, watch, type ComputedRef } from "vue";
import { useSandbox } from "../client/useSandbox";
import { restartExpected } from "../live/sandboxRestart";
import { useDiagnosis } from "../diagnosis/useDiagnosis";
import { type DiagnosisNotice, presentDiagnosis } from "../diagnosis/presentation";
import { recoveryDue } from "./recovery";

// The gate and the recovery card read the same visible outage time. A frozen page may wake minutes later but has
// spent none of those minutes waiting for a reconnect. Component-scoped so its listener leaves with the view.
export const useVisibleOutage = (): { elapsed: ComputedRef<number>; hidden: ComputedRef<number>; freshFailure: ComputedRef<boolean> } => {
    const { connection, reachable } = useSandbox();
    const visible = ref(document.visibilityState !== `hidden`);
    const hiddenMs = ref(0);
    const needsVisibleFailure = ref(!visible.value);
    let hiddenAt: number | undefined = visible.value ? undefined : Date.now();
    let failureAtWake = connection.value.failure;
    const visibilityChanged = (): void => {
        visible.value = document.visibilityState !== `hidden`;
        if (!visible.value) {
            hiddenAt = Date.now();
        } else {
            if (hiddenAt !== undefined && connection.value.unavailableSince !== undefined) {
                hiddenMs.value += Date.now() - Math.max(hiddenAt, connection.value.unavailableSince);
            }
            hiddenAt = undefined;
            failureAtWake = connection.value.failure;
            needsVisibleFailure.value = true;
        }
    };
    document.addEventListener(`visibilitychange`, visibilityChanged);
    onScopeDispose(() => document.removeEventListener(`visibilitychange`, visibilityChanged));
    // A new outage (or its end) starts the count again.
    watch(
        () => connection.value.unavailableSince,
        () => {
            hiddenMs.value = 0;
            hiddenAt = visible.value ? undefined : Date.now();
            needsVisibleFailure.value = !visible.value;
        },
    );
    // Every failed attempt replaces the failure, so a new one seen while visible is a reconnect that failed after wake.
    watch(
        () => connection.value.failure,
        (failure) => {
            if (visible.value && failure !== undefined && failure !== failureAtWake) {
                needsVisibleFailure.value = false;
            }
        },
    );
    const now = useNow(() => visible.value && !reachable.value && connection.value.unavailableSince !== undefined);
    return {
        elapsed: computed(() => {
            const since = connection.value.unavailableSince;
            return since === undefined ? 0 : Math.max(0, now.value - since - hiddenMs.value);
        }),
        // The part of the current outage the page spent hidden, for a reading that keeps its own clock.
        hidden: computed(() => hiddenMs.value),
        freshFailure: computed(() => !needsVisibleFailure.value),
    };
};

// What the diagnosis of the active sandbox's outage says, in words (diagnosis/presentation.ts); undefined while it
// answers, or while what is wrong is not a silence.
export const useDiagnosisNotice = (clock: { readonly elapsed: ComputedRef<number> }): ComputedRef<DiagnosisNotice | undefined> => {
    const { active } = useSandbox();
    const diagnosis = useDiagnosis(clock);
    return computed(() => {
        const box = active.value;
        const current = diagnosis.value;
        if (box === undefined || current === undefined) {
            return undefined;
        }
        return presentDiagnosis({
            diagnosis: current,
            name: box.name,
            lane: box.hosted === null ? `own` : `hosted`,
            owner: box.role === `owner`,
            canRollBack: box.hosted?.canRollBack === true,
        });
    });
};

// Whether the active sandbox's recovery panel is due, for the connecting gate and notification lane.
export const useRecoveryDue = (clock = useVisibleOutage(), notice = useDiagnosisNotice(clock)): ComputedRef<boolean> => {
    const { active, reachable, activeWakeRefused } = useSandbox();
    const { elapsed, freshFailure } = clock;
    return computed(() => {
        const box = active.value;
        return recoveryDue({
            reachable: reachable.value,
            outageMs: elapsed.value,
            restartExpected: restartExpected(box?.id) !== undefined,
            removed: (box?.removedAt ?? null) !== null,
            refused: activeWakeRefused.value !== undefined,
            owner: box?.role === `owner`,
            notice: notice.value,
        }) && freshFailure.value;
    });
};
