<script setup lang="ts">
import { Button, Icon, type IconName, type Tip, VERB_LABEL } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import type { BatchAction, BatchVerb } from "../deviceRows";
import type { DeviceOps } from "../runners/deviceOps";
import type { SandboxSelection } from "./sandboxSelection";
import { useT } from "@intentic/ui/i18n";

// THE SANDBOX LIST'S OWN HEADER: one box that ticks every row the bar can act on, then either how to begin or how many
// are ticked, and on the right the verbs those rows can take — or, while a run works down the list, where it has got.
// Aligned to the rows' own tick-box column, so it reads as the head of that column rather than a toolbar above it.

const t = useT();

const { selection, ops } = defineProps<{ selection: SandboxSelection; ops: DeviceOps }>();
// Leaving selection: the page drops the ticks and the tick boxes with it.
const emit = defineEmits<{ cancel: [] }>();

// The row menu's own glyphs (SandboxVerbs), so a verb looks the same in both places.
const ICON = { start: `play`, stop: `stop`, restart: `refresh`, update: `download`, remove: `trash` } as const satisfies Record<BatchVerb, IconName>;

// The count rides the label only when it differs from the selection: "Stop 2" over three ticked rows is the sentence
// "two of these are running", and "Stop 3" over three would only repeat the number beside the box.
const partial = (action: BatchAction): boolean => action.groups.length !== selection.chosen.value.length;
const label = (action: BatchAction): string => (partial(action) ? `${VERB_LABEL[action.verb]} ${action.groups.length}` : VERB_LABEL[action.verb]);
const hint = (action: BatchAction): Tip | undefined =>
    partial(action)
        ? {
              title: t(`sandbox.devicePage.partialRun`),
              rows: [
                  { label: t(`sandbox.devicePage.actsOn`), value: action.groups.length },
                  { label: t(`sandbox.devicePage.leftAsIs`), value: selection.chosen.value.length - action.groups.length },
              ],
          }
        : undefined;

// Where a run over the list has got: the row it is on, counted from one.
const WORKING = {
    start: (at: number, total: number) => t(`sandbox.devicePage.batchStarting`, { at, total }),
    stop: (at: number, total: number) => t(`sandbox.devicePage.batchStopping`, { at, total }),
    restart: (at: number, total: number) => t(`sandbox.devicePage.batchRestarting`, { at, total }),
    update: (at: number, total: number) => t(`sandbox.devicePage.batchUpdating`, { at, total }),
    remove: (at: number, total: number) => t(`sandbox.devicePage.batchRemoving`, { at, total }),
} satisfies Record<BatchVerb, (at: number, total: number) => string>;
const progress = computed(() => {
    const run = ops.batchProgress.value;
    return run === undefined ? undefined : WORKING[run.verb](Math.min(run.done + 1, run.total), run.total);
});
</script>

<template>
    <div class="mb-1 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line-subtle pb-2">
        <!-- The words are the box's own label, so pressing "Select all" ticks it as pressing the box does: they sat
             beside it as plain text, and a click on them did nothing. -->
        <label
            class="group/all flex min-w-0 select-none items-center gap-2"
            :class="ops.working.value ? `cursor-default` : `cursor-pointer`"
        >
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
            <span class="text-xs text-muted transition-colors group-hover/all:text-content">{{
                selection.chosen.value.length > 0
                    ? t(`sandbox.devicePage.selected`, { count: selection.chosen.value.length })
                    : t(`sandbox.devicePage.selectAll`)
            }}</span>
        </label>
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
                <Button
                    size="small"
                    severity="secondary"
                    :text="true"
                    :label="t(`ui.action.cancel`)"
                    :disabled="ops.working.value"
                    @click="emit(`cancel`)"
                />
            </template>
        </div>
    </div>
</template>
