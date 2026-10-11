<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary, ExtensionUpdatePolicy } from "@intentic/sandbox-contract";
import { Notice, SegmentedControl, ui } from "@intentic/ui";
import { computed } from "vue";
import { useOperations } from "../../../workbench/operations/operations";
import ExtensionSection from "./ExtensionSection.vue";
import { drawerScope, extensionBusy, latestFailure } from "./extensionWork";
import { useExtensionUpdates } from "./useExtensionUpdates";
import { useT } from "@intentic/ui/i18n";

// The owner's standing answer for one git-installed extension: what happens next time its registry lists a release, what
// happens if the registry flags it, and the way back to the version before. The release on offer right now is the
// drawer's lead (ExtensionUpdateOffer), not a part of this.

const t = useT();

const { extension } = defineProps<{ extension: ExtensionSummary }>();

const { revert: revertUpdate, setUpdatePolicy } = useExtensionUpdates();
// Kept under the extension's id (extensionWork.ts), since this section sits in a drawer that collapsing the row unmounts.
const work = useOperations(() => `${drawerScope(extension.id)}/policy`);
// Anything under way on this extension, here, in the offer above, on the row or from Browse: one at a time.
const busy = computed(() => extensionBusy(extension.id, extensionIdOf(extension.manifest)));
const notice = computed(() => latestFailure(work.all.value));

const failed = (): string => t(`sandbox.extensionUpdatePolicy.didntWork`);

const policy = computed<ExtensionUpdatePolicy>(() => extension.updatePolicy ?? { updates: `notify`, advisories: `auto-disable` });
const policyCaption = (updates: ExtensionUpdatePolicy["updates"]): string => {
    switch (updates) {
        case `notify`:
            return t(`sandbox.extensionUpdatePolicy.policyNotify`);
        case `agent`:
            return t(`sandbox.extensionUpdatePolicy.policyAgent`);
        case `auto`:
            return t(`sandbox.extensionUpdatePolicy.policyAuto`);
    }
};
const POLICY_OPTIONS = computed(() => [
    { label: t(`sandbox.extensionUpdatePolicy.notify`), value: `notify` },
    { label: t(`sandbox.extensionUpdatePolicy.agentPrepared`), value: `agent` },
    { label: t(`sandbox.extensionUpdatePolicy.auto`), value: `auto` },
]);
// The answer shows itself on the controls, so a write raises no receipt of its own.
const save = async (patch: Partial<ExtensionUpdatePolicy>): Promise<void> => {
    if (busy.value) {
        return;
    }
    await work.run(`set`, {
        what: t(`sandbox.extensionUpdatePolicy.saving`, { id: extension.id }),
        quiet: true,
        failed: failed(),
        task: () => setUpdatePolicy(extension.id, patch),
    });
};
const setPolicy = (updates: ExtensionUpdatePolicy["updates"]): Promise<void> => save({ updates });
const setAdvisories = (autoDisable: boolean): Promise<void> => save({ advisories: autoDisable ? `auto-disable` : `notify` });

// The way back, ordinary and visible: "the last update made it worse" needs no failing probe. An unhealthy update
// offers the same revert from the drawer's lead, so it is not said twice.
const previous = computed(() => (extension.health?.state === `unhealthy` ? undefined : extension.previous));
const revert = async (): Promise<void> => {
    if (busy.value) {
        return;
    }
    await work.run(`revert`, {
        what: t(`sandbox.extensionUpdateOffer.reverting`, { id: extension.id }),
        done: () => t(`sandbox.extensionUpdateOffer.reverted`, { id: extension.id }),
        failed: failed(),
        task: () => revertUpdate(extension.id),
    });
};
</script>

<template>
    <ExtensionSection :label="t(`sandbox.extensionUpdatePolicy.updates`)">
        <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-1.5">
                <p class="text-2xs text-muted">{{ t(`sandbox.extensionUpdatePolicy.newReleaseListed`) }}</p>
                <SegmentedControl
                    class="self-start"
                    :model-value="policy.updates"
                    :options="POLICY_OPTIONS"
                    @update:model-value="(value: string) => setPolicy(value as ExtensionUpdatePolicy[`updates`])"
                />
                <p class="text-2xs text-subtle">{{ policyCaption(policy.updates) }}</p>
            </div>

            <label class="flex cursor-pointer items-start gap-2 text-2xs text-muted">
                <input
                    type="checkbox"
                    class="mt-0.5"
                    :checked="policy.advisories === `auto-disable`"
                    :disabled="busy"
                    @change="(event) => setAdvisories((event.target as HTMLInputElement).checked)"
                />
                {{ t(`sandbox.extensionUpdatePolicy.switchOffAutomaticallyRegistry`) }}
            </label>

            <p v-if="previous" class="flex flex-wrap items-center gap-x-2 text-2xs text-subtle">
                <span>
                    {{ t(`sandbox.extensionUpdatePolicy.previousVersionKept`) }}{{ previous.version !== undefined ? ` (v${previous.version})` : `` }}.
                </span>
                <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :disabled="busy" @click="revert">
                    <Icon name="undo" />
                    {{ t(`sandbox.extensionUpdatePolicy.revertTo`, { ref: previous.ref.slice(0, 7) }) }}
                </button>
            </p>

            <Notice v-if="notice" :of="notice" size="sm" />
        </div>
    </ExtensionSection>
</template>
