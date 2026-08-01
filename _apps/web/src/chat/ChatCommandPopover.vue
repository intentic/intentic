<script setup lang="ts">
import { useListNavigation } from "@intentic-app/ui";
import ComposerPopover from "./ComposerPopover.vue";
import type { AgentCommand } from "@intentic/sandbox-contract";
import { computed } from "vue";

/* The composer's `/` command picker: the provider's own slash commands — an ACP agent's available_commands,
 * or a Claude session's supportedCommands() (its built-ins plus the workspace's .claude/commands and any
 * plugin/skill commands). Same shell as the mention popover — the parent owns the keyboard flow and calls
 * move/pickActive.
 *
 * Rows only, and only when the parent has matches to show. It used to filter the list itself and answer an
 * empty result with "No command matches" — a warning raised over prose, which is the case that needs no
 * warning at all: `/workspace view …` is a sentence, and a box telling the user it names no command reads as
 * an error over text that is about to send perfectly well. The parent owns the match now because it also has
 * to answer the harder question the popover never could — whether the draft will RUN as a command. */

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
            <!-- Meta tier, one step under the body tier its sibling popovers use for a primary: this one is
                 MONO, which at a given size reads wider and heavier than proportional text, so the step down
                 is what makes it optically match the mention/model rows. Same rule as .chat-markdown code.
                 Hierarchy against the hint/description beside it is carried by color, not size. -->
            <span class="shrink-0 font-mono text-2xs text-content">/{{ command.name }}</span>
            <span v-if="command.hint" class="shrink-0 font-mono text-2xs text-subtle">{{ command.hint }}</span>
            <span class="truncate text-2xs text-subtle">{{ command.description }}</span>
        </button>
    </ComposerPopover>
</template>
