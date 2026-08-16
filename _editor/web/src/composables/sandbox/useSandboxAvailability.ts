import { useNow } from "@intentic/ui/async";
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from "vue";
import { isBlocked } from "./connection";
import { sandboxAvailability, type SandboxAvailability } from "./availability";
import { useSandbox } from "./useSandbox";
import { daemonReady } from "./useDaemonBoot";

/* Component-scoped because useNow registers disposal with the caller's Vue scope. The shared clock underneath
 * still means ten consumers cost one interval. `established` may include a restored query snapshot: after a
 * reload, cached workspace data earns the same stale-while-revalidate behavior as a frame seen this session. */
export const useSandboxAvailability = (established?: MaybeRefOrGetter<boolean>): ComputedRef<SandboxAvailability> => {
    const { connection } = useSandbox();
    const hasEstablishedView = computed(() => connection.value.everOnline || (established !== undefined && toValue(established)));
    const timing = computed(
        () =>
            hasEstablishedView.value &&
            connection.value.phase !== "online" &&
            connection.value.failure !== undefined &&
            !isBlocked(connection.value.failure),
    );
    const now = useNow(timing);
    return computed(() => sandboxAvailability(connection.value, daemonReady.value, hasEstablishedView.value, now.value));
};
