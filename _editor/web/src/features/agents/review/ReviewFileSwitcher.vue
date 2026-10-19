<script setup lang="ts">
import { SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { ReviewFilter } from "./reviewRoom";
import type { AgentReviewFile } from "./useAgentChanges";

// A narrow review's file list, folded into one row over the diff (reviewRoom.ts): the filter when there is one to pick,
// which file is open, and the review's totals in the default slot. A native select, so the platform's own picker and
// its keyboard and screen-reader handling come with it.

const t = useT();

const filter = defineModel<ReviewFilter>(`filter`, { required: true });
const props = defineProps<{
    filters: readonly { label: string; value: ReviewFilter }[];
    rows: readonly AgentReviewFile[];
    selected: string | undefined;
    viewed: ReadonlySet<string>;
}>();
const emit = defineEmits<{ pick: [file: AgentReviewFile] }>();
const pick = (event: Event): void => {
    const target = event.target;
    const file = target instanceof HTMLSelectElement ? props.rows.find((row) => row.key === target.value) : undefined;
    if (file !== undefined) {
        emit(`pick`, file);
    }
};
</script>

<template>
    <div class="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-line px-2 py-1">
        <div v-if="filters.length > 1" class="flex max-w-full items-center overflow-x-auto [scrollbar-width:none]">
            <SegmentedControl v-model="filter" :options="filters" size="xs" />
        </div>
        <select
            :value="selected"
            :aria-label="t(`agents.agentReviewPanel.pickFile`)"
            :class="ui.input({ size: `sm` }, `min-w-0 flex-1 basis-40`)"
            @change="pick"
        >
            <option v-for="file in rows" :key="file.key" :value="file.key">
                {{ viewed.has(file.key) ? t(`agents.agentReviewPanel.reviewedOption`, { label: file.label }) : file.label }}
            </option>
        </select>
        <span class="ml-auto inline-flex shrink-0 items-center gap-1.5"><slot /></span>
    </div>
</template>
