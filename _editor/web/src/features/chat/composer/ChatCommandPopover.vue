<script setup lang="ts">
import { useListNavigation } from "@intentic/ui";
import ComposerPopover from "./ComposerPopover.vue";
import type { AgentCommand } from "@intentic/sandbox-contract";
import { computed } from "vue";

// The composer's `/` command picker; rows only, filtering owned by the parent (which also decides
// whether the draft will run as a command). Same shell as the mention popover: the parent owns the
// keyboard flow via move/pickActive.

const props = defineProps<{ commands: readonly AgentCommand[] }>();
const emit = defineEmits<{ pick: [name: string] }>();

const MAX_ROWS = 8;
const matches = computed<readonly AgentCommand[]>(() => props.commands.slice(0, MAX_ROWS));

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(matches, (command) => command.name);

const pickActive = (): boolean => {
    const command = activeRow.value;
    if (command === undefined) {
        return false;
    }
    emit(`pick`, command.name);
    return true;
};

defineExpose({ move, pickActive });
</script>

<template>
    <ComposerPopover icon="bolt" title="Agent commands">
        <button
            v-for="(command, index) in matches"
            :key="command.name"
            :ref="(el) => setRowEl(command.name, el)"
            type="button"
            class="ui-row-select flex w-full items-baseline gap-2 px-3 py-1.5 text-left"
            :class="{ 'ui-row-select-on': index === activeIndex }"
            @mousedown.prevent="emit('pick', command.name)"
        >
            <!--
                One tier below the sibling popovers' primary text, since mono reads wider/heavier at the same size
                (same rule as .chat-markdown code).
            -->
            <span class="shrink-0 font-mono text-2xs text-content">/{{ command.name }}</span>
            <!--
                Capped, not shrunk: argumentHint is unbounded provider text. shrink-0 keeps short hints at natural
                width; max-w only clamps the rare long ones that would crowd out the description.
            -->
            <span v-if="command.hint" class="max-w-[45%] shrink-0 truncate font-mono text-2xs text-subtle">{{ command.hint }}</span>
            <span class="truncate text-2xs text-subtle">{{ command.description }}</span>
        </button>
    </ComposerPopover>
</template>
