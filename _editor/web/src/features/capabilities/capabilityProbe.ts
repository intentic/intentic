import { t } from "@intentic/ui/i18n";
import type { AddCapabilityInput, CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityProbe } from "@intentic/sandbox-contract/schemas/capabilities";
import { computed, getCurrentScope, onScopeDispose, type Ref } from "vue";
import { useOperation } from "../../workbench/operations/operations";
import type { CapabilityForm } from "./capabilityForm";
import { probeCapability } from "../../models/capabilities/useCapabilities";
import { buildConfig } from "../../models/capabilities/form";

// The form's Test: lets the daemon dial the service the way the connection would (capabilities/probe.ts) and shows its
// own words back. Offered only where a check exists; `checked: false` retires the button rather than claiming failure.
// The dial is the tile's, in the operations ledger, so a reader who leaves mid-test comes back to it still running, or to
// why it could not be made. What it said belongs to the answers it dialled with, so it lands only on the form that
// pressed, while that form still shows the tile.

export interface ProbeHost {
    readonly selected: Readonly<Ref<CapabilityCatalogEntry | undefined>>;
    readonly form: Pick<CapabilityForm, `savedName` | `values` | `keptSecrets` | `probeResult` | `heardWho`>;
}

export const useCapabilityProbe = ({ selected, form }: ProbeHost) => {
    const probe = useOperation<CapabilityProbe>(() => `capabilities/${selected.value?.id ?? ``}/probe`);
    let showing = true;
    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => {
            showing = false;
        });
    }
    const runProbe = async (): Promise<void> => {
        const entry = selected.value;
        if (entry === undefined || probe.busy.value) {
            return;
        }
        form.probeResult.value = undefined;
        const input: AddCapabilityInput = { id: form.savedName.value || entry.id, kind: entry.kind, config: buildConfig(entry, form.values, form.keptSecrets.value) };
        const ended = await probe.run({
            what: t(`capabilities.capabilityProbe.testing`, { name: input.id }),
            failed: t(`capabilities.capabilityProbe.couldNotTest`),
            // What it said is drawn on the form that asked; nothing to tell anywhere else.
            quiet: true,
            task: () => probeCapability(input),
        });
        const said = ended?.state === `done` ? ended.value : undefined;
        if (said === undefined || !showing || selected.value?.id !== entry.id) {
            return;
        }
        form.probeResult.value = said;
        if (said.ok && said.who !== undefined) {
            form.heardWho(entry, said.who);
        }
    };
    return {
        probing: probe.busy,
        failure: probe.failure,
        // How far along the test still running is, for the form's <ProgressMeter>; undefined otherwise.
        meter: probe.meter,
        // Hidden once a tile has answered that no test exists for it.
        canProbe: computed(() => selected.value !== undefined && form.probeResult.value?.checked !== false),
        runProbe,
    };
};
