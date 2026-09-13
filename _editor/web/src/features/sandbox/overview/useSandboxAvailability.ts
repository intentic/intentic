import { useNow } from "@intentic/ui/async";
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from "vue";
import { isBlocked } from "../live/connection";
import { sandboxAvailability, type SandboxAvailability } from "./availability";
import { useSandbox } from "../client/useSandbox";
import { daemonReady } from "./useDaemonBoot";

/* Component-scoped because useNow registers disposal with the caller's Vue scope. The shared clock underneath
 * still means ten consumers cost one interval. `established` may include a restored query snapshot: after a
 * reload, cached workspace data earns the same stale-while-revalidate behavior as a frame seen this session. */
export const useSandboxAvailability = (established?: MaybeRefOrGetter<boolean>): ComputedRef<SandboxAvailability> => {
    const { active, connection } = useSandbox();
    const hasEstablishedView = computed(() => connection.value.everOnline || (established !== undefined && toValue(established)));
    // The clock also runs for a first connect that hasn't established: `detached` is a state a sandbox reaches by
    // elapsing, and a box that never painted is exactly the one that used to spin forever.
    const timing = computed(
        () => connection.value.phase !== "online" && connection.value.failure !== undefined && !isBlocked(connection.value.failure),
    );
    const now = useNow(timing);
    // The removal the machine reported; a platform fact, not a transport one, so it arrives beside the connection.
    const removed = computed(() => (active.value?.removedAt ?? null) !== null);
    return computed(() => sandboxAvailability(connection.value, daemonReady.value, hasEstablishedView.value, now.value, removed.value));
};
