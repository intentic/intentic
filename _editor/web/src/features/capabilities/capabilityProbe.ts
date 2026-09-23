import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, type Ref, ref } from "vue";
import type { CapabilityForm } from "./capabilityForm";
import { probeCapability } from "./connect/useCapabilities";
import { buildConfig } from "./model/form";

// The form's Test: lets the daemon dial the service the way the connection would (capabilities/probe.ts) and shows its
// own words back. Offered only where a check exists; `checked: false` retires the button rather than claiming failure.

export interface ProbeHost {
    readonly selected: Readonly<Ref<CapabilityCatalogEntry | undefined>>;
    readonly form: Pick<CapabilityForm, `savedName` | `values` | `keptSecrets` | `probeResult` | `heardWho`>;
    readonly error: Ref<NoticeModel | null>;
}

export const useCapabilityProbe = ({ selected, form, error }: ProbeHost) => {
    const probing = ref(false);
    const runProbe = async (): Promise<void> => {
        const entry = selected.value;
        if (entry === undefined || probing.value) {
            return;
        }
        probing.value = true;
        form.probeResult.value = undefined;
        try {
            const probe = await probeCapability({
                id: form.savedName.value || entry.id,
                kind: entry.kind,
                config: buildConfig(entry, form.values, form.keptSecrets.value),
            });
            form.probeResult.value = probe;
            if (probe.ok && probe.who !== undefined) {
                form.heardWho(entry, probe.who);
            }
        } catch (caught) {
            error.value = noticeFrom(caught, `Could not test that connection.`);
        } finally {
            probing.value = false;
        }
    };
    return {
        probing,
        // Hidden once a tile has answered that no test exists for it.
        canProbe: computed(() => selected.value !== undefined && form.probeResult.value?.checked !== false),
        runProbe,
    };
};
