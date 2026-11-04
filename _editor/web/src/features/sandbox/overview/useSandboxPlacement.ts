import type { SandboxSummary } from "@intentic/api-contract";
import { computed, type ComputedRef } from "vue";
import { placementOf, slugFromDaemonUrl, type SandboxPlacement } from "./placement";
import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { seenOnThisComputer } from "../../../client/endpoint/onThisComputer";
import { useHostRunning } from "../../../models/sandbox/devices/useDevices";
import { useSandbox } from "../../../client/sandbox/useSandbox";

// The active sandbox's placement, with both refinements applied: the fleet's own word on which connected device runs
// this container, and the transport's word on whether this browser reaches it over loopback. Both land after first
// paint, so the mark opens on what this browser remembers (onThisComputer.ts) and sharpens once — never the other way
// round, since neither refinement can ever contradict what the platform row already said.

export function useSandboxPlacement(): ComputedRef<SandboxPlacement | undefined> {
    const { active, daemonUrl } = useSandbox();
    const { usingLocal } = useEndpoint();
    // Shares the Devices query without polling it: this mark is not worth a request every ten seconds.
    const device = useHostRunning(() => slugFromDaemonUrl(daemonUrl.value));
    return computed(() => {
        const sandbox = active.value;
        return sandbox === undefined
            ? undefined
            : placementOf(sandbox, { device: device.value, onThisComputer: usingLocal.value || seenOnThisComputer(sandbox.id) });
    });
}

// Any other row in a list of sandboxes: the platform row, plus this browser's memory of having reached it over
// loopback, so a sandbox on this computer says so whether or not it is the one selected.
export const rowPlacement = (sandbox: Pick<SandboxSummary, "id" | "hosted" | "role" | "daemonUrl">): SandboxPlacement =>
    placementOf(sandbox, { onThisComputer: seenOnThisComputer(sandbox.id) });
