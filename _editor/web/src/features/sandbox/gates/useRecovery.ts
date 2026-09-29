import { useNow } from "@intentic/ui/async";
import { computed, onScopeDispose, ref, watch, type ComputedRef } from "vue";
import { useSandbox } from "../client/useSandbox";
import { restartExpected } from "../live/sandboxRestart";
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

// Whether the active sandbox's recovery panel is due, for the connecting gate and notification lane.
export const useRecoveryDue = (clock = useVisibleOutage()): ComputedRef<boolean> => {
    const { active, connection, reachable, activeWakeRefused } = useSandbox();
    const { elapsed, freshFailure } = clock;
    return computed(() => {
        const box = active.value;
        return recoveryDue({
            failure: connection.value.failure,
            reachable: reachable.value,
            outageMs: elapsed.value,
            restartExpected: restartExpected(box?.id) !== undefined,
            removed: (box?.removedAt ?? null) !== null,
            refused: activeWakeRefused.value !== undefined,
            hosted: (box?.hosted ?? null) !== null,
            canRollBack: box?.hosted?.canRollBack === true,
            owner: box?.role === `owner`,
        }) && freshFailure.value;
    });
};
