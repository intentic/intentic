import type { CapabilitySummary, PanelSummary } from "@intentic-app/api-contract";
import { computed, type ComputedRef } from "vue";
import { useCapabilities } from "../extensions/useCapabilities";
import { usePanels } from "../extensions/usePanels";

/* Live things in the sandbox, split by class: operator-panel dev servers that are up (with their assigned
 * port + preview) and service-type capabilities reporting active. Panels are not capabilities, so this is the
 * only at-a-glance view spanning both. Shared by the Status tab (full lists) and the Overview at-a-glance
 * (count + deep-link).
 *
 * VPNs are deliberately NOT counted here: a tunnel has its own card (useVpn / VpnCard) with the state and
 * controls it needs, and counting it in both places would double-report the same thing. */

export const useRunning = (): {
    runningPanels: ComputedRef<PanelSummary[]>;
    activeServices: ComputedRef<CapabilitySummary[]>;
    runningCount: ComputedRef<number>;
} => {
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    const runningPanels = computed(() => panels.value.filter((panel) => panel.running));
    const activeServices = computed(() =>
        capabilities.value.filter(
            (capability) => [`service`, `docker`, `ssh`].includes(capability.kind) && capability.status.state === `active`,
        ),
    );
    const runningCount = computed(() => runningPanels.value.length + activeServices.value.length);
    return { runningPanels, activeServices, runningCount };
};
