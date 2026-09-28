import { useNow } from "@intentic/ui/async";
import { computed, type ComputedRef } from "vue";
import { useSandbox } from "../client/useSandbox";
import { restartExpected } from "../live/sandboxRestart";
import { recoveryDue } from "./recovery";

// Whether the active sandbox's recovery panel is due, for the two places that draw it: the connecting gate over a
// workspace that never painted, and the notification lane over one that did. Component-scoped, since the clock it
// reads registers disposal with the caller's Vue scope; it ticks only while the sandbox is out of reach.
export const useRecoveryDue = (): ComputedRef<boolean> => {
    const { active, connection, reachable, activeWakeRefused } = useSandbox();
    const now = useNow(() => !reachable.value && connection.value.unavailableSince !== undefined);
    return computed(() => {
        const since = connection.value.unavailableSince;
        const box = active.value;
        return recoveryDue({
            failure: connection.value.failure,
            reachable: reachable.value,
            outageMs: since === undefined ? 0 : now.value - since,
            restartExpected: restartExpected(box?.id) !== undefined,
            removed: (box?.removedAt ?? null) !== null,
            refused: activeWakeRefused.value !== undefined,
            hosted: (box?.hosted ?? null) !== null,
            canRollBack: box?.hosted?.canRollBack === true,
            owner: box?.role === `owner`,
        });
    });
};
