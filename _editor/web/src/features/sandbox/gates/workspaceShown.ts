import { computed, type ComputedRef } from "vue";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { daemonTooOld } from "../../../client/sandbox/daemon/useDaemonVersion";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { sandboxRequiresGate } from "../overview/availability";
import { useSandboxAvailability } from "../overview/useSandboxAvailability";
import { useSandboxEstablished } from "./established";

// WHETHER THE WORKSPACE IS ON SCREEN rather than one of SandboxGate's pages in front of it (denied, too old, warming,
// connecting): connected, its workspace painted, nothing gating it. Read by the gate itself, which tells the desktop app
// so, and by the Add sandbox dialog, which stays up over a new sandbox until this holds, so nobody is shown the gates a
// sandbox passes through on its first start (features/setup/add/AddSandboxDialog.vue).

export interface SandboxGateState {
    readonly denied: ComputedRef<boolean>;
    readonly gated: ComputedRef<boolean>;
    readonly availability: ReturnType<typeof useSandboxAvailability>;
    /** The sandbox whose workspace is shown, or undefined while a gate stands in front of it. */
    readonly shown: ComputedRef<string | undefined>;
}

export const useSandboxGateState = (): SandboxGateState => {
    const { reachable, connection } = useSandbox();
    // A 403 (daemon refused this account) reads off the failure's tag rather than a separate sticky boolean.
    const denied = computed(() => connection.value.failure?.kind === `forbidden`);
    // A hydrated tree marks the sandbox as previously visited: painted stale-while-revalidate, not gated. So does a roster
    // restored from the last visit, which is what a phone's board draws (established.ts).
    const established = useSandboxEstablished();
    const availability = useSandboxAvailability(established);
    const gated = computed(() => sandboxRequiresGate(reachable.value, established.value, availability.value));
    const shown = computed(() =>
        !denied.value && !daemonTooOld.value && !gated.value && reachable.value && established.value ? activeSandboxId.value : undefined,
    );
    return { denied, gated, availability, shown };
};
