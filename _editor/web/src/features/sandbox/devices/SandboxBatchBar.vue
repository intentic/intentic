<script setup lang="ts">
import { Button, Icon, type IconName, VERB_LABEL } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import type { BatchAction, BatchVerb } from "./deviceRows";
import type { DeviceOps } from "./runners/deviceOps";
import type { SandboxSelection } from "./sandboxSelection";
import { useT } from "@intentic/ui/i18n";

// THE SANDBOX LIST'S OWN HEADER: one box that ticks every row the bar can act on, then either how to begin or how many
// are ticked, and on the right the verbs those rows can take — or, while a run works down the list, where it has got.
// Aligned to the rows' own tick-box column, so it reads as the head of that column rather than a toolbar above it.

const t = useT();

const { selection, ops } = defineProps<{ selection: SandboxSelection; ops: DeviceOps }>();

// The row menu's own glyphs (SandboxVerbs), so a verb looks the same in both places.
const ICON: Record<BatchVerb, IconName> = { start: `play`, stop: `stop`, restart: `refresh`, update: `download`, remove: `trash` };

// The count rides the label only when it differs from the selection: "Stop 2" over three ticked rows is the sentence
// "two of these are running", and "Stop 3" over three would only repeat the number beside the box.
const partial = (action: BatchAction): boolean => action.groups.length !== selection.chosen.value.length;
const label = (action: BatchAction): string => (partial(action) ? `${VERB_LABEL[action.verb]} ${action.groups.length}` : VERB_LABEL[action.verb]);
const hint = (action: BatchAction): string | undefined =>
    partial(action) ? t(`sandbox.devicePage.batchPartial`, { count: action.groups.length, total: selection.chosen.value.length }) : undefined;

// Where a run over the list has got: the row it is on, counted from one.
const WORKING: Record<BatchVerb, string> = {
    start: `sandbox.devicePage.batchStarting`,
    stop: `sandbox.devicePage.batchStopping`,
    restart: `sandbox.devicePage.batchRestarting`,
    update: `sandbox.devicePage.batchUpdating`,
    remove: `sandbox.devicePage.batchRemoving`,
};
const progress = computed(() => {
    const run = ops.batchProgress.value;
    return run === undefined ? undefined : t(WORKING[run.verb], { at: Math.min(run.done + 1, run.total), total: run.total });
});
</script>

<template>
    <div class="mb-1 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line-subtle pb-2">
        <span class="flex w-5 shrink-0 items-center justify-center">
            <Checkbox
                :model-value="selection.allPicked.value"
                :indeterminate="selection.chosen.value.length > 0 && !selection.allPicked.value"
                :binary="true"
                size="small"
                :disabled="ops.working.value"
                :aria-label="t(`sandbox.devicePage.selectEverySandbox`)"
                @update:model-value="(on: boolean) => selection.pickAll(on)"
            />
        </span>
        <span class="text-2xs text-muted">{{
            selection.chosen.value.length > 0
                ? t(`sandbox.devicePage.selected`, { count: selection.chosen.value.length })
                : t(`sandbox.devicePage.selectAll`)
        }}</span>
        <div class="ml-auto flex flex-wrap items-center gap-0.5">
            <span v-if="progress" class="flex items-center gap-1.5 px-2 text-2xs text-muted" role="status">
                <Icon name="spinner" spin aria-hidden="true" />{{ progress }}
            </span>
            <template v-else>
                <Button
                    v-for="action in selection.actions.value"
                    :key="action.verb"
                    size="small"
                    :severity="action.verb === `remove` ? `danger` : `secondary`"
                    :text="true"
                    :label="label(action)"
                    :disabled="ops.working.value"
                    v-tooltip.top="hint(action)"
                    @click="selection.run(action)"
                >
                    <template #icon><Icon :name="ICON[action.verb]" /></template>
                </Button>
            </template>
        </div>
    </div>
</template>
