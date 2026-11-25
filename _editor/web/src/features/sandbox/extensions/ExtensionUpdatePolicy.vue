<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary, ExtensionUpdatePolicy } from "@intentic/sandbox-contract/schemas/extension-updates";
import { Button, Row, RowGroup, RowNote, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useOperations } from "../../../workbench/operations/operations";
import { drawerScope, extensionBusy, latestFailure } from "./extensionWork";
import { useExtensionUpdates } from "./useExtensionUpdates";
import { useT } from "@intentic/ui/i18n";

// The owner's standing answer for one git-installed extension, one line each: what happens next time its registry lists
// a release, what happens if the registry flags it, and the way back to the version before. The release on offer right
// now leads the page (ExtensionUpdateOffer), not a part of this.

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
    <RowGroup id="extension-updates" :label="t(`sandbox.extensionUpdatePolicy.updates`)">
        <Row :title="t(`sandbox.extensionUpdatePolicy.newReleaseListed`)" :description="policyCaption(policy.updates)" wide-control>
            <template #control>
                <SegmentedControl
                    :model-value="policy.updates"
                    :options="POLICY_OPTIONS"
                    @update:model-value="(value: string) => setPolicy(value as ExtensionUpdatePolicy[`updates`])"
                />
            </template>
        </Row>
        <Row :title="t(`sandbox.extensionUpdatePolicy.offIfFlagged`)" :description="t(`sandbox.extensionUpdatePolicy.offIfFlaggedWhen`)">
            <template #control>
                <!-- Compact, matching the switch at the head of the page: two switch sizes on one page read as two kinds of control. -->
                <ToggleSwitch
                    class="ui-switch-sm shrink-0"
                    :model-value="policy.advisories === `auto-disable`"
                    :disabled="busy"
                    :aria-label="t(`sandbox.extensionUpdatePolicy.offIfFlagged`)"
                    @update:model-value="(value: boolean) => setAdvisories(value)"
                />
            </template>
        </Row>
        <Row
            v-if="previous"
            :title="t(`sandbox.extensionUpdatePolicy.previousVersionKept`)"
            :description="previous.version === undefined ? previous.ref.slice(0, 7) : `v${previous.version} · ${previous.ref.slice(0, 7)}`"
        >
            <template #control>
                <Button
                    size="small"
                    tier="boring"
                    :label="t(`sandbox.extensionUpdatePolicy.revertTo`, { ref: previous.ref.slice(0, 7) })"
                    :disabled="busy"
                    @click="revert"
                >
                    <template #icon><Icon name="undo" /></template>
                </Button>
            </template>
        </Row>
        <RowNote v-if="notice" icon="exclamation-triangle" :tone="notice.tone === `danger` ? `danger` : `warning`">
            {{ notice.title }}<template v-if="notice.detail"> {{ notice.detail }}</template>
        </RowNote>
    </RowGroup>
</template>
