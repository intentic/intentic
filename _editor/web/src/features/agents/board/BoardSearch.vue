<!-- The board's filter field, in its header (AgentsView). On a slim board (boardGrid.ts `CardFit`) it folds to its glyph,
     since a field squeezed beside the owner filter showed "Filt" and nothing more: pressed, or reached by its command, it
     opens and takes the header's row (`open`, which the header hides its other groups by), and it folds again on leaving
     it with nothing typed. With a query in it, it stays open. -->
<script setup lang="ts">
import { SearchBar, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, useTemplateRef } from "vue";

const { folds, busy = false } = defineProps<{
    // Whether the board is slim enough to fold it.
    folds: boolean;
    busy?: boolean;
    dense: boolean;
    // Where the open field sits in the header row.
    fieldClass: string;
}>();
const emit = defineEmits<{ enter: [event: KeyboardEvent] }>();
const query = defineModel<string>({ required: true });
const matchCase = defineModel<boolean>("matchCase", { required: true });
const open = defineModel<boolean>("open", { default: false });

const t = useT();
const field = useTemplateRef<InstanceType<typeof SearchBar>>(`field`);
const folded = computed(() => folds && !open.value && query.value === ``);
const focus = async (select?: boolean): Promise<void> => {
    open.value = true;
    await nextTick();
    field.value?.focus(select);
};
const leave = (): void => {
    if (query.value === ``) {
        open.value = false;
    }
};
defineExpose({ focus });
</script>

<template>
    <button
        v-if="folded"
        type="button"
        :class="ui.iconButton({}, `shrink-0`)"
        :aria-label="t(`agents.agentsView.filterAgentsByMessages`)"
        v-tooltip.bottom="t(`ui.action.filter`)"
        @click="focus()"
    >
        <Icon name="search" class="text-xs" />
    </button>
    <SearchBar
        v-else
        ref="field"
        v-model="query"
        v-model:match-case="matchCase"
        variant="field"
        :dense="dense"
        clearable
        :busy="busy"
        :aria-label="t(`agents.agentsView.filterAgentsByMessages`)"
        :placeholder="t(`agents.words.filterByMessages`)"
        :class="folds ? 'min-w-0 flex-1' : fieldClass"
        @keydown.enter="(event: KeyboardEvent) => emit(`enter`, event)"
        @focusout="leave"
    />
</template>
